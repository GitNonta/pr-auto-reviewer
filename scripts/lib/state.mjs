import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ห่อ execFile เพื่อเรียก git แบบ async
const execFileAsync = promisify(execFile);

// เก็บประวัติ assignment ย้อนหลังได้สูงสุด 50 รายการ (กันไฟล์ state โตไม่มีที่สิ้นสุด)
const HISTORY_LIMIT = 50;

/** อ่าน state (cursor + ประวัติ assignment) ถ้าไฟล์ยังไม่มีให้เริ่มจากคิวตำแหน่งแรก */
export async function readState(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (err) {
    // ครั้งแรกที่ยังไม่มีไฟล์ state ถือว่าเริ่มคิวที่ 0 และยังไม่มีประวัติ
    if (err.code === 'ENOENT') return { cursor: 0, assignments: [] };
    throw err;
  }

  const parsed = JSON.parse(raw);
  // ถ้าค่าในไฟล์ผิดรูปแบบให้ fallback เป็นค่าเริ่มต้นที่ปลอดภัย
  return {
    cursor: Number.isInteger(parsed.cursor) && parsed.cursor >= 0 ? parsed.cursor : 0,
    assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
  };
}

/** เขียน state ลงไฟล์ (สร้างโฟลเดอร์ให้ถ้ายังไม่มี) */
export async function writeState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** สร้าง state ใหม่: ต่อ assignment ล่าสุดเข้าไปแล้วตัดให้เหลือ HISTORY_LIMIT รายการ */
export function nextState({ state, selected, nextCursor, pullNumber, author, mode, now = new Date() }) {
  const assignments = [
    ...state.assignments,
    {
      pull_request: pullNumber,
      author,
      reviewers: selected,
      mode,
      at: now.toISOString(),
    },
  ].slice(-HISTORY_LIMIT);

  return { cursor: nextCursor, assignments };
}

// เรียก git พร้อม cwd และ buffer เผื่อไว้สำหรับ output ที่ยาว
async function git(args, cwd) {
  return execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

/**
 * commit ไฟล์ state ที่เปลี่ยนบน default branch แล้ว push กลับเข้า repository
 * ถ้า push ไม่สำเร็จจะรายงานผลแต่ไม่ throw: PR check ต้องเขียวไว้ก่อน
 * (เช่น workflow token เป็น read-only หรือ PR มาจาก fork)
 */
export async function commitAndPushState({ statePath, branch, pullNumber, cwd = process.cwd() }) {
  // แปลง path เต็มเป็น path แบบ relative กับ cwd เพื่อใช้กับ git
  const relative = resolve(cwd, statePath).slice(cwd.length + 1);
  const status = await git(['status', '--porcelain', '--', relative], cwd);
  // ไม่มีไฟล์เปลี่ยน -> ไม่ต้อง commit/push
  if (status.stdout.trim() === '') return { committed: false, pushed: false };

  // ตั้งตัวตนของ bot สำหรับ commit ที่ workflow สร้าง
  await git(['config', 'user.name', 'github-actions[bot]'], cwd);
  await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], cwd);
  await git(['add', '--', relative], cwd);
  await git(['commit', '-m', `chore(reviewer): update assignment state for PR #${pullNumber} [skip ci]`], cwd);

  // ลอง push สูงสุด 3 ครั้ง ถ้าชนกับ commit อื่นให้ rebase แล้วลองใหม่
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await git(['push', 'origin', `HEAD:${branch}`], cwd);
      return { committed: true, pushed: true, attempt };
    } catch (err) {
      lastError = err;
      // ก่อนลองใหม่ ให้ดึง commit ล่าสุดจาก remote มาทับ (autostash กันไฟล์ state หาย)
      if (attempt < 3) {
        await git(['pull', '--rebase', '--autostash', 'origin', branch], cwd).catch(() => {});
      }
    }
  }

  return {
    committed: true,
    pushed: false,
    error: (lastError && (lastError.stderr || lastError.message)) || 'git push failed',
  };
}
