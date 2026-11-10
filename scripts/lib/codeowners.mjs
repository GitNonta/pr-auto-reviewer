/**
 * อ่านไฟล์ CODEOWNERS (รูปแบบเดียวกับที่ GitHub ใช้) เพื่อรู้ว่าใครเป็นเจ้าของไฟล์ที่แก้
 * ไม่มี I/O: รับข้อความเข้ามาแล้วคืน rules/counts ให้ scorer ใช้ต่อ
 *
 * กติกาที่รองรับ:
 * - `#` ขึ้นต้นบรรทัด = comment, `\#` = ตัวอักษร # จริง, comment ท้ายบรรทัดได้
 * - pattern ไม่ขึ้นต้นด้วย `/` และไม่มี `/` ข้างใน = match ทุกความลึก (เช่น `*.js`)
 * - pattern ขึ้นต้นด้วย `/` = ยึดจาก root
 * - pattern ลงท้ายด้วย `/` = ทั้งโฟลเดอร์ (เช่น `backend/` = `backend/**`)
 * - owner `@login` = ผู้ใช้, `@org/team` = ทีม (ต้องขยายสมาชิกก่อนนับ)
 * - ถ้าหลาย rule ตรงกับไฟล์เดียว ใช้ rule สุดท้าย (เหมือน GitHub)
 */

/** แปลง pattern ของ CODEOWNERS เป็น RegExp (anchor เต็ม path) */
export function codeownersPatternToRegExp(pattern) {
  let source = pattern.trim();
  if (source === '') return /$^/;

  // pattern ของโฟลเดอร์: `backend/` หมายถึงทุกไฟล์ใต้ backend
  const directoryOnly = source.endsWith('/');
  if (directoryOnly) source = source.slice(0, -1);
  if (source.startsWith('/')) {
    source = source.slice(1);
  } else if (!source.includes('/')) {
    // ไม่มี `/` = match ได้ทุกความลึก
    source = `**/${source}`;
  }
  if (directoryOnly) source = `${source}/**`;

  let regex = '^';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*') {
      if (source[index + 1] === '*') {
        // `**/` ต้อง match ได้ทั้ง "ไม่มีโฟลเดอร์" และ "หลายโฟลเดอร์"
        if (source[index + 2] === '/') {
          regex += '(?:.*/)?';
          index += 2;
        } else {
          regex += '.*';
          index += 1;
        }
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`${regex}$`);
}

/** แยก token ของ owner เป็นรายชื่อผู้ใช้ (owners) และทีม (teams, ตัวพิมพ์เล็ก) */
function parseOwnerTokens(tokens) {
  const owners = [];
  const teams = [];

  for (const token of tokens) {
    if (!token.startsWith('@')) continue;
    const value = token.slice(1).trim();
    if (value === '') continue;
    if (value.includes('/')) teams.push(value.toLowerCase());
    else owners.push(value);
  }

  return { owners, teams };
}

/** แปลงข้อความ CODEOWNERS เป็น rules: [{ pattern, regExp, owners, teams }] */
export function parseCodeowners(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // เก็บ `\#` ไว้ก่อน แล้วค่อยตัด comment ท้ายบรรทัด
    const line = rawLine.replace(/\\#/g, '\u0000').replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;

    const tokens = line.replace(/\u0000/g, '#').split(/\s+/);
    const pattern = tokens.shift();
    if (!pattern) continue;

    const { owners, teams } = parseOwnerTokens(tokens);
    rules.push({
      pattern,
      regExp: codeownersPatternToRegExp(pattern),
      owners,
      teams,
    });
  }

  return rules;
}

/** rule สุดท้ายที่ match ไฟล์นั้น (ใช้ทั้ง owners และ teams ให้ตรงกัน) */
function lastMatchingRule(rules, file) {
  let matched = null;
  for (const rule of rules) {
    if (rule.regExp.test(file)) matched = rule;
  }
  return matched;
}

/** หาเจ้าของ (ผู้ใช้) ของไฟล์หนึ่งไฟล์: rule สุดท้ายที่ match ชนะ (เหมือน GitHub) */
export function ownersForFile(rules, file) {
  return lastMatchingRule(rules, file)?.owners ?? [];
}

/** หาทีมที่เป็นเจ้าของไฟล์หนึ่งไฟล์ */
export function teamsForFile(rules, file) {
  return lastMatchingRule(rules, file)?.teams ?? [];
}

/** เก็บทีมทั้งหมดที่อ้างถึงใน CODEOWNERS (ใช้ไปขยายสมาชิกจาก Teams API) */
export function collectTeams(rules) {
  const teams = new Set();
  for (const rule of rules) {
    for (const team of rule.teams ?? []) teams.add(team);
  }
  return teams;
}

/**
 * นับจำนวนไฟล์ที่แต่ละ login เป็นเจ้าของ -> Map(login ตัวพิมพ์เล็ก -> จำนวนไฟล์)
 *
 * - `teamMembers`: { 'org/team': ['login1', ...] } จาก Teams API
 *   ทีมที่ยังไม่ถูกขยายจะไม่ถูกนับ ( scorer จะ fallback ไป owns ใน config)
 * - หนึ่งไฟล์นับให้แต่ละ login ครั้งเดียว (ถึงจะถูกระบุทั้งตรง ๆ และผ่านทีม)
 */
export function countOwnership(rules, files = [], { teamMembers = {} } = {}) {
  const counts = new Map();
  if (!Array.isArray(rules) || rules.length === 0) return counts;

  for (const file of files) {
    // ใช้ Set เพื่อไม่ให้นับไฟล์เดิมซ้ำให้คนเดิม
    const ownersPerFile = new Set();

    for (const owner of ownersForFile(rules, file)) {
      const key = owner.trim().toLowerCase();
      if (key !== '') ownersPerFile.add(key);
    }

    for (const team of teamsForFile(rules, file)) {
      const members = Array.isArray(teamMembers[team]) ? teamMembers[team] : [];
      for (const login of members) {
        if (typeof login !== 'string' || login.trim() === '') continue;
        ownersPerFile.add(login.trim().toLowerCase());
      }
    }

    for (const key of ownersPerFile) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}
