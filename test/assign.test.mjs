import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../scripts/auto-assign-reviewer.mjs';

const REPO = 'GitNonta/demo';

async function startMock({ rejectReviewers = false } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');

      if (req.url.endsWith('/requested_reviewers')) {
        if (rejectReviewers) {
          res.writeHead(422);
          res.end(JSON.stringify({ message: 'Reviews may only be requested from collaborators.' }));
          return;
        }
        res.writeHead(201);
        res.end(JSON.stringify({ requested_reviewers: (body?.reviewers ?? []).map((login) => ({ login })) }));
        return;
      }

      res.writeHead(201);
      res.end(JSON.stringify({ id: 1 }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function workspace({ reviewers, count = 1, state, tagFallback = true }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'auto-reviewer-'));
  await mkdir(path.join(dir, '.github'), { recursive: true });
  await writeFile(
    path.join(dir, '.github', 'auto-assign-reviewers.json'),
    JSON.stringify(
      {
        reviewers,
        number_of_reviewers: count,
        state_path: '.github/reviewers-state.json',
        tag_fallback: tagFallback,
      },
      null,
      2,
    ),
    'utf8',
  );
  if (state) {
    await writeFile(path.join(dir, '.github', 'reviewers-state.json'), JSON.stringify(state), 'utf8');
  }
  return dir;
}

async function readState(dir) {
  return JSON.parse(await readFile(path.join(dir, '.github', 'reviewers-state.json'), 'utf8'));
}

function envFor(mock, prNumber, author) {
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_TOKEN: 'test-token',
    GITHUB_API_BASE_URL: mock.baseUrl,
    PR_NUMBER: String(prNumber),
    PR_AUTHOR: author,
  };
}

const quiet = { log: () => {}, warn: () => {} };

test('requests the next reviewer in the queue and persists the cursor', async () => {
  const mock = await startMock();
  try {
    const dir = await workspace({ reviewers: ['octocat', 'hubot', 'GitNonta'] });

    const result = await run({ env: envFor(mock, 1, 'GitNonta'), cwd: dir, ...quiet });

    assert.deepEqual(result, { selected: ['octocat'], nextCursor: 1, mode: 'requested' });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].method, 'POST');
    assert.equal(mock.calls[0].url, `/repos/${REPO}/pulls/1/requested_reviewers`);
    assert.deepEqual(mock.calls[0].body, { reviewers: ['octocat'] });
    assert.equal(mock.calls[0].auth, 'Bearer test-token');

    const state = await readState(dir);
    assert.equal(state.cursor, 1);
    assert.equal(state.assignments.length, 1);
    assert.equal(state.assignments[0].mode, 'requested');
    assert.deepEqual(state.assignments[0].reviewers, ['octocat']);
  } finally {
    await mock.close();
  }
});

test('rotates across consecutive PRs and never requests the author', async () => {
  const mock = await startMock();
  try {
    const dir = await workspace({ reviewers: ['octocat', 'hubot', 'GitNonta'] });
    const requested = [];

    for (const prNumber of [1, 2, 3, 4]) {
      const result = await run({ env: envFor(mock, prNumber, 'GitNonta'), cwd: dir, ...quiet });
      requested.push(...result.selected);
    }

    assert.deepEqual(requested, ['octocat', 'hubot', 'octocat', 'hubot']);
    assert.ok(requested.every((login) => login.toLowerCase() !== 'gitnonta'));
    assert.equal((await readState(dir)).assignments.length, 4);
  } finally {
    await mock.close();
  }
});

test('assigns multiple reviewers per PR without duplicates', async () => {
  const mock = await startMock();
  try {
    const dir = await workspace({ reviewers: ['alice', 'bob', 'carol'], count: 2 });

    await run({ env: envFor(mock, 7, 'dave'), cwd: dir, ...quiet });
    await run({ env: envFor(mock, 8, 'dave'), cwd: dir, ...quiet });

    assert.deepEqual(mock.calls[0].body.reviewers, ['alice', 'bob']);
    assert.deepEqual(mock.calls[1].body.reviewers, ['carol', 'alice']);
    assert.equal(new Set(mock.calls[1].body.reviewers).size, 2);
  } finally {
    await mock.close();
  }
});

test('does nothing when the author is the only configured reviewer', async () => {
  const mock = await startMock();
  try {
    const dir = await workspace({ reviewers: ['GitNonta'] });

    const result = await run({ env: envFor(mock, 3, 'gitnonta'), cwd: dir, ...quiet });

    assert.deepEqual(result, { selected: [], nextCursor: 0, mode: 'skipped' });
    assert.equal(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});

test('falls back to tagging in a comment when the reviewer cannot be requested', async () => {
  const mock = await startMock({ rejectReviewers: true });
  try {
    const dir = await workspace({ reviewers: ['octocat', 'hubot'] });

    const result = await run({ env: envFor(mock, 5, 'GitNonta'), cwd: dir, ...quiet });

    assert.deepEqual(result, { selected: ['octocat'], nextCursor: 1, mode: 'tagged' });
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].url, `/repos/${REPO}/issues/5/comments`);
    assert.match(mock.calls[1].body.body, /@octocat/);
    assert.match(mock.calls[1].body.body, /Round-Robin/);
    assert.match(mock.calls[1].body.body, /collaborator/);

    const state = await readState(dir);
    assert.equal(state.cursor, 1);
    assert.equal(state.assignments[0].mode, 'tagged');
  } finally {
    await mock.close();
  }
});

test('surfaces the GitHub error when the tag fallback is disabled', async () => {
  const mock = await startMock({ rejectReviewers: true });
  try {
    const dir = await workspace({ reviewers: ['octocat', 'hubot'], tagFallback: false });

    await assert.rejects(
      () => run({ env: envFor(mock, 6, 'GitNonta'), cwd: dir, ...quiet }),
      /422/,
    );
    await assert.rejects(() => readState(dir), /ENOENT/);
  } finally {
    await mock.close();
  }
});
