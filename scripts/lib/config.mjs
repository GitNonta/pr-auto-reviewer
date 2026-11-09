import { readFile } from 'node:fs/promises';
import { ConfigError, normalizeReviewers } from './round-robin.mjs';

export const DEFAULT_CONFIG_PATH = '.github/auto-assign-reviewers.json';
export const DEFAULT_STATE_PATH = '.github/reviewers-state.json';

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config at ${configPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config at ${configPath} is not valid JSON: ${err.message}`);
  }

  const reviewers = normalizeReviewers(parsed.reviewers);
  const count = parsed.number_of_reviewers ?? 1;

  if (!Number.isInteger(count) || count < 1 || count > reviewers.length) {
    throw new ConfigError(
      `number_of_reviewers must be an integer between 1 and ${reviewers.length} (the size of config.reviewers)`,
    );
  }

  const statePath =
    typeof parsed.state_path === 'string' && parsed.state_path.trim() !== ''
      ? parsed.state_path.trim()
      : DEFAULT_STATE_PATH;

  return {
    reviewers,
    count,
    statePath,
    tagFallback: parsed.tag_fallback !== false,
  };
}
