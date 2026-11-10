import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../scripts/lib/config.mjs';
import { ConfigError } from '../scripts/lib/round-robin.mjs';

async function writeConfig(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), 'auto-reviewer-config-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
}

test('applies defaults for count, state path and tag fallback', async () => {
  const file = await writeConfig({ reviewers: ['octocat', 'hubot'] });
  assert.deepEqual(await loadConfig(file), {
    reviewers: ['octocat', 'hubot'],
    count: 1,
    statePath: '.github/reviewers-state.json',
    codeownersPath: null,
    tagFallback: true,
    profiles: {},
  });
});

test('reads number_of_reviewers, state_path and tag_fallback', async () => {
  const file = await writeConfig({
    reviewers: ['octocat', 'hubot'],
    number_of_reviewers: 2,
    state_path: 'state/queue.json',
    tag_fallback: false,
  });
  assert.deepEqual(await loadConfig(file), {
    reviewers: ['octocat', 'hubot'],
    count: 2,
    statePath: 'state/queue.json',
    codeownersPath: null,
    tagFallback: false,
    profiles: {},
  });
});

test('reads codeowners_path when provided', async () => {
  const file = await writeConfig({
    reviewers: ['octocat'],
    codeowners_path: 'docs/CODEOWNERS',
  });

  assert.equal((await loadConfig(file)).codeownersPath, 'docs/CODEOWNERS');
});

test('reads reviewer_profiles and ignores logins outside the queue', async () => {
  const file = await writeConfig({
    reviewers: ['octocat', 'hubot'],
    reviewer_profiles: {
      Octocat: { paths: ['frontend/**'], labels: ['frontend'], owns: ['frontend/src/**'] },
      ghost: { paths: ['anything/**'] },
    },
  });

  const config = await loadConfig(file);
  assert.deepEqual(config.profiles, {
    octocat: { paths: ['frontend/**'], labels: ['frontend'], owns: ['frontend/src/**'] },
  });
});

test('rejects malformed reviewer_profiles', async () => {
  const invalidType = await writeConfig({ reviewers: ['octocat'], reviewer_profiles: ['nope'] });
  await assert.rejects(() => loadConfig(invalidType), ConfigError);

  const invalidPaths = await writeConfig({
    reviewers: ['octocat'],
    reviewer_profiles: { octocat: { paths: 'frontend/**' } },
  });
  await assert.rejects(() => loadConfig(invalidPaths), ConfigError);
});

test('rejects a reviewer count larger than the queue', async () => {
  const file = await writeConfig({ reviewers: ['octocat'], number_of_reviewers: 2 });
  await assert.rejects(() => loadConfig(file), ConfigError);
});

test('rejects malformed JSON and missing config files', async () => {
  const broken = await writeConfig('{ nope');
  await assert.rejects(() => loadConfig(broken), ConfigError);

  const dir = await mkdtemp(path.join(tmpdir(), 'auto-reviewer-missing-'));
  await mkdir(dir, { recursive: true });
  await assert.rejects(() => loadConfig(path.join(dir, 'absent.json')), ConfigError);
});
