/**
 * การเลือก reviewer — ไม่มี I/O ไม่เรียก GitHub และให้ผลลัพธ์แน่นอน
 * (อินพุตเดิม + state เดิม -> ผลลัพธ์เดิมเสมอ)
 *
 * รูปแบบ: Hybrid scoring 100 คะแนน + Round-Robin tie-breaker
 *
 *   Skill     40 : ความถนัดตรงกับไฟล์/label ที่เปลี่ยน (config `paths`/`labels`)
 *   Ownership 30 : เป็นเจ้าของโค้ดส่วนที่แก้ (อ่านจาก CODEOWNERS ก่อน;
 *                  ถ้าไม่มี/ไม่ match ค่อยใช้ config `owns`)
 *   Workload  20 : มีงานรอรีวิวน้อย (20 - 5 ต่อหนึ่งงานที่ค้าง, ต่ำสุด 0)
 *   Recency   10 : ยังไม่ได้รีวิว PR ล่าสุด (+10)
 *
 * 1) ผู้เปิด PR (และ login ใน `exclude`) ถูกตัดสิทธิ์ก่อนคิดคะแนนเสมอ
 * 2) เรียงคะแนนมาก -> น้อย แล้วเลือก `count` คนแรก
 * 3) คะแนนเท่ากันให้ Round-Robin ตัดสิน: ใกล้ cursor กว่า -> งานค้างน้อยกว่า
 *    (คิวไม่ถูกใส่ในคะแนน เพื่อให้ tie-breaker มีผลจริง)
 * 4) ทุกคนที่ถูกเลือกมี `reasons`/`summary` อธิบายว่าได้คะแนนจากอะไร
 *
 * ระบบสำรองเมื่อข้อมูลไม่เพียงพอ:
 * - ไม่มี CODEOWNERS/ไม่มี owner ที่ตรง -> ownership ใช้ `owns` ใน config แทน
 * - ไม่มี `reviewer_profiles` หรือไม่มีไฟล์/label -> skill/ownership = 0 ทุกคน
 * - ไม่มีข้อมูลงานค้าง -> ทุกคนได้ workload เต็ม 20 (ไม่ลงโทษใคร)
 * - ไม่มี history -> ทุกคนได้ recency 10 -> คิว round-robin ตัดสิน
 * - ไม่มีใครมีสิทธิ์เลย -> คืน selected ว่างและคง cursor เดิม
 */

import { countOwnership, parseCodeowners } from './codeowners.mjs';
import { matchPaths, matchProfile } from './expertise.mjs';

/** error ที่เกิดจาก config ไม่ถูกต้อง (เช่น รายชื่อว่างหรือรูปแบบ login ผิด) */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** น้ำหนักคะแนน (รวมกันได้ 100) */
export const SCORE_WEIGHTS = Object.freeze({
  skill: 40,
  ownership: 30,
  workload: 20,
  recency: 10,
});

/** คะแนนเต็ม = ผลรวมน้ำหนัก (ใช้แสดงผล/log) */
export const MAX_SCORE =
  SCORE_WEIGHTS.skill + SCORE_WEIGHTS.ownership + SCORE_WEIGHTS.workload + SCORE_WEIGHTS.recency;

/** หักคะแนน workload ต่อหนึ่งงานรีวิวที่ค้างอยู่ */
export const WORKLOAD_PENALTY_PER_PENDING = 5;

// กติกา GitHub login: ตัวอักษร/ตัวเลขหรือ hyphen เดี่ยว, ห้ามขึ้นต้น/ลงท้ายด้วย hyphen, ยาวสุด 39 ตัว
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

/** ตัดช่องว่าง ตรวจรูปแบบ และตัดรายการซ้ำ (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ในคิว reviewer */
export function normalizeReviewers(reviewers) {
  // ต้องเป็น array ที่มีอย่างน้อย 1 รายการ
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new ConfigError('config.reviewers must be a non-empty array of GitHub logins');
  }

  const seen = new Set();
  const result = [];

  for (const value of reviewers) {
    // แต่ละรายการต้องเป็น string
    if (typeof value !== 'string') {
      throw new ConfigError(`invalid GitHub login in config.reviewers: ${JSON.stringify(value)}`);
    }
    const login = value.trim();
    // ต้องเป็น GitHub login ที่ถูกรูปแบบ
    if (!LOGIN_RE.test(login)) {
      throw new ConfigError(`invalid GitHub login in config.reviewers: ${JSON.stringify(value)}`);
    }
    const key = login.toLowerCase();
    // ข้ามรายการที่ซ้ำ (เทียบแบบไม่สนตัวพิมพ์เล็ก/ใหญ่)
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(login);
  }

  if (result.length === 0) {
    throw new ConfigError('config.reviewers must contain at least one login');
  }

  return result;
}

/**
 * สรุปประวัติการ assign จาก state.assignments
 * - records: login -> { lastPosition, times }
 * - lastEntry: assignment ล่าสุด (ใช้คิด recency)
 */
function summarizeHistory(history) {
  const records = new Map();
  const entries = Array.isArray(history) ? history : [];

  entries.forEach((entry, position) => {
    const logins = Array.isArray(entry && entry.reviewers) ? entry.reviewers : [];
    for (const login of logins) {
      // ข้ามข้อมูลเพี้ยนใน state (ไม่ใช่ string / ว่าง)
      if (typeof login !== 'string') continue;
      const key = login.trim().toLowerCase();
      if (key === '') continue;

      const record = records.get(key) ?? { lastPosition: -1, times: 0 };
      record.lastPosition = Math.max(record.lastPosition, position);
      record.times += 1;
      records.set(key, record);
    }
  });

  return { records, lastEntry: entries.length > 0 ? entries[entries.length - 1] : null };
}

/** ทำ `changes` ให้เป็นรายการ string: รองรับทั้ง string และ object จาก GitHub API */
function normalizeChanges(changes) {
  const source = changes && typeof changes === 'object' ? changes : {};

  const files = (Array.isArray(source.files) ? source.files : [])
    .map((file) => (typeof file === 'string' ? file : file && file.filename))
    .filter((file) => typeof file === 'string' && file.trim() !== '');

  const labels = (Array.isArray(source.labels) ? source.labels : [])
    .map((label) => (typeof label === 'string' ? label : label && label.name))
    .filter((label) => typeof label === 'string' && label.trim() !== '');

  return { files, labels };
}

/** ทำ `profiles` (login -> { paths, labels, owns }) ให้เป็น Map ที่เทียบชื่อแบบไม่สนตัวพิมพ์ */
function normalizeProfiles(profiles) {
  const map = new Map();
  if (!profiles || typeof profiles !== 'object') return map;

  const readPatterns = (value) =>
    (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string' && item.trim() !== '');

  for (const [login, profile] of Object.entries(profiles)) {
    if (typeof login !== 'string' || login.trim() === '') continue;
    if (!profile || typeof profile !== 'object') continue;
    map.set(login.trim().toLowerCase(), {
      paths: readPatterns(profile.paths),
      labels: readPatterns(profile.labels),
      owns: readPatterns(profile.owns),
    });
  }

  return map;
}

/** ทำ `pending` (login -> จำนวนงานรีวิวที่ค้าง) ให้เป็น Map ของจำนวนเต็มบวก */
function normalizePending(pending) {
  const map = new Map();
  if (!pending || typeof pending !== 'object') return map;

  for (const [login, value] of Object.entries(pending)) {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) continue;
    map.set(login.trim().toLowerCase(), Math.floor(count));
  }

  return map;
}

/**
 * คำนวณคะแนน 100 ของผู้มีสิทธิ์ทั้งหมด
 *
 * skill     = 40 × (จุดที่ตรง / จุดที่ตรงมากสุด)  — ไม่มีข้อมูล = 0 ทุกคน
 * ownership = 30 × (ไฟล์ที่เป็นเจ้าของ / มากสุด) — ไม่มีข้อมูล = 0 ทุกคน
 * workload  = 20 - 5 × งานค้าง (ต่ำสุด 0)       — ไม่มีข้อมูล = 20 ทุกคน
 * recency   = 10 ถ้ายังไม่ได้รีวิว PR ล่าสุด
 */
function scoreCandidates(candidates, { profiles, changes, pending, lastEntry, codeowners, teamMembers }) {
  // อ่าน CODEOWNERS (ถ้ามี) แล้วนับว่าใครเป็นเจ้าของไฟล์ที่แก้กี่ไฟล์
  // ทีม @org/team ต้องถูกขยายเป็นรายชื่อสมาชิกก่อน (teamMembers) ถึงจะนับให้
  const codeownerRules =
    typeof codeowners === 'string' && codeowners.trim() !== '' ? parseCodeowners(codeowners) : [];
  const codeownerCounts =
    codeownerRules.length > 0 ? countOwnership(codeownerRules, changes.files, { teamMembers }) : new Map();
  // ใช้ CODEOWNERS เมื่อมี owner ที่เป็น login จริงอย่างน้อยหนึ่งคนในไฟล์ที่แก้
  const useCodeowners = codeownerCounts.size > 0;

  const lastReviewers = new Set(
    (Array.isArray(lastEntry && lastEntry.reviewers) ? lastEntry.reviewers : [])
      .filter((login) => typeof login === 'string')
      .map((login) => login.trim().toLowerCase()),
  );

  const entries = candidates.map((candidate) => {
    const key = candidate.login.toLowerCase();
    const profile = profiles.get(key);
    const hasSkillRules = Boolean(profile && (profile.paths.length > 0 || profile.labels.length > 0));

    // ความถนัด: ไฟล์ + label ที่ตรง
    const skillMatch = hasSkillRules ? matchProfile(profile, changes.files, changes.labels) : null;
    // ความเป็นเจ้าของ: CODEOWNERS ก่อน ถ้าไม่มีข้อมูลค่อยใช้ owns ใน config (เฉพาะไฟล์ ไม่นับ label)
    const ownedFiles = profile && profile.owns.length > 0 ? matchPaths(profile.owns, changes.files) : [];
    const codeownerCount = codeownerCounts.get(key) ?? 0;

    return {
      login: candidate.login,
      index: candidate.index,
      distance: candidate.distance,
      pending: pending.get(key) ?? 0,
      matched: skillMatch ? skillMatch.count : 0,
      fitSamples: skillMatch ? skillMatch.samples : [],
      hasFitRules: hasSkillRules,
      ownedCount: useCodeowners ? codeownerCount : ownedFiles.length,
      ownershipSource: useCodeowners ? 'CODEOWNERS' : ownedFiles.length > 0 ? 'owns' : null,
      reviewedLatest: lastReviewers.has(key),
    };
  });

  const maxMatched = Math.max(0, ...entries.map((item) => item.matched));
  const maxOwned = Math.max(0, ...entries.map((item) => item.ownedCount));

  return entries.map((item) => {
    // ไม่มีข้อมูลให้เทียบ -> 0 ทุกคน (ไม่ลงโทษใคร) แล้วคะแนนส่วนอื่นตัดสิน
    const skill = maxMatched === 0 ? 0 : Math.round((SCORE_WEIGHTS.skill * item.matched) / maxMatched);
    const ownership = maxOwned === 0 ? 0 : Math.round((SCORE_WEIGHTS.ownership * item.ownedCount) / maxOwned);
    // งานค้างยิ่งน้อยยิ่งได้มาก; ไม่มีข้อมูลงานค้าง = ไม่หัก (เต็ม 20)
    const workload = Math.max(0, SCORE_WEIGHTS.workload - WORKLOAD_PENALTY_PER_PENDING * item.pending);
    const recency = item.reviewedLatest ? 0 : SCORE_WEIGHTS.recency;

    return {
      ...item,
      // อัตราส่วน 0–1 ของ skill/ownership (ใช้ตรวจสอบ/log)
      fit: maxMatched === 0 ? 0 : item.matched / maxMatched,
      ownershipRatio: maxOwned === 0 ? 0 : item.ownedCount / maxOwned,
      skill,
      ownership,
      workload,
      recency,
      score: skill + ownership + workload + recency,
    };
  });
}

/** สร้างเหตุผลที่อ่านรู้เรื่องสำหรับ reviewer ที่ถูกเลือก */
function buildReasons(item, next) {
  const reasons = [];

  // ความถนัด
  if (!item.hasFitRules) {
    reasons.push(`ไม่มีข้อมูลความถนัด (skill 0/${SCORE_WEIGHTS.skill})`);
  } else if (item.matched === 0) {
    reasons.push(`ไม่ตรงกับไฟล์/label ที่เปลี่ยน (skill 0/${SCORE_WEIGHTS.skill})`);
  } else {
    reasons.push(
      `ตรงกับงาน ${item.matched} จุด -> skill ${item.skill}/${SCORE_WEIGHTS.skill} (${item.fitSamples.join(', ')})`,
    );
  }

  // ความเป็นเจ้าของโค้ด
  reasons.push(
    item.ownedCount > 0
      ? `เป็นเจ้าของโค้ดที่แก้ ${item.ownedCount} ไฟล์ (${item.ownershipSource}) -> ownership ${item.ownership}/${SCORE_WEIGHTS.ownership}`
      : `ไม่ได้เป็นเจ้าของไฟล์ที่แก้ (ownership 0/${SCORE_WEIGHTS.ownership})`,
  );

  // งานที่รอรีวิว
  reasons.push(
    item.pending > 0
      ? `มีงานรอรีวิว ${item.pending} งาน -> workload ${item.workload}/${SCORE_WEIGHTS.workload}`
      : `ไม่มีงานรอรีวิว -> workload ${item.workload}/${SCORE_WEIGHTS.workload}`,
  );

  // ความสด: ไม่ได้รีวิว PR ล่าสุด
  reasons.push(
    item.reviewedLatest
      ? `เพิ่งรีวิว PR ล่าสุดไปแล้ว (recency 0/${SCORE_WEIGHTS.recency})`
      : `ยังไม่ได้รีวิว PR ล่าสุด (+${SCORE_WEIGHTS.recency})`,
  );

  // บอกด้วยว่าเสมอกับใคร แล้วตัดสินด้วยอะไร
  if (next && next.score === item.score) {
    reasons.push(`คะแนนเท่ากับ ${next.login} -> คิว round-robin ถึงก่อน`);
  }

  return reasons;
}

/**
 * เลือก reviewer ตาม hybrid scoring คืนค่า `{ selected, nextCursor, scored }`
 *
 * - `history`: ประวัติ assignment จาก state (ใช้คิด recency)
 * - `exclude`: login ที่ห้ามเลือก เช่น ผู้เปิด PR
 * - `profiles`: `{ login: { paths: [], labels: [], owns: [] } }`
 * - `changes`: งานของ PR รูปแบบ `{ files: [], labels: [] }` (รับ object จาก API ได้)
 * - `pending`: จำนวนงานรีวิวที่ค้างอยู่ต่อ login
 * - `codeowners`: ข้อความในไฟล์ CODEOWNERS (ถ้าไม่มีจะใช้ `owns` ใน config)
 * - `teamMembers`: { 'org/team': ['login', ...] } ใช้ขยายเจ้าของที่เป็นทีม
 * - `scored`: คะแนน + เหตุผลของผู้มีสิทธิ์ทุกคน เรียงตามลำดับที่ใช้เลือกจริง
 *
 * ถ้าไม่มีใครมีสิทธิ์ `selected` จะว่างและ cursor คงเดิม (ไม่เสียตำแหน่งคิว)
 */
export function selectReviewers({
  reviewers,
  cursor = 0,
  count = 1,
  exclude = [],
  history = [],
  profiles = {},
  changes = {},
  pending = {},
  codeowners = null,
  teamMembers = {},
}) {
  // ตรวจอินพุตพื้นฐาน
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new ConfigError('reviewers must be a non-empty array');
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ConfigError('count must be a positive integer');
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new ConfigError('cursor must be a non-negative integer');
  }

  // ทำรายการยกเว้นให้เป็น set ของ login ตัวพิมพ์เล็ก เพื่อเทียบแบบไม่สนตัวพิมพ์
  const excluded = new Set(
    (Array.isArray(exclude) ? exclude : [])
      .filter((login) => typeof login === 'string' && login.trim() !== '')
      .map((login) => login.trim().toLowerCase()),
  );

  const n = reviewers.length;
  // cursor อาจมากกว่าขนาดคิวได้ (เช่น หลังลบคนออกจากคิว) จึง modulo ก่อน
  const start = cursor % n;
  const { lastEntry } = summarizeHistory(history);

  // เก็บผู้มีสิทธิ์ทั้งหมดพร้อมระยะห่างจาก cursor (ใช้เป็น tie-breaker)
  const candidates = [];
  for (let distance = 0; distance < n; distance += 1) {
    const index = (start + distance) % n;
    const login = reviewers[index];
    if (excluded.has(login.toLowerCase())) continue;

    candidates.push({ login, index, distance });
  }

  // ไม่มีใครมีสิทธิ์เลย -> คง cursor เดิมไว้
  if (candidates.length === 0) {
    return { selected: [], nextCursor: start, scored: [] };
  }

  const scored = scoreCandidates(candidates, {
    profiles: normalizeProfiles(profiles),
    changes: normalizeChanges(changes),
    pending: normalizePending(pending),
    lastEntry,
    codeowners,
    teamMembers,
  });

  // คะแนนมากก่อน; เสมอแล้วให้ round-robin ตัดสิน:
  // ใกล้ cursor กว่า -> งานค้างน้อยกว่า -> ชื่อตามลำดับคิว
  scored.sort((a, b) => b.score - a.score || a.distance - b.distance || a.pending - b.pending);

  const picked = scored.slice(0, Math.min(count, scored.length));

  // แนบเหตุผลให้แต่ละคนที่ถูกเลือก (เทียบกับคนถัดไปเพื่ออธิบายกรณีคะแนนเสมอ)
  for (const item of picked) {
    const position = scored.indexOf(item);
    item.reasons = buildReasons(item, scored[position + 1]);
    item.summary = item.reasons.join(' · ');
  }

  // เลื่อน cursor ไปหลังตำแหน่งที่ไกลจากจุดเริ่มต้นที่สุดในกลุ่มที่เลือก
  const furthest = picked.reduce((max, item) => (item.distance > max.distance ? item : max), picked[0]);

  return {
    selected: picked.map((item) => item.login),
    nextCursor: (furthest.index + 1) % n,
    scored,
  };
}
