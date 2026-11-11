import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SCORE, selectReviewers } from '../scripts/lib/round-robin.mjs';

/**
 * Unit tests ตามข้อกำหนดของ Hybrid Scoring Engine
 * ทุกเทสต์ใช้ selectReviewers ตรง ๆ (ไม่มี I/O) เพื่อยืนยันสูตร 100 คะแนน
 */

test('คนเชี่ยวชาญตรงกับงาน + เป็นเจ้าของ + ว่าง + ยังไม่รีวิว PR ล่าสุด -> 100 คะแนนเต็ม', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['Nontawatpkru17', 'Bob'],
    cursor: 0,
    count: 1,
    profiles: {
      Bob: { paths: ['backend/**'], owns: ['backend/**'] },
      Nontawatpkru17: { paths: ['frontend/**'] },
    },
    changes: { files: ['backend/api/users.js'] },
    // PR ล่าสุดถูกรีวิวโดย Nontawatpkru17 -> Bob ได้ recency
    history: [{ pull_request: 31, reviewers: ['Nontawatpkru17'] }],
    codeowners: 'backend/ @Bob',
  });

  const bob = scored.find((item) => item.login === 'Bob');

  assert.equal(bob.skill, 40);
  assert.equal(bob.ownership, 30);
  assert.equal(bob.workload, 20);
  assert.equal(bob.recency, 10);
  assert.equal(bob.score, 100);
  assert.equal(bob.score, MAX_SCORE);
  assert.deepEqual(selected, ['Bob']);

  // เหตุผลต้องบอกครบทั้ง 4 องค์ประกอบ
  assert.match(bob.summary, /skill 40\/40/);
  assert.match(bob.summary, /ownership 30\/30/);
  assert.match(bob.summary, /workload 20\/20/);
  assert.match(bob.summary, /\+10/);
});

test('คนมีงานค้างถูกหัก workload 5 คะแนนต่องาน และแพ้คนที่งานน้อยกว่า', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['Alice', 'Bob'],
    cursor: 0,
    count: 1,
    pending: { Alice: 3 },
  });

  const alice = scored.find((item) => item.login === 'Alice');
  const bob = scored.find((item) => item.login === 'Bob');

  assert.equal(alice.pending, 3);
  assert.equal(alice.workload, 5); // 20 - 5×3
  assert.equal(bob.workload, 20);
  assert.equal(bob.score - alice.score, 15);
  assert.deepEqual(selected, ['Bob']);
  // summary มีเฉพาะคนที่ถูกเลือก (Bob) — alice ตรวจจากคะแนนโดยตรง
  assert.match(bob.summary, /ไม่มีงานรอรีวิว/);
  assert.equal(alice.pending, 3);
});

test('คะแนนเท่ากันทุกอย่าง -> Round-Robin ตัดสินตามตำแหน่ง cursor', () => {
  const { selected, nextCursor, scored } = selectReviewers({
    reviewers: ['Alice', 'Bob', 'Charlie'],
    cursor: 1,
    count: 1,
  });

  assert.deepEqual(selected, ['Bob']);
  assert.equal(nextCursor, 2);
  assert.deepEqual(new Set(scored.map((item) => item.score)), new Set([30]));
});

test('ผู้เปิด PR ถูกตัดสิทธิ์แม้จะได้คะแนนสูงสุด', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['GitNonta', 'Bob'],
    cursor: 0,
    count: 1,
    exclude: ['gitnonta'],
    profiles: {
      GitNonta: { paths: ['backend/**'], owns: ['backend/**'] },
      Bob: { paths: ['backend/**'] },
    },
    changes: { files: ['backend/api/users.js'] },
    codeowners: 'backend/ @GitNonta',
  });

  assert.ok(!scored.some((item) => item.login.toLowerCase() === 'gitnonta'));
  assert.deepEqual(selected, ['Bob']);
});

test('ไม่มี Reviewer ที่เหมาะสม -> selected ว่าง และ cursor ไม่ถูกเลื่อน', () => {
  const { selected, nextCursor, scored } = selectReviewers({
    reviewers: ['GitNonta', 'Alice'],
    cursor: 1,
    count: 1,
    exclude: ['GitNonta', 'alice'],
  });

  assert.deepEqual(selected, []);
  assert.deepEqual(scored, []);
  assert.equal(nextCursor, 1); // คงตำแหน่งคิวเดิมไว้
});
