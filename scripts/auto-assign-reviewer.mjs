#!/usr/bin/env node
/**
 * Entrypoint used by .github/workflows/auto-assign-reviewer.yml.
 *
 * Flow: read config + state -> pick the next reviewer(s) in round-robin order (skipping the
 * PR author) -> request the review -> persist the advanced queue position back to git.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadConfig, DEFAULT_CONFIG_PATH } from './lib/config.mjs';
import { ConfigError, selectReviewers } from './lib/round-robin.mjs';
import { createGitHubClient, GitHubError } from './lib/github.mjs';
import { readState, writeState, nextState, commitAndPushState } from './lib/state.mjs';

function buildTagComment({ selected, author, error }) {
  const mentions = selected.map((login) => `@${login}`).join(' ');
  return [
    '## 🤖 Auto-assigned reviewer (round-robin)',
    '',
    `${mentions} — PR นี้ถึงคิวของคุณแล้ว (จัดคิวแบบ Round-Robin)`,
    '',
    `ผู้เปิด PR (\`${author}\`) จะไม่ถูกเลือกเป็น Reviewer ของตัวเอง`,
    '',
    '<details><summary>ทำไมต้องแท็กแทนการ request review</summary>',
    '',
    '```',
    error,
    '```',
    '',
    '> GitHub อนุญาตให้ request review เฉพาะ collaborator ของ repository เท่านั้น',
    '> เมื่อเพิ่มบัญชีนี้เป็น collaborator แล้ว ระบบจะ assign ผ่าน reviewer slot ปกติในรอบถัดไป',
    '</details>',
  ].join('\n');
}

export async function run({ env = process.env, cwd = process.cwd(), api = null, log = console.log, warn = console.warn } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const pullNumber = Number(env.PR_NUMBER);
  const author = env.PR_AUTHOR || '';

  if (!repository || !Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('GITHUB_REPOSITORY and a numeric PR_NUMBER are required');
  }

  const configPath = path.resolve(cwd, env.CONFIG_PATH || DEFAULT_CONFIG_PATH);
  const config = await loadConfig(configPath);
  const statePath = path.resolve(cwd, config.statePath);
  const state = await readState(statePath);

  const { selected, nextCursor } = selectReviewers({
    reviewers: config.reviewers,
    cursor: state.cursor,
    count: config.count,
    exclude: [author],
  });

  if (selected.length === 0) {
    warn(
      `[auto-reviewer] PR #${pullNumber}: no eligible reviewer (every candidate is the PR author "${author}"); nothing to assign.`,
    );
    return { selected: [], nextCursor: state.cursor, mode: 'skipped' };
  }

  log(
    `[auto-reviewer] PR #${pullNumber} by "${author}": round-robin picked [${selected.join(', ')}] (cursor ${state.cursor} -> ${nextCursor})`,
  );

  const client =
    api ??
    createGitHubClient({
      token: env.GITHUB_TOKEN,
      baseUrl: env.GITHUB_API_BASE_URL || 'https://api.github.com',
    });

  let mode = 'requested';

  try {
    await client.requestReviewers(repository, pullNumber, selected);
    log(`[auto-reviewer] requested review from [${selected.join(', ')}]`);
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    if (!config.tagFallback) throw err;

    mode = 'tagged';
    warn(`[auto-reviewer] ${err.message}`);
    warn('[auto-reviewer] falling back to tagging the reviewer in a PR comment.');

    await client.comment(
      repository,
      pullNumber,
      buildTagComment({ selected, author, error: err.message }),
    );
  }

  const updated = nextState({
    state,
    selected,
    nextCursor,
    pullNumber,
    author,
    mode,
  });
  await writeState(statePath, updated);

  if (env.GITHUB_ACTIONS === 'true') {
    const result = await commitAndPushState({
      statePath,
      branch: env.DEFAULT_BRANCH || 'main',
      pullNumber,
      cwd,
    });
    if (!result.pushed) {
      warn(`[auto-reviewer] state update was not pushed: ${result.error || 'nothing to push'}`);
    }
  }

  return { selected, nextCursor, mode };
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      const prefix = err instanceof ConfigError ? 'config error' : 'error';
      console.error(`[auto-reviewer] ${prefix}: ${err.message}`);
      process.exit(1);
    });
}
