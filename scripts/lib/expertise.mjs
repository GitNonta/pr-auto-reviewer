/**
 * จับคู่ "ความถนัด" และ "ความเป็นเจ้าของโค้ด" ของ reviewer กับงานจริงของ PR
 * ไม่มี I/O ใช้ได้ทั้งใน action และเทสต์
 *
 * รับ pattern แบบ glob ง่าย ๆ:
 *   - `*`  = อะไรก็ได้ยกเว้น `/`
 *   - `**` = อะไรก็ได้รวม `/`
 *   - `?`  = หนึ่งตัวอักษร (ไม่ใช่ `/`)
 * ตัวอย่าง: `backend/**`, `*.json`, `frontend/src/**\/*.tsx`
 */

/** แปลง glob เป็น RegExp (anchor เต็ม path) */
export function globToRegExp(pattern, flags = '') {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      // `**` กินข้ามโฟลเดอร์ได้ ส่วน `*` กินเฉพาะภายใน segment เดียว
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      // escape อักขระพิเศษของ RegExp
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, flags);
}

/** ตรวจว่า path ตรงกับ pattern ใด pattern หนึ่งหรือไม่ */
export function matchesAnyPattern(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/** คืนรายการไฟล์ที่ตรงกับ pattern (ใช้ทั้ง skill และ ownership) */
export function matchPaths(patterns, files = []) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  const matchers = patterns.map((pattern) => globToRegExp(pattern));
  return files.filter((file) => matchers.some((matcher) => matcher.test(file)));
}

/**
 * ให้คะแนน "ความถนัด" (skill) ของ reviewer เทียบกับงานของ PR
 * - paths: pattern ของไฟล์ (case-sensitive ตาม path จริงใน git)
 * - labels: ชื่อ label (ไม่สนตัวพิมพ์ รองรับ glob)
 */
export function matchProfile(profile, files = [], labels = []) {
  const pathPatterns = Array.isArray(profile?.paths) ? profile.paths : [];
  const labelPatterns = Array.isArray(profile?.labels) ? profile.labels : [];

  const matchedFiles = matchPaths(pathPatterns, files);
  const labelMatchers = labelPatterns.map((pattern) => globToRegExp(pattern, 'i'));
  const matchedLabels = labels.filter((label) => labelMatchers.some((matcher) => matcher.test(label)));

  return {
    // ใช้เป็นตัวเลขสำหรับคิดคะแนน: ไฟล์ที่ตรง + label ที่ตรง
    count: matchedFiles.length + matchedLabels.length,
    matchedFiles,
    matchedLabels,
    // ตัวอย่างสั้น ๆ สำหรับ log/คอมเมนต์ (จำกัด 3 รายการ)
    samples: [
      ...matchedFiles.slice(0, 3).map((file) => `ไฟล์ ${file}`),
      ...matchedLabels.slice(0, 3).map((label) => `label ${label}`),
    ].slice(0, 3),
    hasRules: pathPatterns.length > 0 || labelPatterns.length > 0,
  };
}
