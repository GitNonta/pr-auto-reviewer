import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../scripts/auto-assign-reviewer.mjs';

const REPO = 'GitNonta/demo';

// mock GitHub API: ตอบ request review/comment และข้อมูลประกอบ (ไฟล์/label/PR ที่เปิดอยู่)
async function startMock({
  rejectReviewers = false,
  files = [],
  labels = [],
  openPulls = [],
  breakEnrichment = false,
  teams = {},
  breakTeams = false,
} = {}) {
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

      // ข้อมูลประกอบของ PR (ใช้คิดคะแนน fit/load)
      if (req.method === 'GET') {
        if (breakEnrichment) {
          res.writeHead(500);
          res.end(JSON.stringify({ message: 'enrichment unavailable' }));
          return;
        }
        if (req.url.startsWith('/orgs/')) {
          if (breakTeams) {
            res.writeHead(403);
            res.end(JSON.stringify({ message: 'Resource not accessible by integration' }));
            return;
          }
          const match = req.url.match(/^\/orgs\/([^/]+)\/teams\/([^/?]+)/);
          const key = match ? `${match[1]}/${match[2]}`.toLowerCase() : '';
          const members = teams[key] ?? [];
          res.writeHead(200);
          res.end(JSON.stringify(members.map((login) => ({ login }))));
          return;
        }
        if (req.url.includes('/files')) {
          res.writeHead(200);
          res.end(JSON.stringify(files.map((filename) => ({ filename }))));
          return;
        }
        if (req.url.includes('?')) {
          res.writeHead(200);
          res.end(JSON.stringify(openPulls));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ labels: labels.map((name) => ({ name })) }));
        return;
      }

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
    posts: () => calls.filter((call) => call.method === 'POST'),
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function workspace({ reviewers, count = 1, state, tagFallback = true, profiles, codeownersText }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'auto-reviewer-'));
  await mkdir(path.join(dir, '.github'), { recursive: true });
  if (codeownersText) {
    await writeFile(path.join(dir, '.github', 'CODEOWNERS'), codeownersText, 'utf8');
  }
  await writeFile(
    path.join(dir, '.github', 'auto-assign-reviewers.json'),
    JSON.stringify(
      {
        reviewers,
        number_of_reviewers: count,
        state_path: '.github/reviewers-state.json',
        tag_fallback: tagFallback,
        ...(profiles ? { reviewer_profiles: profiles } : {}),
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
    const posts = mock.posts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/repos/${REPO}/pulls/1/requested_reviewers`);
    assert.deepEqual(posts[0].body, { reviewers: ['octocat'] });
    assert.equal(posts[0].auth, 'Bearer test-token');

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

    const posts = mock.posts();
    assert.deepEqual(posts[0].body.reviewers, ['alice', 'bob']);
    assert.deepEqual(posts[1].body.reviewers, ['carol', 'alice']);
    assert.equal(new Set(posts[1].body.reviewers).size, 2);
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
    // ไม่เหลือใครให้เลือก -> ไม่ต้องเรียก API เลย
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
    const posts = mock.posts();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].url, `/repos/${REPO}/issues/5/comments`);
    assert.match(posts[1].body.body, /@octocat/);
    assert.match(posts[1].body.body, /Round-Robin/);
    assert.match(posts[1].body.body, /ทำไมเลือก reviewer/);
    assert.match(posts[1].body.body, /collaborator/);

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

test('picks the reviewer whose skills match the changed files and logs the reason', async () => {
  const mock = await startMock({ files: ['scripts/lib/scoring.mjs', 'scripts/auto-assign-reviewer.mjs'], labels: ['infra'] });
  try {
    const dir = await workspace({
      reviewers: ['octocat', 'hubot', 'GitNonta'],
      profiles: {
        octocat: { paths: ['docs/**'] },
        hubot: { paths: ['scripts/**'], labels: ['infra'], owns: ['scripts/**'] },
      },
    });
    const logs = [];

    const result = await run({
      env: envFor(mock, 9, 'GitNonta'),
      cwd: dir,
      log: (line) => logs.push(line),
      warn: () => {},
    });

    assert.deepEqual(result.selected, ['hubot']);
    assert.ok(logs.some((line) => line.includes('skill 40') && line.includes('ownership 30')));

    // ยืนยันว่า client ถูกใช้จริง: ดึงไฟล์ที่เปลี่ยน + PR ที่เปิดอยู่ ก่อนเลือก reviewer
    const getUrls = mock.calls.filter((call) => call.method === 'GET').map((call) => call.url);
    assert.ok(getUrls.some((url) => url.includes('/files?per_page=100')), 'ต้องดึงไฟล์ที่เปลี่ยน');
    assert.ok(getUrls.some((url) => url.includes('state=open')), 'ต้องดึงรายการ PR ที่เปิดอยู่');
    assert.ok(
      logs.some((line) => line.includes('context:') && line.includes('2 changed files')),
      'ต้อง log ข้อมูลประกอบที่ดึงมา',
    );
    assert.ok(logs.some((line) => line.includes('why hubot:') && line.includes('ตรงกับงาน')));
  } finally {
    await mock.close();
  }
});

test('keeps assigning when the enrichment APIs fail (fallback to queue)', async () => {
  const mock = await startMock({ breakEnrichment: true });
  try {
    const dir = await workspace({
      reviewers: ['octocat', 'hubot'],
      profiles: { hubot: { paths: ['scripts/**'] } },
    });
    const warnings = [];

    const result = await run({
      env: envFor(mock, 10, 'GitNonta'),
      cwd: dir,
      log: () => {},
      warn: (line) => warnings.push(line),
    });

    assert.deepEqual(result.selected, ['octocat']);
    assert.ok(warnings.some((line) => line.includes('could not load changed files')));
    assert.equal((await readState(dir)).assignments.length, 1);
  } finally {
    await mock.close();
  }
});

test('counts pending review requests as load so busy reviewers are skipped', async () => {
  const mock = await startMock({
    openPulls: [{ number: 100, requested_reviewers: [{ login: 'octocat' }, { login: 'octocat' }] }],
  });
  try {
    const dir = await workspace({ reviewers: ['octocat', 'hubot'] });

    const result = await run({ env: envFor(mock, 11, 'GitNonta'), cwd: dir, ...quiet });

    assert.deepEqual(result.selected, ['hubot']);
  } finally {
    await mock.close();
  }
});

test('ให้คะแนน ownership จาก .github/CODEOWNERS แม้ config ไม่ได้ตั้ง owns', async () => {
  const mock = await startMock({ files: ['backend/api/users.js', 'backend/db/schema.sql', 'docs/readme.md'] });
  try {
    const dir = await workspace({
      reviewers: ['octocat', 'hubot'],
      codeownersText: ['backend/ @hubot', 'docs/ @octocat'].join('\n'),
    });
    const logs = [];

    const result = await run({
      env: envFor(mock, 12, 'GitNonta'),
      cwd: dir,
      log: (line) => logs.push(line),
      warn: () => {},
    });

    // hubot เป็นเจ้าของ 2 ไฟล์ (octocat 1) -> ownership 30 : 15
    assert.deepEqual(result.selected, ['hubot']);
    assert.ok(logs.some((line) => line.includes('ownership 30') && line.includes('CODEOWNERS')));
  } finally {
    await mock.close();
  }
});

test('ขยาย @org/team จาก Teams API เพื่อให้สมาชิกทีมได้คะแนน ownership', async () => {
  const mock = await startMock({
    files: ['backend/api/users.js'],
    teams: { 'acme/core': ['hubot'] },
  });
  try {
    const dir = await workspace({
      reviewers: ['octocat', 'hubot'],
      codeownersText: ['backend/ @acme/core'].join('\n'),
    });
    const logs = [];

    const result = await run({
      env: envFor(mock, 14, 'GitNonta'),
      cwd: dir,
      log: (line) => logs.push(line),
      warn: () => {},
    });

    assert.deepEqual(result.selected, ['hubot']);
    assert.ok(logs.some((line) => line.includes('ownership 30') && line.includes('CODEOWNERS')));
  } finally {
    await mock.close();
  }
});

test('อ่านสมาชิกทีมไม่ได้ -> warn แล้ว fallback ไป owns โดยไม่ล้ม job', async () => {
  const mock = await startMock({ files: ['backend/a.js'], breakTeams: true });
  try {
    const dir = await workspace({
      reviewers: ['octocat', 'hubot'],
      profiles: { hubot: { owns: ['backend/**'] } },
      codeownersText: ['* @acme/core'].join('\n'),
    });
    const warnings = [];

    const result = await run({
      env: envFor(mock, 15, 'GitNonta'),
      cwd: dir,
      log: () => {},
      warn: (line) => warnings.push(line),
    });

    assert.deepEqual(result.selected, ['hubot']);
    assert.ok(warnings.some((line) => line.includes('could not expand team @acme/core')));
  } finally {
    await mock.close();
  }
});

test('CODEOWNERS ที่มีแต่ทีม -> ownership fallback ไป owns ใน config', async () => {
  const mock = await startMock({ files: ['backend/a.js'] });
  try {
    const dir = await workspace({
      reviewers: ['octocat', 'hubot'],
      profiles: { hubot: { owns: ['backend/**'] } },
      codeownersText: ['* @org/core'].join('\n'),
    });

    const result = await run({ env: envFor(mock, 13, 'GitNonta'), cwd: dir, ...quiet });

    assert.deepEqual(result.selected, ['hubot']);
  } finally {
    await mock.close();
  }
});

test('integration: ข้อมูลจริงจาก GitHub API ให้ Bob 100 คะแนนเต็ม', async () => {
  const mock = await startMock({ files: ['backend/api/users.js'] });
  try {
    const dir = await workspace({
      reviewers: ['Nontawatpkru17', 'Bob'],
      profiles: { Bob: { paths: ['backend/**'], owns: ['backend/**'] } },
      codeownersText: 'backend/ @Bob',
      // PR ล่าสุดถูกรีวิวโดย Nontawatpkru17 -> Bob ยังไม่ได้รีวิว PR ล่าสุด
      state: {
        cursor: 0,
        assignments: [
          { pull_request: 31, author: 'GitNonta', reviewers: ['Nontawatpkru17'], mode: 'requested' },
        ],
      },
    });
    const logs = [];

    const result = await run({
      env: envFor(mock, 16, 'GitNonta'),
      cwd: dir,
      log: (line) => logs.push(line),
      warn: () => {},
    });

    assert.deepEqual(result.selected, ['Bob']);
    assert.ok(logs.some((line) => line.includes('score 100/100')), 'log ต้องแสดง 100/100');
    assert.ok(logs.some((line) => line.includes('context: 1 changed files')));
    assert.deepEqual(mock.posts().at(-1).body, { reviewers: ['Bob'] });
  } finally {
    await mock.close();
  }
});

test('integration: ผู้เปิด PR ได้คะแนนสูงสุดก็ยังถูกกันออก', async () => {
  const mock = await startMock({ files: ['backend/api/users.js'] });
  try {
    const dir = await workspace({
      reviewers: ['GitNonta', 'Bob'],
      profiles: {
        GitNonta: { paths: ['backend/**'], owns: ['backend/**'] },
        Bob: { paths: ['backend/**'] },
      },
      codeownersText: 'backend/ @GitNonta',
    });
    const logs = [];

    const result = await run({
      env: envFor(mock, 17, 'GitNonta'),
      cwd: dir,
      log: (line) => logs.push(line),
      warn: () => {},
    });

    assert.deepEqual(result.selected, ['Bob']);
    assert.deepEqual(mock.posts().at(-1).body, { reviewers: ['Bob'] });
    assert.ok(!logs.some((line) => line.includes('why GitNonta')));
  } finally {
    await mock.close();
  }
});

test('integration: คะแนนเท่ากันและไม่มีข้อมูลความถนัด -> คิว round-robin ตัดสิน', async () => {
  const mock = await startMock({ files: ['src/app.ts'] });
  try {
    const dir = await workspace({ reviewers: ['alice', 'bob'], state: { cursor: 1, assignments: [] } });

    const result = await run({ env: envFor(mock, 18, 'carol'), cwd: dir, ...quiet });

    assert.deepEqual(result.selected, ['bob']);
    assert.equal((await readState(dir)).cursor, 0);
  } finally {
    await mock.close();
  }
});
