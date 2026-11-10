import test from 'node:test';
import assert from 'node:assert/strict';

import { selectReviewers } from '../scripts/lib/round-robin.mjs';

test('เลือกคนที่ความถนัดตรงกับไฟล์ที่เปลี่ยน แม้ cursor ชี้คนอื่น', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 0,
    count: 1,
    profiles: { alice: { paths: ['docs/**'] }, bob: { paths: ['scripts/**'] } },
    changes: { files: ['scripts/lib/a.mjs'] },
  });

  assert.deepEqual(selected, ['bob']);
  assert.equal(scored[0].fit, 1);
  assert.equal(scored[0].skill, 40);
  assert.equal(scored.find((item) => item.login === 'alice').fit, 0);
});

test('ตรงกับ label ก็ได้คะแนน skill (ไม่สนตัวพิมพ์)', () => {
  const { selected } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 0,
    count: 1,
    profiles: { bob: { labels: ['frontend'] } },
    changes: { files: ['src/a.ts'], labels: ['Frontend'] },
  });

  assert.deepEqual(selected, ['bob']);
});

test('ไม่มีไฟล์/label ให้เทียบ = ระบบสำรองใช้ workload/คิว ไม่ throw', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol'],
    cursor: 1,
    count: 1,
    profiles: { alice: { paths: ['docs/**'] } },
    changes: {},
  });

  assert.deepEqual(selected, ['bob']);
  assert.ok(scored.every((item) => item.fit === 0 && item.skill === 0));
});

test('ไม่มี reviewer_profiles = พฤติกรรมเดิม (คิวตัดสิน)', () => {
  const { selected } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 1,
    count: 1,
    changes: { files: ['scripts/a.mjs'], labels: ['infra'] },
  });

  assert.deepEqual(selected, ['bob']);
});

test('งานรีวิวที่ค้างอยู่ทำให้คะแนน workload ลดลง', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 0,
    count: 1,
    pending: { alice: 2 },
  });

  assert.deepEqual(selected, ['bob']);
  const alice = scored.find((item) => item.login === 'alice');
  const bob = scored.find((item) => item.login === 'bob');
  assert.equal(alice.pending, 2);
  assert.equal(bob.workload, 20);
  assert.equal(alice.workload, 10);
});

test('ผู้เปิด PR ถูกตัดออกแม้จะ skill/ownership สูงสุด', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['GitNonta', 'alice'],
    cursor: 0,
    count: 1,
    exclude: ['gitnonta'],
    profiles: { GitNonta: { paths: ['scripts/**'], owns: ['scripts/**'] } },
    changes: { files: ['scripts/a.mjs'] },
  });

  assert.deepEqual(selected, ['alice']);
  assert.ok(!scored.some((item) => item.login.toLowerCase() === 'gitnonta'));
});

test('ทุกคนที่ถูกเลือกมีเหตุผลอธิบายครบทั้ง 4 องค์ประกอบ', () => {
  const { scored } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 0,
    count: 1,
    profiles: { bob: { paths: ['scripts/**'], owns: ['scripts/**'] } },
    changes: { files: ['scripts/a.mjs', 'scripts/b.mjs'] },
    history: [{ pull_request: 1, reviewers: ['alice'] }],
  });

  const bob = scored.find((item) => item.login === 'bob');
  assert.ok(Array.isArray(bob.reasons) && bob.reasons.length >= 4);
  assert.match(bob.summary, /ตรงกับงาน 2 จุด/);
  assert.match(bob.summary, /skill 40\/40/);
  assert.match(bob.summary, /ownership 30\/30/);
  assert.match(bob.summary, /workload 20\/20/);
  assert.match(bob.summary, /recency|\+10/);
  assert.match(bob.summary, /scripts\/a\.mjs/);
});

test('ไม่มีข้อมูลเลย -> เหตุผลบอกว่าไม่มีข้อมูลและยังไม่เคยรีวิว PR ล่าสุด', () => {
  const { scored } = selectReviewers({ reviewers: ['alice', 'bob'], cursor: 0, count: 1 });

  assert.match(scored[0].summary, /ไม่มีข้อมูลความถนัด/);
  assert.match(scored[0].summary, /ยังไม่ได้รีวิว PR ล่าสุด/);
});
