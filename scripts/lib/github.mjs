/** error ที่เกิดจากการเรียก GitHub API (แนบ status และ body มาด้วย) */
export class GitHubError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

/**
 * สร้าง client บาง ๆ ครอบ GitHub REST API
 * - token: GITHUB_TOKEN ที่ workflow ส่งเข้ามา
 * - baseUrl: เปลี่ยนได้ใน test/env (เช่น GitHub Enterprise)
 * - fetchImpl: ใส่ fetch จำลองได้ใน test
 */
export function createGitHubClient({ token, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('GITHUB_TOKEN is required');

  // ตัด slash ท้าย base URL เพื่อไม่ให้ path ต่อกันแล้วมี // เกินมา
  const base = baseUrl.replace(/\/+$/, '');

  // เรียก API ทั่วไป: แปลง payload เป็น JSON และแปลง error ให้เป็น GitHubError
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
    // พยายาม parse เป็น JSON ถ้าไม่ใช่ (เช่น plain text) ก็เก็บข้อความดิบไว้
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    // response ที่ไม่ใช่ 2xx ถือว่า error พร้อมแนบ status/body ให้ผู้เรียกตัดสินใจ
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
    // ขอให้ reviewer ที่เลือกไว้มาช่วยรีวิว PR
    requestReviewers(repository, pullNumber, reviewers) {
      return request('POST', `/repos/${repository}/pulls/${pullNumber}/requested_reviewers`, { reviewers });
    },
    // คอมเมนต์ใน PR (ใช้เป็นวิธีสำรองเมื่อ request review ไม่ได้)
    comment(repository, pullNumber, body) {
      return request('POST', `/repos/${repository}/issues/${pullNumber}/comments`, { body });
    },
    // ข้อมูล PR (ใช้ตรวจสอบประกอบ/ทดสอบ รวมถึง label ของ PR)
    getPull(repository, pullNumber) {
      return request('GET', `/repos/${repository}/pulls/${pullNumber}`);
    },
    // ไฟล์ที่เปลี่ยนใน PR (ใช้คิดคะแนน fit ว่าตรงกับความถนัดของใคร)
    getPullFiles(repository, pullNumber, perPage = 100) {
      return request('GET', `/repos/${repository}/pulls/${pullNumber}/files?per_page=${perPage}`);
    },
    // รายการ PR ที่เปิดอยู่ (ใช้ดูว่ามีงานรีวิวค้างอยู่คนละกี่งาน)
    listOpenPulls(repository, perPage = 100) {
      return request('GET', `/repos/${repository}/pulls?state=open&per_page=${perPage}`);
    },
    // สมาชิกของทีม (ใช้ขยายเจ้าของแบบ @org/team ใน CODEOWNERS)
    // ต้องใช้ token ที่อ่าน organization ได้ (เช่น PAT) ไม่ใช่ GITHUB_TOKEN ปกติ
    listTeamMembers(org, teamSlug, perPage = 100) {
      return request('GET', `/orgs/${org}/teams/${teamSlug}/members?per_page=${perPage}`);
    },
  };
}
