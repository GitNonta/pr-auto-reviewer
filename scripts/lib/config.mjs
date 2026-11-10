import { readFile } from 'node:fs/promises';
import { ConfigError, normalizeReviewers } from './round-robin.mjs';

// path ของไฟล์ config เริ่มต้น (เปลี่ยนได้ผ่าน env CONFIG_PATH)
export const DEFAULT_CONFIG_PATH = '.github/auto-assign-reviewers.json';
// path ของไฟล์ state เริ่มต้น ใช้เมื่อ config ไม่ได้ระบุ state_path
export const DEFAULT_STATE_PATH = '.github/reviewers-state.json';

/** อ่าน array ของ string จาก config (ตัดค่าว่างทิ้ง) และโยน ConfigError ถ้ารูปแบบผิด */
function readStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${field} must be an array of strings`);

  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigError(`${field} must contain only non-empty strings`);
    }
    return item.trim();
  });
}

/**
 * แปลง `reviewer_profiles` เป็น { login: { paths, labels } }
 * - login ที่ไม่อยู่ในคิวจะถูกข้าม (เลือกไม่ได้อยู่แล้ว)
 * - ค่าเริ่มต้นคือ {} = ไม่มีข้อมูลความถนัด -> คะแนน fit เป็น 0 ทุกคน
 */
function parseProfiles(raw, reviewers) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('reviewer_profiles must be an object keyed by GitHub login');
  }

  const canonical = new Map(reviewers.map((login) => [login.toLowerCase(), login]));
  const profiles = {};

  for (const [key, value] of Object.entries(raw)) {
    const login = canonical.get(key.trim().toLowerCase());
    // login ที่ไม่ได้อยู่ในคิว reviewer: ไม่มีผลต่อการเลือก จึงข้ามไป
    if (!login) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConfigError(`reviewer_profiles.${key} must be an object with paths/labels/owns arrays`);
    }

    profiles[login] = {
      paths: readStringArray(value.paths, `reviewer_profiles.${key}.paths`),
      labels: readStringArray(value.labels, `reviewer_profiles.${key}.labels`),
      // owns = โค้ดที่ reviewer คนนี้เป็นเจ้าของ ใช้คิดคะแนน ownership
      owns: readStringArray(value.owns, `reviewer_profiles.${key}.owns`),
    };
  }

  return profiles;
}

/**
 * อ่านและตรวจสอบไฟล์ config แล้วคืนค่าที่ normalize พร้อมใช้
 * โครงสร้างที่รองรับ:
 * {
 *   "reviewers": ["login1", "login2"],
 *   "number_of_reviewers": 1,
 *   "state_path": ".github/reviewers-state.json",
 *   "tag_fallback": true,
 *   "codeowners_path": ".github/CODEOWNERS",
 *   "reviewer_profiles": {
 *     "login1": {
 *       "paths": ["frontend/**"],
 *       "labels": ["frontend"],
 *       "owns": ["frontend/src/**"]
 *     }
 *   }
 * }
 */
export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  // อ่านไฟล์ config
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config at ${configPath}: ${err.message}`);
  }

  // แปลงข้อความเป็น JSON
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config at ${configPath} is not valid JSON: ${err.message}`);
  }

  // ตรวจรายชื่อ reviewer (ตัดช่องว่าง, ตรวจรูปแบบ login, ตัดรายการซ้ำ)
  const reviewers = normalizeReviewers(parsed.reviewers);
  // จำนวน reviewer ที่ต้องเลือกต่อ PR ค่าเริ่มต้นคือ 1
  const count = parsed.number_of_reviewers ?? 1;

  // ต้องเป็นจำนวนเต็ม 1 จนถึงจำนวน reviewer ในคิวเท่านั้น
  if (!Number.isInteger(count) || count < 1 || count > reviewers.length) {
    throw new ConfigError(
      `number_of_reviewers must be an integer between 1 and ${reviewers.length} (the size of config.reviewers)`,
    );
  }

  // state_path ต้องเป็น string ที่ไม่ว่าง ไม่อย่างนั้นใช้ค่าเริ่มต้น
  const statePath =
    typeof parsed.state_path === 'string' && parsed.state_path.trim() !== ''
      ? parsed.state_path.trim()
      : DEFAULT_STATE_PATH;

  // path ของ CODEOWNERS (optional) ถ้าไม่ระบุจะค้นหา .github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS
  const codeownersPath =
    typeof parsed.codeowners_path === 'string' && parsed.codeowners_path.trim() !== ''
      ? parsed.codeowners_path.trim()
      : null;

  return {
    reviewers,
    count,
    statePath,
    codeownersPath,
    // tag_fallback เปิดไว้โดยค่าเริ่มต้น ปิดได้ด้วยค่า false
    tagFallback: parsed.tag_fallback !== false,
    // ความถนัดของแต่ละคน (optional) ใช้คิดคะแนน fit
    profiles: parseProfiles(parsed.reviewer_profiles, reviewers),
  };
}
