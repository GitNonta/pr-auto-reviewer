#!/usr/bin/env node
/**
 * จุดเริ่มต้นที่ .github/workflows/auto-assign-reviewer.yml เรียกใช้
 *
 * ลำดับการทำงาน:
 * 1) อ่าน config + state
 * 2) เก็บข้อมูลประกอบจาก GitHub: ไฟล์ที่เปลี่ยน, label ของ PR, งานรีวิวที่ค้างอยู่
 *    (ถ้าดึงไม่ได้จะเตือนแล้วเดินต่อด้วยข้อมูลเท่าที่มี = fallback)
 * 3) ให้คะแนนผู้มีสิทธิ์แบบ hybrid (fit/fairness/load) แล้วให้ round-robin
 *    ตัดสินเมื่อเสมอ โดยตัดผู้เปิด PR ออกเสมอ
 * 4) request review (หรือคอมเมนต์แท็กเป็นวิธีสำรอง) -> บันทึก cursor กลับเข้า git
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { loadConfig, DEFAULT_CONFIG_PATH } from './lib/config.mjs';
import { collectTeams, parseCodeowners } from './lib/codeowners.mjs';
import { ConfigError, MAX_SCORE, selectReviewers } from './lib/round-robin.mjs';
import { createGitHubClient, GitHubError } from './lib/github.mjs';
import { readState, writeState, nextState, commitAndPushState } from './lib/state.mjs';

/**
 * อ่านไฟล์ CODEOWNERS จาก checkout (workflow checkout default branch อยู่แล้ว)
 * หาได้ทั้ง .github/CODEOWNERS, CODEOWNERS และ docs/CODEOWNERS ตามลำดับ
 * คืน null ถ้าไม่มีไฟล์เลย ( scorer จะ fallback ไปใช้ owns ใน config)
 */
export async function readCodeowners(cwd, preferredPath = null) {
  const candidates = preferredPath ? [preferredPath] : ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
  for (const candidate of candidates) {
    try {
      return await readFile(path.join(cwd, candidate), 'utf8');
    } catch (err) {
      // ไม่มีไฟล์นี้ -> ลอง path ถัดไป
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return null;
}

/**
 * ขยายเจ้าของแบบทีม (@org/team) เป็นรายชื่อสมาชิกผ่าน Teams API
 * - ทีมที่อ่านไม่ได้ (เช่น token ไม่มีสิทธิ์ org) จะ warn แล้วข้าม
 * - ไฟล์ของทีมนั้นจะยังนับให้เจ้าของที่เป็นรายบุคคล (ถ้ามี) และ scorer
 *   จะ fallback ไป `owns` ใน config เมื่อไม่มีข้อมูลเจ้าของเลย
 */
async function resolveTeamMembers({ client, codeowners, warn }) {
  const rules = parseCodeowners(codeowners);
  const teams = [...collectTeams(rules)];
  const members = {};

  for (const team of teams) {
    const [org, slug] = team.split('/');
    if (!org || !slug) continue;
    try {
      const list = await client.listTeamMembers(org, slug);
      if (Array.isArray(list)) {
        members[team] = list
          .map((user) => (typeof user === 'string' ? user : user && user.login))
          .filter((login) => typeof login === 'string' && login.trim() !== '');
      }
    } catch (err) {
      warn(`[auto-reviewer] could not expand team @${team} (${err.message}); ownership falls back.`);
    }
  }

  return members;
}

/**
 * ดึงข้อมูลประกอบของ PR แบบ "ไม่ทำให้ job ล้ม":
 * - ไฟล์ที่เปลี่ยน (ใช้คิด fit)
 * - label ของ PR (ใช้คิด fit)
 * - จำนวนงานรีวิวที่ค้างอยู่ต่อคน (ใช้คิด load)
 * ถ้าส่วนใดล้มเหลวจะเตือนและคืนค่าว่างของส่วนนั้น (fallback)
 */
async function collectPullContext({ client, repository, pullNumber, warn }) {
  const context = { files: [], labels: [], pending: {} };

  try {
    const files = await client.getPullFiles(repository, pullNumber);
    if (Array.isArray(files)) {
      context.files = files.map((file) => file && file.filename).filter((name) => typeof name === 'string');
    }
  } catch (err) {
    warn(`[auto-reviewer] could not load changed files (${err.message}); fit score will be skipped.`);
  }

  try {
    const pull = await client.getPull(repository, pullNumber);
    if (pull && Array.isArray(pull.labels)) {
      context.labels = pull.labels.map((label) => label && label.name).filter((name) => typeof name === 'string');
    }
  } catch (err) {
    warn(`[auto-reviewer] could not load PR labels (${err.message}); fit score will be skipped.`);
  }

  try {
    const openPulls = await client.listOpenPulls(repository);
    if (Array.isArray(openPulls)) {
      for (const pull of openPulls) {
        // ข้าม PR ใบปัจจุบัน (ยังไม่มีการ request reviewer อยู่แล้ว)
        if (!pull || Number(pull.number) === pullNumber) continue;
        const reviewers = Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers : [];
        for (const reviewer of reviewers) {
          const login = typeof reviewer === 'string' ? reviewer : reviewer && reviewer.login;
          if (typeof login !== 'string' || login === '') continue;
          const key = login.toLowerCase();
          context.pending[key] = (context.pending[key] ?? 0) + 1;
        }
      }
    }
  } catch (err) {
    warn(`[auto-reviewer] could not load pending review requests (${err.message}); load uses history only.`);
  }

  return context;
}

/**
 * สร้างคอมเมนต์แท็ก reviewer ใช้เมื่อ request review ผ่าน API ไม่ได้
 * (เช่น บัญชีที่เลือกยังไม่ได้เป็น collaborator ของ repository)
 */
function buildTagComment({ selected, author, error, reasons = {} }) {
  const mentions = selected.map((login) => `@${login}`).join(' ');
  return [
    '## 🤖 Auto-assigned reviewer (hybrid score)',
    '',
    `${mentions} — PR นี้ถึงคิวของคุณแล้ว (จัดคิวด้วย Hybrid scoring + Round-Robin tie-breaker)`,
    '',
    '### ทำไมเลือก reviewer คนนี้',
    '',
    ...selected.map((login) => `- **@${login}** — ${reasons[login] || 'ไม่มีข้อมูลเหตุผล'}`),
    '',
    `ผู้เปิด PR (\`${author}\`) จะไม่ถูกเลือกเป็น Reviewer ของตัวเอง`,
    '',
    '<details><summary>ทำไมต้องแท็กแทนการ request review</summary>',
    '',
    '```',
    error,
    '```',
    '',
    '> GitHub อนุญาตให้ request review เฉพาะ collaborator ของ repository เท่านั้น',
    '> เมื่อเพิ่มบัญชีนี้เป็น collaborator แล้ว ระบบจะ assign ผ่าน reviewer slot ปกติในรอบถัดไป',
    '</details>',
  ].join('\n');
}

/**
 * ทำงานหลักของ action (แยกออกมาเป็นฟังก์ชันเพื่อให้ test เรียกใช้ได้)
 * - env: ตัวแปรสภาพแวดล้อม (ค่าเริ่มต้นคือ process.env)
 * - cwd: โฟลเดอร์ฐานสำหรับ resolve path ของ config/state
 * - api: ใส่ client จำลองได้ใน test (ถ้าไม่ใส่จะสร้าง client จริงจาก GITHUB_TOKEN)
 */
export async function run({ env = process.env, cwd = process.cwd(), api = null, log = console.log, warn = console.warn } = {}) {
  // ค่าที่ workflow ส่งเข้ามา: repository, หมายเลข PR และผู้เปิด PR
  const repository = env.GITHUB_REPOSITORY;
  const pullNumber = Number(env.PR_NUMBER);
  const author = env.PR_AUTHOR || '';

  // ต้องมี repository และหมายเลข PR ที่ถูกต้องเท่านั้นจึงจะทำงานต่อได้
  if (!repository || !Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('GITHUB_REPOSITORY and a numeric PR_NUMBER are required');
  }

  // อ่าน config (รายชื่อ reviewer ในคิว + ความถนัด) และ state (cursor + ประวัติ)
  const configPath = path.resolve(cwd, env.CONFIG_PATH || DEFAULT_CONFIG_PATH);
  const config = await loadConfig(configPath);
  const statePath = path.resolve(cwd, config.statePath);
  const state = await readState(statePath);

  // อ่าน CODEOWNERS เพื่อคิดคะแนน ownership (ไม่มีไฟล์ก็ไม่เป็นไร = fallback)
  let codeowners = null;
  try {
    codeowners = await readCodeowners(cwd, config.codeownersPath);
  } catch (err) {
    warn(`[auto-reviewer] could not read CODEOWNERS (${err.message}); ownership uses config owns.`);
  }

  // ระบบสำรองชั้นแรก: เหลือแต่ผู้เปิด PR -> ไม่ต้องเรียก API เพิ่มเลย
  const eligible = config.reviewers.filter((login) => login.toLowerCase() !== author.trim().toLowerCase());
  if (eligible.length === 0) {
    warn(
      `[auto-reviewer] PR #${pullNumber}: no eligible reviewer (every candidate is the PR author "${author}"); nothing to assign.`,
    );
    return { selected: [], nextCursor: state.cursor, mode: 'skipped' };
  }

  // สร้าง GitHub client จริงเมื่อไม่ได้ส่ง client จำลองเข้ามา (ใช้ใน test)
  const client =
    api ??
    createGitHubClient({
      // TEAMS_TOKEN (ถ้ามี) ใช้เมื่อต้องอ่านสมาชิกทีมใน organization; ไม่มีก็ใช้ GITHUB_TOKEN
      token: env.TEAMS_TOKEN || env.GITHUB_TOKEN,
      baseUrl: env.GITHUB_API_BASE_URL || 'https://api.github.com',
    });

  // ขยายเจ้าของที่เป็นทีมก่อนคิดคะแนน ownership (ล้มเหลวได้ ไม่ทำให้ job ล้ม)
  const teamMembers = codeowners ? await resolveTeamMembers({ client, codeowners, warn }) : {};

  // ข้อมูลประกอบสำหรับคะแนน fit/load (ล้มเหลวบางส่วนได้ ไม่ทำให้ job ล้ม)
  const context = await collectPullContext({ client, repository, pullNumber, warn });

  // เลือก reviewer: fit จากไฟล์/label + fairness/load จากประวัติ/งานค้าง
  // ตัดผู้เปิด PR ออกเสมอ และใช้คิว round-robin ตัดสินเมื่อคะแนนเสมอกัน
  const { selected, nextCursor, scored } = selectReviewers({
    reviewers: config.reviewers,
    cursor: state.cursor,
    count: config.count,
    exclude: [author],
    history: state.assignments,
    profiles: config.profiles,
    changes: context,
    pending: context.pending,
    codeowners,
    teamMembers,
  });

  // ระบบสำรองชั้นสอง: ไม่เหลือใครให้เลือก -> ข้ามและไม่เลื่อน cursor
  if (selected.length === 0) {
    warn(`[auto-reviewer] PR #${pullNumber}: no eligible reviewer after exclusions; nothing to assign.`);
    return { selected: [], nextCursor: state.cursor, mode: 'skipped' };
  }

  const reasons = Object.fromEntries(
    scored.filter((item) => item.reasons).map((item) => [item.login, item.summary]),
  );

  // แสดงคะแนนและเหตุผลของผู้ที่ถูกเลือกเพื่อให้ตรวจย้อนหลังได้
  const primary = scored.find((item) => item.login === selected[0]);
  log(
    `[auto-reviewer] PR #${pullNumber} by "${author}": hybrid pick [${selected.join(', ')}]` +
      (primary
        ? ` (score ${primary.score}/${MAX_SCORE}: skill ${primary.skill}, ownership ${primary.ownership}, workload ${primary.workload}, recency ${primary.recency})`
        : '') +
      ` (cursor ${state.cursor} -> ${nextCursor})`,
  );
  for (const login of selected) {
    if (reasons[login]) log(`[auto-reviewer] why ${login}: ${reasons[login]}`);
  }

  let mode = 'requested';

  try {
    // วิธีหลัก: request review ผ่าน reviewer slot ของ GitHub
    await client.requestReviewers(repository, pullNumber, selected);
    log(`[auto-reviewer] requested review from [${selected.join(', ')}]`);
  } catch (err) {
    // ข้อผิดพลาดที่ไม่ใช่จาก GitHub API ให้โยนต่อทันที
    if (!(err instanceof GitHubError)) throw err;
    // ถ้าปิด tag_fallback ไว้ก็ให้ล้มเหลวตามปกติ
    if (!config.tagFallback) throw err;

    // วิธีสำรอง: แท็ก reviewer ในคอมเมนต์ของ PR แทน
    mode = 'tagged';
    warn(`[auto-reviewer] ${err.message}`);
    warn('[auto-reviewer] falling back to tagging the reviewer in a PR comment.');

    await client.comment(
      repository,
      pullNumber,
      buildTagComment({ selected, author, error: err.message, reasons }),
    );
  }

  // อัปเดต state: เก็บ assignment ล่าสุดและ cursor ใหม่ แล้วเขียนลงไฟล์
  const updated = nextState({
    state,
    selected,
    nextCursor,
    pullNumber,
    author,
    mode,
  });
  await writeState(statePath, updated);

  // เมื่อรันบน GitHub Actions ให้ commit + push ไฟล์ state กลับเข้า default branch
  if (env.GITHUB_ACTIONS === 'true') {
    const result = await commitAndPushState({
      statePath,
      branch: env.DEFAULT_BRANCH || 'main',
      pullNumber,
      cwd,
    });
    // push ไม่สำเร็จไม่ทำให้ job แดง (เช่น token เป็น read-only) แต่ต้องเตือนใน log
    if (!result.pushed) {
      warn(`[auto-reviewer] state update was not pushed: ${result.error || 'nothing to push'}`);
    }
  }

  return { selected, nextCursor, mode };
}

// ตรวจว่าถูกเรียกโดยตรงจาก command line (ไม่ใช่ถูก import ใน test)
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      // แยกข้อความ error ของ config ออกจาก error ทั่วไปให้อ่านง่าย
      const prefix = err instanceof ConfigError ? 'config error' : 'error';
      console.error(`[auto-reviewer] ${prefix}: ${err.message}`);
      process.exit(1);
    });
}
