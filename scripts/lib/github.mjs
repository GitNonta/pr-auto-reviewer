export class GitHubError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export function createGitHubClient({ token, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('GITHUB_TOKEN is required');

  const base = baseUrl.replace(/\/+$/, '');

  async function request(method, path, payload) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pr-auto-reviewer',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const message = (data && data.message) || response.statusText || 'unknown error';
      throw new GitHubError(`${method} ${path} failed (${response.status}): ${message}`, {
        status: response.status,
        body: data,
      });
    }

    return data;
  }

  return {
    requestReviewers(repository, pullNumber, reviewers) {
      return request('POST', `/repos/${repository}/pulls/${pullNumber}/requested_reviewers`, { reviewers });
    },
    comment(repository, pullNumber, body) {
      return request('POST', `/repos/${repository}/issues/${pullNumber}/comments`, { body });
    },
    getPull(repository, pullNumber) {
      return request('GET', `/repos/${repository}/pulls/${pullNumber}`);
    },
  };
}
