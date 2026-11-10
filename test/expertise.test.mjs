import test from 'node:test';
import assert from 'node:assert/strict';

import { globToRegExp, matchProfile, matchesAnyPattern } from '../scripts/lib/expertise.mjs';

test('* ไม่ข้ามโฟลเดอร์ แต่ ** ข้ามได้', () => {
  assert.ok(matchesAnyPattern('scripts/a.mjs', ['scripts/*']));
  assert.ok(!matchesAnyPattern('scripts/lib/a.mjs', ['scripts/*']));
  assert.ok(matchesAnyPattern('scripts/lib/a.mjs', ['scripts/**']));
});

test('escape อักขระพิเศษของ RegExp และรองรับ ?', () => {
  assert.ok(matchesAnyPattern('package.json', ['package.json']));
  assert.ok(!matchesAnyPattern('packageXjson', ['package.json']));
  assert.ok(matchesAnyPattern('src/a.ts', ['src/?.ts']));
  assert.ok(!matchesAnyPattern('src/ab.ts', ['src/?.ts']));
});

test('matchProfile นับไฟล์และ label ที่ตรง พร้อมตัวอย่าง', () => {
  const result = matchProfile(
    { paths: ['scripts/**', '*.json'], labels: ['infra'] },
    ['scripts/lib/a.mjs', 'package.json', 'README.md'],
    ['Infra', 'docs'],
  );

  assert.equal(result.count, 3); // 2 ไฟล์ + 1 label
  assert.deepEqual(result.matchedFiles, ['scripts/lib/a.mjs', 'package.json']);
  assert.deepEqual(result.matchedLabels, ['Infra']);
  assert.ok(result.hasRules);
  assert.ok(result.samples.some((sample) => sample.includes('scripts/lib/a.mjs')));
});

test('profile ที่ไม่มี rules หรือไม่มีข้อมูลงาน -> count 0 และ hasRules ถูกต้อง', () => {
  assert.deepEqual(matchProfile({}, ['a.js'], ['x']).count, 0);
  assert.equal(matchProfile({ paths: ['scripts/**'] }, ['a.js'], []).hasRules, true);
  assert.equal(matchProfile({}, [], []).hasRules, false);
});

test('globToRegExp ต้อง match เต็ม path ไม่ใช่ substring', () => {
  assert.ok(globToRegExp('scripts/*').test('scripts/a.mjs'));
  assert.ok(!globToRegExp('scripts/*').test('src/scripts/a.mjs'));
});
