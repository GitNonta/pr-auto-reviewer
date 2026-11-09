import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HISTORY_LIMIT = 50;

export async function readState(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { cursor: 0, assignments: [] };
    throw err;
  }

  const parsed = JSON.parse(raw);
  return {
    cursor: Number.isInteger(parsed.cursor) && parsed.cursor >= 0 ? parsed.cursor : 0,
    assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
  };
}

export async function writeState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function nextState({ state, selected, nextCursor, pullNumber, author, mode, now = new Date() }) {
  const assignments = [
    ...state.assignments,
    {
      pull_request: pullNumber,
      author,
      reviewers: selected,
      mode,
      at: now.toISOString(),
    },
  ].slice(-HISTORY_LIMIT);

  return { cursor: nextCursor, assignments };
}

async function git(args, cwd) {
  return execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

/**
 * Commit the updated state file on the default branch and push it back.
 * A failed push is reported, never thrown: the PR check should stay green even when the
 * workflow token is read-only (for example on PRs opened from forks).
 */
export async function commitAndPushState({ statePath, branch, pullNumber, cwd = process.cwd() }) {
  const relative = resolve(cwd, statePath).slice(cwd.length + 1);
  const status = await git(['status', '--porcelain', '--', relative], cwd);
  if (status.stdout.trim() === '') return { committed: false, pushed: false };

  await git(['config', 'user.name', 'github-actions[bot]'], cwd);
  await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], cwd);
  await git(['add', '--', relative], cwd);
  await git(['commit', '-m', `chore(reviewer): round-robin state for PR #${pullNumber} [skip ci]`], cwd);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await git(['push', 'origin', `HEAD:${branch}`], cwd);
      return { committed: true, pushed: true, attempt };
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await git(['pull', '--rebase', '--autostash', 'origin', branch], cwd).catch(() => {});
      }
    }
  }

  return {
    committed: true,
    pushed: false,
    error: (lastError && (lastError.stderr || lastError.message)) || 'git push failed',
  };
}
