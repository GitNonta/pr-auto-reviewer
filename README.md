# pr-auto-reviewer

GitHub Action ที่เลือก reviewer ให้ PR อัตโนมัติแบบ **hybrid scoring 100 คะแนน** แล้วใช้ **Round-Robin เป็นตัวตัดสินเมื่อคะแนนเท่ากัน** โดย **ไม่เลือกผู้เปิด PR เป็น reviewer ของตัวเอง** และอธิบายได้ทุกครั้งว่าทำไมเลือกคนนั้น

## หลักการให้คะแนน (100 คะแนน)

| องค์ประกอบ | คะแนน | วิธีคิด |
|---|---|---|
| **Skill** | 40 | `40 × (ไฟล์+label ที่ตรงกับ paths/labels ÷ มากสุดในกลุ่ม)` |
| **Ownership** | 30 | `30 × (ไฟล์ที่ reviewer เป็นเจ้าของ ÷ มากสุดในกลุ่ม)` — อ่านจาก `CODEOWNERS` ก่อน แล้ว fallback ไป `owns` ใน config |
| **Workload** | 20 | `20 − 5 × จำนวนงานรีวิวที่ค้าง` (ต่ำสุด 0) |
| **Recency** | 10 | `+10` ถ้ายังไม่ได้อยู่ใน reviewer ของ assignment ล่าสุด |

- ผู้เปิด PR / login ใน `exclude` ถูกตัดสิทธิ์ก่อนคิดคะแนนเสมอ
- คะแนนเท่ากัน → ใกล้ `cursor` กว่า → งานค้างน้อยกว่า (Round-Robin tie-breaker)

### ตัวอย่าง

PR แก้ Backend 4 ไฟล์, Alice มีงานค้าง 2 งาน, ทุกคนเพิ่งรีวิว PR ล่าสุด:

| Reviewer | Skill | Ownership | Workload | Recency | รวม |
|---|---|---|---|---|---|
| Alice | 0 | 0 | 10 | 0 | 10 |
| Bob | 40 | 30 | 20 | 0 | **90** |
| Charlie | 10 | 0 | 20 | 0 | 30 |

→ เลือก **Bob** และ log จะบอกเหตุผลทุกข้อ

## วิธีใช้

`.github/workflows/auto-assign-reviewer.yml` เรียก `node scripts/auto-assign-reviewer.mjs` เมื่อมี PR ถูก `opened` หรือ `ready_for_review` (ข้าม draft) แล้ว commit ไฟล์ state กลับ default branch

ต้องมี permission: `contents: write`, `pull-requests: write`, `issues: write`

## Config: `.github/auto-assign-reviewers.json`

```json
{
  "reviewers": ["GitNonta", "Nontawatpkru17", "Themynon2"],
  "number_of_reviewers": 1,
  "state_path": ".github/reviewers-state.json",
  "tag_fallback": true,
  "codeowners_path": ".github/CODEOWNERS",
  "reviewer_profiles": {
    "GitNonta":       { "paths": ["scripts/**"], "labels": ["infra"], "owns": ["scripts/lib/**"] },
    "Nontawatpkru17": { "paths": ["frontend/**"], "owns": ["frontend/src/**"] },
    "Themynon2":      { "labels": ["docs"] }
  }
}
```

| ฟิลด์ | ความหมาย |
|---|---|
| `reviewers` | คิว reviewer (ต้องมีอย่างน้อย 1 คน) |
| `number_of_reviewers` | จำนวน reviewer ต่อ PR (1..จำนวน reviewer) |
| `state_path` | ที่เก็บ cursor + ประวัติ assignment |
| `tag_fallback` | ถ้า request review ไม่ได้ (ไม่ใช่ collaborator) ให้คอมเมนต์แท็กแทนหรือไม่ |
| `codeowners_path` | path ของ CODEOWNERS (ถ้าไม่ระบุจะค้นหา `.github/CODEOWNERS` → `CODEOWNERS` → `docs/CODEOWNERS`) |
| `reviewer_profiles` | ความถนัด/ความเป็นเจ้าของต่อ login (optional) |

- `paths` / `labels` = skill (label เทียบแบบไม่สนตัวพิมพ์)
- `owns` = ownership สำรอง ใช้เมื่อ CODEOWNERS ไม่มีข้อมูลที่ใช้ได้
- login ที่ไม่อยู่ใน `reviewers` จะถูกข้าม

## CODEOWNERS

รองรับรูปแบบเดียวกับ GitHub:

```gitignore
# comment
*.js @alice              # ทุกความลึก
/backend/server.js @bob  # ยึดจาก root
backend/ @acme/core      # ทั้งโฟลเดอร์ + ทีม
docs/ @carol @acme/docs
```

- rule สุดท้ายที่ match ไฟล์ชนะ
- `@org/team` ต้องขยายสมาชิกผ่าน Teams API — ต้องใช้ token ที่อ่าน org ได้ (สร้าง secret `TEAMS_TOKEN` เป็น PAT) ถ้าไม่ตั้งจะใช้ `GITHUB_TOKEN` ซึ่งปกติอ่านทีมไม่ได้ → warn แล้ว fallback
- ถ้าอ่าน CODEOWNERS ไม่ได้/ไม่มีเจ้าของที่ตรง → ใช้ `owns` ใน config → ถ้าไม่มีอีก = ownership 0 ทุกคน

## ระบบสำรอง (ไม่ทำให้ job ล้ม)

| สถานการณ์ | พฤติกรรม |
|---|---|
| ดึงไฟล์/label/PR ที่เปิดอยู่ไม่ได้ | warn แล้วใช้เท่าที่มี |
| ไม่มี `reviewer_profiles` | skill/ownership = 0 ทุกคน |
| ไม่มีข้อมูลงานค้าง | workload = 20 ทุกคน |
| ไม่มี history | recency = 10 ทุกคน → คิวตัดสิน |
| อ่าน CODEOWNERS/สมาชิกทีมไม่ได้ | ownership ใช้ `owns` |
| เหลือแต่ผู้เปิด PR | ข้ามทันทีโดยไม่เรียก API |
| request review ถูกปฏิเสธ | คอมเมนต์แท็กพร้อมเหตุผล (`tag_fallback: false` = ปล่อยให้ error) |

## ไฟล์ในโปรเจกต์

```
scripts/auto-assign-reviewer.mjs      entrypoint (อ่าน config/state, เก็บข้อมูล PR, เรียก scorer)
scripts/lib/round-robin.mjs           สูตรคะแนน + tie-breaker + เหตุผล
scripts/lib/codeowners.mjs            parse/match/count ของ CODEOWNERS (รวมทีม)
scripts/lib/expertise.mjs             จับคู่ glob ไฟล์/label กับความถนัด
scripts/lib/config.mjs                โหลด + ตรวจ config
scripts/lib/github.mjs                GitHub REST client
scripts/lib/state.mjs                 อ่าน/เขียน state + commit/push
test/                                 unit + integration tests (mock HTTP)
```

## รันทดสอบ

```bash
node --test test/
```

## State

`.github/reviewers-state.json` เก็บ `cursor` และ `assignments` ย้อนหลัง 50 รายการ (PR, author, reviewers, mode, เวลา) ใช้คิด recency และกันการ assign ซ้ำ
