import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, normalizeReviewers, selectReviewers } from '../scripts/lib/round-robin.mjs';

test('normalizeReviewers trims, validates and de-duplicates (case-insensitive)', () => {
  assert.deepEqual(normalizeReviewers([' Alice ', 'alice', 'bob-2']), ['Alice', 'bob-2']);
});

test('normalizeReviewers rejects an empty or invalid queue', () => {
  assert.throws(() => normalizeReviewers([]), ConfigError);
  assert.throws(() => normalizeReviewers('octocat'), ConfigError);
  assert.throws(() => normalizeReviewers(['-bad']), ConfigError);
  assert.throws(() => normalizeReviewers(['bad login']), ConfigError);
  assert.throws(() => normalizeReviewers([42]), ConfigError);
});

test('walks the queue in round-robin order and wraps around', () => {
  const reviewers = ['alice', 'bob', 'carol'];
  let cursor = 0;
  const picks = [];

  for (let i = 0; i < 5; i += 1) {
    const { selected, nextCursor } = selectReviewers({ reviewers, cursor, count: 1 });
    picks.push(selected[0]);
    cursor = nextCursor;
  }

  assert.deepEqual(picks, ['alice', 'bob', 'carol', 'alice', 'bob']);
});

test('skips the PR author while keeping the rotation order', () => {
  const reviewers = ['alice', 'bob', 'carol'];
  let cursor = 0;
  const picks = [];

  for (let i = 0; i < 4; i += 1) {
    const { selected, nextCursor } = selectReviewers({ reviewers, cursor, count: 1, exclude: ['bob'] });
    picks.push(selected[0]);
    cursor = nextCursor;
  }

  assert.deepEqual(picks, ['alice', 'carol', 'alice', 'carol']);
});

test('author exclusion is case-insensitive', () => {
  const { selected, nextCursor } = selectReviewers({
    reviewers: ['alice', 'Bob', 'carol'],
    cursor: 1,
    count: 1,
    exclude: ['bob'],
  });

  assert.deepEqual(selected, ['carol']);
  assert.equal(nextCursor, 0);
});

test('picks several distinct reviewers per PR and advances past the last one', () => {
  const reviewers = ['alice', 'bob', 'carol', 'dave'];

  const first = selectReviewers({ reviewers, cursor: 0, count: 2 });
  assert.deepEqual(first.selected, ['alice', 'bob']);
  assert.equal(first.nextCursor, 2);

  const second = selectReviewers({ reviewers, cursor: first.nextCursor, count: 2, exclude: ['carol'] });
  assert.deepEqual(second.selected, ['dave', 'alice']);
  assert.equal(second.nextCursor, 1);
});

test('returns fewer reviewers when the author reduces the eligible pool', () => {
  const { selected, nextCursor } = selectReviewers({
    reviewers: ['alice', 'bob', 'carol'],
    cursor: 0,
    count: 3,
    exclude: ['bob'],
  });

  assert.deepEqual(selected, ['alice', 'carol']);
  assert.equal(nextCursor, 0);
});

test('returns nobody and keeps the cursor when every candidate is excluded', () => {
  const { selected, nextCursor } = selectReviewers({
    reviewers: ['alice', 'bob'],
    cursor: 1,
    count: 1,
    exclude: ['alice', 'bob'],
  });

  assert.deepEqual(selected, []);
  assert.equal(nextCursor, 1);
});

test('handles an out-of-range cursor defensively', () => {
  const { selected, nextCursor } = selectReviewers({ reviewers: ['alice', 'bob'], cursor: 7, count: 1 });
  assert.deepEqual(selected, ['bob']);
  assert.equal(nextCursor, 0);
});
