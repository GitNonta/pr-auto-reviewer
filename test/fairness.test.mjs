import test from 'node:test';
import assert from 'node:assert/strict';

import { selectReviewers } from '../scripts/lib/round-robin.mjs';

// สร้าง history แบบ state.assignments: เรียงจากเก่าไปใหม่
function historyOf(...logins) {
  return logins.map((login, index) => ({
    pull_request: index + 1,
    reviewers: [login],
  }));
}

test('คนที่รีวิว PR ล่าสุดไม่ได้แต้ม recency จึงไม่ถูกเลือกซ้ำเมื่อมีคนอื่นว่าง', () => {
  const { selected, scored } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol'],
    cursor: 0,
    count: 1,
    history: historyOf('alice'),
  });

  assert.deepEqual(selected, ['bob']);
  assert.equal(scored.find((item) => item.login === 'alice').recency, 0);
});

test('recency เทียบชื่อแบบไม่สนตัวพิมพ์เล็ก/ใหญ่', () => {
  const { selected } = selectReviewers({
    reviewers: ['Alice', 'bob'],
    cursor: 0,
    count: 1,
    history: [{ reviewers: ['alice'] }],
  });

  assert.deepEqual(selected, ['bob']);
});

test('คะแนนเสมอ -> คิว round-robin ตัดสินตามตำแหน่ง cursor', () => {
  const { selected } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol'],
    cursor: 2,
    count: 1,
    history: historyOf('alice', 'bob'),
  });

  // bob คือคนที่รีวิว PR ล่าสุด (ได้ 20) ส่วน alice/carol ได้ 30 เท่ากัน -> คิวชี้ carol
  assert.deepEqual(selected, ['carol']);
});

test('ยังตัดผู้เปิด PR ออก และเลือกคนถัดไปที่ได้คะแนนดีสุด', () => {
  const { selected } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol'],
    cursor: 0,
    count: 1,
    exclude: ['bob'],
    history: historyOf('alice'),
  });

  assert.deepEqual(selected, ['carol']);
});

test('ทนต่อข้อมูล history ที่ผิดรูปแบบ', () => {
  const { selected } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 0,
    count: 1,
    history: [{}, { reviewers: ['ghost', 42, ''] }, { reviewers: null }],
  });

  assert.deepEqual(selected, ['alice']);
});

test('เลือกหลายคนแบบไม่ซ้ำ และคนที่รีวิว PR ล่าสุดไม่ติดโผ', () => {
  const { selected, nextCursor } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol', 'dave'],
    cursor: 0,
    count: 2,
    history: historyOf('alice', 'bob'),
  });

  assert.deepEqual(selected, ['alice', 'carol']);
  assert.equal(nextCursor, 3);
});

test('เหลือผู้มีสิทธิ์คนเดียว (author กินคิว) ก็ยังเลือกได้ ไม่ throw', () => {
  const history = Array.from({ length: 5 }, (_, index) => ({
    pull_request: index + 1,
    reviewers: ['Nontawatpkru17'],
  }));

  const { selected, nextCursor } = selectReviewers({
    reviewers: ['GitNonta', 'Nontawatpkru17'],
    cursor: 0,
    count: 1,
    exclude: ['GitNonta'],
    history,
  });

  assert.deepEqual(selected, ['Nontawatpkru17']);
  assert.equal(nextCursor, 0);
});

test('ไม่มี history = ทุกคนได้คะแนนเท่ากันและเดินคิวแบบ round-robin เดิม', () => {
  let cursor = 0;
  const picks = [];

  for (let index = 0; index < 4; index += 1) {
    const result = selectReviewers({
      reviewers: ['alice', 'bob', 'carol'],
      cursor,
      count: 1,
      exclude: ['carol'],
    });
    picks.push(result.selected[0]);
    cursor = result.nextCursor;
  }

  assert.deepEqual(picks, ['alice', 'bob', 'alice', 'bob']);
  assert.equal(cursor, 2);
});

test('nextCursor ยังเลื่อนไปหลังตำแหน่งที่เลือก', () => {
  const { selected, nextCursor } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol'],
    cursor: 0,
    count: 1,
  });

  assert.deepEqual(selected, ['alice']);
  assert.equal(nextCursor, 1);
});
