# PR Auto-Reviewer (Round-Robin)

GitHub Action ที่ **assign Reviewer อัตโนมัติเมื่อมี PR ใหม่** โดยเลือกตามคิวแบบ **Round-Robin**
และ **ไม่เลือกผู้เปิด PR (author) มาเป็น Reviewer ของตัวเอง** เด็ดขาด

- ทำงานเมื่อ: `pull_request` → `opened` และ `ready_for_review` (ข้าม Draft)
- assign อย่างน้อย 1 คนตาม `number_of_reviewers`
- เก็บตำแหน่งคิว (`cursor`) ไว้ใน repository เพื่อให้ลำดับต่อเนื่องข้าม PR
- ถ้า GitHub ไม่ยอมให้ request review (ผู้ใช้ยังไม่ใช่ collaborator) จะ **แท็ก `@user` ใน comment** แทน (ปิดได้ด้วย `tag_fallback: false`)

## วิธีทำงาน

```
config.reviewers = [octocat, hubot, GitNonta]   ← คิวตามลำดับ
state.cursor     = 0

PR #1 (author = GitNonta) → octocat   cursor 1
PR #2 (author = GitNonta) → hubot     cursor 2
PR #3 (author = GitNonta) → GitNonta ถูกข้าม → octocat   cursor 1
```

- เริ่มสแกนจาก `cursor` ไล่ไปตามคิวและวนกลับต้นคิว
- ข้าม login ที่ตรงกับ author (ไม่สนตัวพิมพ์เล็ก/ใหญ่)
- หลังเลือกเสร็จ `cursor` จะชี้ไปที่ตำแหน่งถัดไปจากคนที่ถูกเลือกคนสุดท้าย
- ถ้าทุกคนในคิวคือ author → ไม่ assign และไม่ขยับ cursor (log คำเตือน)

## ไฟล์ในโปรเจกต์

| ไฟล์ | หน้าที่ |
|---|---|
| `.github/auto-assign-reviewers.json` | คอนฟิกคิว Reviewer |
| `.github/reviewers-state.json` | สถานะคิว (`cursor`) + ประวัติ 50 รายการล่าสุด (workflow commit กลับเข้าสาขาหลัก) |
| `.github/workflows/auto-assign-reviewer.yml` | workflow ที่รันบน PR |
| `scripts/auto-assign-reviewer.mjs` | entrypoint: อ่านคอนฟิก → เลือก → assign → บันทึก state |
| `scripts/lib/round-robin.mjs` | ตรรกะ Round-Robin ล้วน ๆ (ไม่แตะ network) |
| `scripts/lib/config.mjs` | โหลด/ตรวจคอนฟิก |
| `scripts/lib/github.mjs` | GitHub REST client (requested reviewers / comment) |
| `scripts/lib/state.mjs` | อ่าน/เขียน state และ commit+push กลับ repo |
| `test/*.test.mjs` | unit + integration test (mock GitHub API) |

## คอนฟิก

```json
{
  "reviewers": ["octocat", "hubot", "GitNonta"],
  "number_of_reviewers": 1,
  "state_path": ".github/reviewers-state.json",
  "tag_fallback": true
}
```

| ฟิลด์ | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `reviewers` | (จำเป็น) | คิว GitHub login ตามลำดับ Round-Robin |
| `number_of_reviewers` | `1` | จำนวน Reviewer ต่อ PR (1 ถึงขนาดคิว) |
| `state_path` | `.github/reviewers-state.json` | ที่เก็บ cursor |
| `tag_fallback` | `true` | ถ้า request review ไม่ได้ ให้แท็กใน comment แทน |

แก้คิวได้โดยแก้ไฟล์นี้แล้ว commit — ไม่ต้องแก้ workflow

## การติดตั้งใน repo อื่น

1. คัดลอก `.github/workflows/auto-assign-reviewer.yml`, `.github/auto-assign-reviewers.json`,
   `.github/reviewers-state.json`, `scripts/` และ `test/` ไปไว้ใน repo ปลายทาง
2. ใส่ GitHub login ของทีมใน `reviewers` (เรียงตามลำดับที่ต้องการ)
3. ตรวจว่า Settings → Actions → General → Workflow permissions เป็น **Read and write**
   (workflow ต้อง push state กลับสาขาหลัก) หรือใช้ permission block ที่มีอยู่แล้วใน workflow
4. **เพิ่ม Reviewer เป็น collaborator ของ repo** — GitHub อนุญาตให้ request review จาก collaborator เท่านั้น
   ถ้ายังไม่เพิ่ม ระบบจะแท็กใน comment แทน (โหมด `tagged`)
5. เปิด PR ใหม่ (ที่ไม่ใช่ Draft) → ดูแท็บ Actions และ Reviewers ของ PR

## ทดสอบในเครื่อง

ไม่ต้องติดตั้ง dependency ใด ๆ (ใช้ Node.js ≥ 20):

```bash
npm test                        # unit + integration (mock GitHub API)
node --test test/round-robin.test.mjs
```

ทดสอบยิง GitHub จริงแบบ manual:

```bash
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo PR_NUMBER=12 PR_AUTHOR=someone \
  GITHUB_API_BASE_URL=https://api.github.com \
  node scripts/auto-assign-reviewer.mjs
```

## ข้อจำกัดที่ควรรู้

- **Fork PR:** `GITHUB_TOKEN` ของ workflow จาก fork เป็น read-only → assign ได้แต่ push state ไม่ได้
  (สคริปต์จะ log คำเตือนและไม่ทำให้ check แดง) แนะนำให้ใช้กับ PR จากสาขาใน repo เดียวกัน
- **Concurrency:** workflow ใช้ `concurrency: auto-assign-reviewer` เพื่อกัน PR พร้อมกันแย่งคิวเดียวกัน
  การ push state มี retry 3 ครั้ง (pull --rebase) ถ้าชนกันจริง ๆ จะใช้ค่าที่ push สำเร็จล่าสุด
  (cursor อาจขยับซ้ำได้ในกรณีชนกันหนักมาก แต่จะไม่มีวันเลือก author)
- **Reviewer ต้องเป็น collaborator** ของ repository ถึงจะ assign ผ่าน reviewer slot ได้จริง
- ถ้าต้องการรีเซ็ตคิว ให้ตั้ง `cursor` ใน `.github/reviewers-state.json` เป็น `0`
