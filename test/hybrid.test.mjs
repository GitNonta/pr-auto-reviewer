import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SCORE, SCORE_WEIGHTS, selectReviewers } from '../scripts/lib/round-robin.mjs';

// สร้าง history แบบ state.assignments: หนึ่งรายการต่อหนึ่ง PR
function historyOf(...entries) {
  return entries.map((logins, index) => ({
    pull_request: index + 1,
    reviewers: Array.isArray(logins) ? logins : [logins],
  }));
}

test('น้ำหนักคะแนนคือ 40/30/20/10 และรวมเป็น 100', () => {
  assert.deepEqual({ ...SCORE_WEIGHTS }, { skill: 40, ownership: 30, workload: 20, recency: 10 });
  assert.equal(MAX_SCORE, 100);
});

test('ตัวอย่างจากโจทย์: PR แก้ Backend -> Bob 90 คะแนน (Alice 10, Charlie 30)', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['Alice', 'Bob', 'Charlie'],
    cursor: 0,
    count: 1,
    profiles: {
      // Bob ถนัดและเป็นเจ้าของ backend ทั้งหมด
      Bob: { paths: ['backend/**'], owns: ['backend/**'] },
      // Charlie ถนัด backend แค่ไฟล์เดียว ไม่ได้เป็นเจ้าของ
      Charlie: { paths: ['backend/api/users.js'] },
    },
    changes: {
      files: [
        'backend/api/users.js',
        'backend/api/orders.js',
        'backend/db/schema.sql',
        'backend/server.js',
      ],
    },
    // Alice มีงานรอรีวิว 2 งาน -> workload 20 - 5×2 = 10
    pending: { Alice: 2 },
    // ทุกคนเพิ่งรีวิว PR ล่าสุด -> ไม่มีใครได้ recency
    history: historyOf(['Alice', 'Bob', 'Charlie']),
  });

  const byLogin = Object.fromEntries(scored.map((item) => [item.login, item]));

  assert.equal(byLogin.Alice.skill, 0);
  assert.equal(byLogin.Alice.ownership, 0);
  assert.equal(byLogin.Alice.workload, 10);
  assert.equal(byLogin.Alice.score, 10);

  assert.equal(byLogin.Bob.skill, 40);
  assert.equal(byLogin.Bob.ownership, 30);
  assert.equal(byLogin.Bob.workload, 20);
  assert.equal(byLogin.Bob.score, 90);

  assert.equal(byLogin.Charlie.skill, 10);
  assert.equal(byLogin.Charlie.ownership, 0);
  assert.equal(byLogin.Charlie.workload, 20);
  assert.equal(byLogin.Charlie.score, 30);

  assert.deepEqual(selected, ['Bob']);
});

test('skill 40 คะแนน: คนถนัดตรงถูกเลือกแม้ cursor ชี้คนอื่น', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 0,
    count: 1,
    profiles: { bob: { paths: ['backend/**'] } },
    changes: { files: ['backend/a.js'] },
  });

  assert.deepEqual(selected, ['bob']);
  const bob = scored.find((item) => item.login === 'bob');
  const alice = scored.find((item) => item.login === 'alice');
  assert.equal(bob.skill, 40);
  assert.equal(bob.score, 70); // 40 skill + 20 workload + 10 recency
  assert.equal(alice.score, 30);
});

test('ownership 30 คะแนน: เป็นเจ้าของไฟล์ที่แก้ได้คะแนนแม้ไม่ได้ตั้ง paths', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 0,
    count: 1,
    profiles: { bob: { owns: ['scripts/**'] } },
    changes: { files: ['scripts/a.mjs'] },
  });

  assert.deepEqual(selected, ['bob']);
  const bob = scored.find((item) => item.login === 'bob');
  assert.equal(bob.ownedCount, 1);
  assert.equal(bob.ownership, 30);
  assert.equal(bob.score, 60); // 30 ownership + 20 workload + 10 recency
});

test('workload: งานค้างหัก 5 คะแนนต่องาน และไม่ติดลบ', () => {
  const { scored } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol'],
    cursor: 0,
    count: 1,
    pending: { alice: 2, bob: 5 },
  });

  const byLogin = Object.fromEntries(scored.map((item) => [item.login, item]));
  assert.equal(byLogin.alice.workload, 10);
  assert.equal(byLogin.bob.workload, 0); // 20 - 25 -> 0
  assert.equal(byLogin.carol.workload, 20);
});

test('recency 10 คะแนน: ยังไม่ได้รีวิว PR ล่าสุดได้แต้ม ใครเพิ่งรีวิวไม่ได้', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 0,
    count: 1,
    history: historyOf('alice'),
  });

  const byLogin = Object.fromEntries(scored.map((item) => [item.login, item]));
  assert.equal(byLogin.alice.reviewedLatest, true);
  assert.equal(byLogin.alice.recency, 0);
  assert.equal(byLogin.bob.recency, 10);
  assert.deepEqual(selected, ['bob']);
});

test('ไม่มีข้อมูลอะไรเลย -> คะแนนเท่ากัน 30 และใช้คิว round-robin ตัดสิน', () => {
  const { selected, scored, nextCursor } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol', 'dave'],
    cursor: 2,
    count: 1,
  });

  assert.deepEqual(selected, ['carol']);
  assert.equal(nextCursor, 3);
  assert.deepEqual(new Set(scored.map((item) => item.score)), new Set([30]));
});

test('scored เรียงตามลำดับที่ใช้เลือกจริง มีครบทุกองค์ประกอบ และไม่เกิน 100', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol'],
    cursor: 0,
    count: 2,
    profiles: { alice: { paths: ['docs/**'], owns: ['docs/**'] }, bob: { paths: ['scripts/**'] } },
    changes: { files: ['docs/a.md', 'scripts/b.mjs'] },
    pending: { carol: 1 },
  });

  assert.deepEqual(selected, scored.slice(0, 2).map((item) => item.login));
  for (const item of scored) {
    for (const field of ['skill', 'ownership', 'workload', 'recency', 'score']) {
      assert.equal(typeof item[field], 'number', `${item.login}.${field}`);
    }
    assert.ok(item.score <= MAX_SCORE);
    assert.ok(Array.isArray(item.reasons) || item.score >= 0);
  }
});
