import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codeownersPatternToRegExp,
  collectTeams,
  countOwnership,
  ownersForFile,
  parseCodeowners,
  teamsForFile,
} from '../scripts/lib/codeowners.mjs';

test('แปลง pattern ตามกติกา CODEOWNERS', () => {
  assert.ok(codeownersPatternToRegExp('*.js').test('src/deep/a.js'));
  assert.ok(codeownersPatternToRegExp('/backend/server.js').test('backend/server.js'));
  assert.ok(!codeownersPatternToRegExp('/backend/server.js').test('src/backend/server.js'));
  assert.ok(codeownersPatternToRegExp('backend/').test('backend/api/a.js'));
  assert.ok(codeownersPatternToRegExp('backend/').test('src/backend/a.js'));
  assert.ok(codeownersPatternToRegExp('docs/*.md').test('docs/api.md'));
  assert.ok(!codeownersPatternToRegExp('docs/*.md').test('docs/sub/api.md'));
});

test('อ่าน comment, บรรทัดว่าง, comment ท้ายบรรทัด และ \\#', () => {
  const rules = parseCodeowners(
    ['# หัวไฟล์', '', '*.js @alice', '*.ts @bob # ท้ายบรรทัด', '\\#notes @carol', '/backend/ @dave @org/core'].join('\n'),
  );

  assert.deepEqual(
    rules.map((rule) => ({ pattern: rule.pattern, owners: rule.owners })),
    [
      { pattern: '*.js', owners: ['alice'] },
      { pattern: '*.ts', owners: ['bob'] },
      { pattern: '#notes', owners: ['carol'] },
      { pattern: '/backend/', owners: ['dave'] },
    ],
  );
});

test('rule สุดท้ายที่ match ชนะ และทีมถูกข้าม', () => {
  const rules = parseCodeowners(['* @alice', 'docs/ @bob', 'docs/ @org/team @carol'].join('\n'));

  assert.deepEqual(ownersForFile(rules, 'docs/guide.md'), ['carol']);
  assert.deepEqual(ownersForFile(rules, 'src/app.js'), ['alice']);
  assert.deepEqual(ownersForFile(parseCodeowners('* @org/team'), 'src/app.js'), []);
});

test('countOwnership นับจำนวนไฟล์ต่อ login (ไม่สนตัวพิมพ์)', () => {
  const rules = parseCodeowners(['backend/ @Bob', '*.md @alice'].join('\n'));

  const counts = countOwnership(rules, ['backend/a.js', 'backend/b.js', 'README.md', 'src/x.ts']);

  assert.equal(counts.get('bob'), 2);
  assert.equal(counts.get('alice'), 1);
  assert.equal(counts.get('carol'), undefined);
});

test('แยกเจ้าของที่เป็นทีม (@org/team) และเก็บไว้ขยายสมาชิก', () => {
  const rules = parseCodeowners(['backend/ @Bob @acme/core', 'docs/ @acme/docs'].join('\n'));

  assert.deepEqual([...collectTeams(rules)], ['acme/core', 'acme/docs']);
  assert.deepEqual(teamsForFile(rules, 'backend/a.js'), ['acme/core']);
  assert.deepEqual(ownersForFile(rules, 'backend/a.js'), ['Bob']);
});

test('countOwnership ขยายทีมเป็นสมาชิกและไม่นับไฟล์ซ้ำให้คนเดิม', () => {
  const rules = parseCodeowners(['backend/ @Bob @acme/core'].join('\n'));

  const counts = countOwnership(rules, ['backend/a.js', 'backend/b.js'], {
    teamMembers: { 'acme/core': ['Bob', 'hubot'] },
  });

  assert.equal(counts.get('bob'), 2);
  assert.equal(counts.get('hubot'), 2);
});

test('ทีมที่ยังไม่ถูกขยายจะไม่ถูกนับ ownership', () => {
  const rules = parseCodeowners('backend/ @acme/core');

  assert.equal(countOwnership(rules, ['backend/a.js']).size, 0);
});

test('ข้อความว่างหรือผิดรูปแบบไม่ทำให้ throw', () => {
  assert.deepEqual(parseCodeowners(''), []);
  assert.deepEqual(parseCodeowners(null), []);
  assert.deepEqual(parseCodeowners('   \n\n  '), []);
  assert.deepEqual(countOwnership([], ['a.js']).size, 0);
});
