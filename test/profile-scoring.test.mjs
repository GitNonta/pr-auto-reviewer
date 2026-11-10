import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadConfig } from '../scripts/lib/config.mjs';
import { selectReviewers } from '../scripts/lib/round-robin.mjs';

/**
 * เทสต์ชุดนี้ใช้ config และ CODEOWNERS "ตัวจริง" ของ repo
 * เพื่อพิสูจน์ว่า skill (40) และ ownership (30) เปลี่ยนคะแนนและเปลี่ยนผู้ชนะได้จริง
 */

async function realSetup({ files, labels = [], cursor = 0, history = [] }) {
  const config = await loadConfig('.github/auto-assign-reviewers.json');
  const codeowners = await readFile(config.codeownersPath, 'utf8');
  const result = selectReviewers({
    reviewers: config.reviewers,
    cursor,
    count: config.count,
    profiles: config.profiles,
    changes: { files, labels },
    history,
    codeowners,
  });
  return { config, result, scored: (login) => result.scored.find((item) => item.login === login) };
}

test('config จริงมี reviewer_profiles ครบทุกคน และ codeowners_path ชี้ไฟล์ที่มีอยู่', async () => {
  const config = await loadConfig('.github/auto-assign-reviewers.json');

  assert.deepEqual(config.reviewers, ['GitNonta', 'Nontawatpkru17', 'Themynon2']);
  for (const login of config.reviewers) {
    assert.ok(config.profiles[login], `ต้องมี profile ของ ${login}`);
  }
  assert.equal(config.codeownersPath, '.github/CODEOWNERS');
  // อ่านได้จริง ไม่ throw
  assert.match(await readFile(config.codeownersPath, 'utf8'), /@GitNonta/);
});

test('PR ที่แก้ scripts/ -> GitNonta ได้ 100 คะแนนเต็มจากข้อมูลจริง', async () => {
  const { result, scored } = await realSetup({ files: ['scripts/lib/round-robin.mjs'] });
  const gitnonta = scored('GitNonta');

  assert.equal(gitnonta.skill, 40);
  assert.equal(gitnonta.ownership, 30);
  assert.equal(gitnonta.workload, 20);
  assert.equal(gitnonta.recency, 10);
  assert.equal(gitnonta.score, 100);
  assert.deepEqual(result.selected, ['GitNonta']);
});

test('PR ที่แก้ test/ -> Nontawatpkru17 ชนะเพราะ skill + ownership ตรงงาน', async () => {
  const { result, scored } = await realSetup({ files: ['test/assign.test.mjs'] });

  assert.equal(scored('Nontawatpkru17').score, 100);
  // GitNonta ยังได้ skill (test/** อยู่ใน paths) แต่ไม่ได้ ownership ของ test/
  assert.equal(scored('GitNonta').skill, 40);
  assert.equal(scored('GitNonta').ownership, 0);
  assert.equal(scored('GitNonta').score, 70);
  assert.deepEqual(result.selected, ['Nontawatpkru17']);
});

test('PR ที่แก้ README.md -> Themynon2 ได้ 100 (เอกสารเป็นเจ้าของ)', async () => {
  const { result, scored } = await realSetup({ files: ['README.md'] });

  assert.equal(scored('Themynon2').score, 100);
  assert.deepEqual(result.selected, ['Themynon2']);
});

test('skill เปลี่ยนผู้ชนะ: ไฟล์เปลี่ยนกลุ่ม -> คนที่ถนัดกลุ่มนั้นชนะ แม้ cursor ชี้คนอื่น', async () => {
  const scripts = await realSetup({ files: ['scripts/auto-assign-reviewer.mjs'], cursor: 1 });
  const tests = await realSetup({ files: ['test/hybrid.test.mjs'], cursor: 1 });

  assert.deepEqual(scripts.result.selected, ['GitNonta']);
  assert.deepEqual(tests.result.selected, ['Nontawatpkru17']);
  assert.notDeepEqual(scripts.result.selected, tests.result.selected);
});

test('ownership เปลี่ยนผู้ชนะเมื่อ skill เท่ากัน: CODEOWNERS เป็นตัวชี้ขาด', async () => {
  const base = {
    reviewers: ['GitNonta', 'Nontawatpkru17'],
    cursor: 0,
    count: 1,
    profiles: {
      GitNonta: { paths: ['scripts/**'] },
      Nontawatpkru17: { paths: ['scripts/**'] },
    },
    changes: { files: ['scripts/a.mjs'] },
  };

  // ไม่มี CODEOWNERS: คะแนนเท่ากันทุกด้าน -> คิวเลือก GitNonta
  const tied = selectReviewers({ ...base, codeowners: '' });
  assert.equal(tied.scored[0].score, tied.scored[1].score);
  assert.deepEqual(tied.selected, ['GitNonta']);

  // มี CODEOWNERS ให้ Nontawatpkru17 เป็นเจ้าของ scripts/ -> ownership พลิกผู้ชนะ
  const owned = selectReviewers({ ...base, codeowners: 'scripts/ @Nontawatpkru17' });
  assert.equal(owned.scored.find((s) => s.login === 'Nontawatpkru17').ownership, 30);
  assert.equal(owned.scored.find((s) => s.login === 'GitNonta').ownership, 0);
  assert.deepEqual(owned.selected, ['Nontawatpkru17']);
});

test('profile ที่อ้าง path ไม่มีจริง (เช่น frontend/**) ต้องไม่ได้ skill', async () => {
  const { result } = await realSetup({ files: ['scripts/lib/config.mjs'] });

  // ไม่มีใครใน config อ้าง frontend/** แล้ว และไฟล์ที่แก้ไม่ตรง profile ของคนอื่น
  assert.deepEqual(result.selected, ['GitNonta']);
  assert.equal(result.scored.find((s) => s.login === 'Themynon2').skill, 0);
});
