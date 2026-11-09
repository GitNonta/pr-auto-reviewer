/**
 * Round-robin reviewer selection — no I/O, no GitHub calls, fully deterministic.
 */

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// GitHub login rules: alphanumeric or single hyphens, cannot start/end with a hyphen, max 39 chars.
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

/** Trim, validate and de-duplicate (case-insensitive) the configured reviewer queue. */
export function normalizeReviewers(reviewers) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new ConfigError('config.reviewers must be a non-empty array of GitHub logins');
  }

  const seen = new Set();
  const result = [];

  for (const value of reviewers) {
    if (typeof value !== 'string') {
      throw new ConfigError(`invalid GitHub login in config.reviewers: ${JSON.stringify(value)}`);
    }
    const login = value.trim();
    if (!LOGIN_RE.test(login)) {
      throw new ConfigError(`invalid GitHub login in config.reviewers: ${JSON.stringify(value)}`);
    }
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(login);
  }

  if (result.length === 0) {
    throw new ConfigError('config.reviewers must contain at least one login');
  }

  return result;
}

/**
 * Pick reviewers starting at `cursor`, walking the ordered queue and wrapping around.
 * Logins in `exclude` (case-insensitive) are skipped — this is what keeps a PR author
 * from reviewing their own PR.
 *
 * Returns `{ selected, nextCursor }`. When nobody is eligible, `selected` is empty and the
 * cursor is left untouched so the queue position is not lost.
 */
export function selectReviewers({ reviewers, cursor = 0, count = 1, exclude = [] }) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new ConfigError('reviewers must be a non-empty array');
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ConfigError('count must be a positive integer');
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new ConfigError('cursor must be a non-negative integer');
  }

  const excluded = new Set(
    (Array.isArray(exclude) ? exclude : [])
      .filter((login) => typeof login === 'string' && login.trim() !== '')
      .map((login) => login.trim().toLowerCase()),
  );

  const n = reviewers.length;
  const start = cursor % n;
  let index = start;
  let lastPicked = -1;
  const selected = [];

  for (let step = 0; step < n && selected.length < count; step += 1) {
    const login = reviewers[index];
    if (!excluded.has(login.toLowerCase())) {
      selected.push(login);
      lastPicked = index;
    }
    index = (index + 1) % n;
  }

  return {
    selected,
    nextCursor: lastPicked === -1 ? start : (lastPicked + 1) % n,
  };
}
