# PSTON

ระบบจัดการและลงนาม PDF ตาม URS v1.1 พัฒนาด้วย **Node.js + TypeScript + React** แยกเป็น Microservices สำหรับผู้พัฒนาคนเดียว

รุ่นนี้มีเส้นทาง PDF ที่ลงนามด้วยกุญแจทดสอบ และ production deployment profile สำหรับ Google Login/พื้นที่เอกสารบน Cloud Run ยังไม่ผ่าน production acceptance และยังไม่ครบ MUST ใน URS การลงนาม TDID จริงยังปิดไว้ระหว่างพัฒนา HSM provider และ trust validation

## Deploy Google Cloud ด้วยคำสั่งเดียว

สำหรับ production คัดลอก `.env.production.example` เป็น `.env.production`, ตั้งสิทธิ์ `chmod 600 .env.production` และกรอก Project/HTTPS/OAuth/email allowlist แล้วรัน:

```sh
npm run deploy:gcp -- --environment production --env-file .env.production
```

มี Cloud SQL HA + backups/PITR และเปิดเฉพาะ Gateway ให้เข้าหน้า Google Login ต้องเตรียม DNS/TLS/OAuth redirect ให้ตรงก่อน deploy อ่าน [ขั้นตอน production และตรวจ P12](docs/deploy-gcp.md) ค่าใช้จ่าย Cloud SQL HA ต่อเนื่องแม้ไม่มีผู้ใช้; การลงนาม TDID ยังไม่เปิด

สำหรับ demo:

```sh
npm run deploy:gcp -- --project YOUR_PROJECT_ID
```

แทน Project ID ด้วยโปรเจกต์ที่เปิด Billing แล้ว ต้องมี Node.js 22, Google Cloud CLI และ OpenSSL 3 สคริปต์สร้าง **Cloud Run แยก 5 บริการ + Cloud SQL PostgreSQL + Cloud Storage + Secret Manager** แล้วเปิดเว็บผ่าน Google IAM proxy ที่ **http://localhost:5180** ไม่ต้องเปิด Docker ในเครื่อง

อัปเดตใช้คำสั่งเดิม; เปิดเว็บครั้งถัดไปเพิ่ม `--connect`; ดูแผนก่อนสร้างเพิ่ม `--dry-run` Cloud SQL มีค่าเครื่องต่อเนื่องแม้ไม่มีการใช้งาน ค่าเริ่มต้นเป็นระบบทดลองแบบ private และยังไม่เปิดลงนาม TDID จริง อ่าน [คู่มือ deploy, สิทธิ์, ค่าใช้จ่าย และการกู้คืน](docs/deploy-gcp.md) ก่อนรัน

## เริ่มใช้งาน

ต้องมี Node.js 22.13–22.x, npm และ OpenSSL 3.x ใน PATH

```sh
npm ci
npm run dev
```

เปิด **http://localhost:5173** → **เปิดพื้นที่ทดลอง** → **ใช้เอกสารตัวอย่าง** หรืออัปโหลด PDF → วางข้อความ/วันที่/ตราประทับ/วาดลายเซ็น → ตรวจเอกสารและลงนาม → ดาวน์โหลด PDF

`npm run dev` สร้าง Service identities และใบรับรองทดสอบครั้งแรกโดยอัตโนมัติ ข้อมูลอยู่ใน `.local/` ซึ่งไม่ถูกนำเข้า Git ห้ามใช้กุญแจทดสอบนี้แทนใบรับรองจริง และใช้ข้อมูลทดลองในรุ่นนี้ เนื่องจากยังไม่มี Vault encryption/Cloud KMS

หากต้องการทดลอง Passkey ให้เปิด **ศูนย์ความปลอดภัย → ลงทะเบียน Passkey** ก่อนลงนาม ต้องเข้าเว็บด้วย `localhost` ให้ตรงกับ `WEB_ORIGIN` และใช้ HTTPS เมื่อเปลี่ยนเป็นโดเมนอื่น

หยุดด้วย Ctrl+C หากแก้โค้ด Backend ให้เริ่ม `npm run dev` ใหม่ ส่วน React รองรับ HMR

## โครงสร้างบริการ

| บริการ        | พอร์ตในเครื่อง | หน้าที่                                                           |
| ------------- | -------------- | ----------------------------------------------------------------- |
| React / Vite  | 5173           | Workspace, PDF editor, ใบรับรอง, ตรวจสอบ, Security, Audit         |
| Gateway / BFF | 3000           | Cookie, CSRF, Origin, allowlist API, ส่ง React ที่ build แล้ว     |
| Identity      | 3001           | Google OIDC + allowlist, session, WebAuthn, ออก approval token    |
| Documents     | 3002           | Upload, immutable revisions, PDF workers, preview, QR evidence    |
| Signing       | 3003           | Certificate metadata, request state, idempotency, demo CMS signer |
| Audit         | 3004           | Durable audit ingestion, hash chain, integrity query              |

ในเครื่องแต่ละบริการใช้ SQLite ของตัวเอง ส่วน Cloud Run ใช้ PostgreSQL แยกฐานข้อมูล/role และเก็บ PDF ใน Cloud Storage สื่อสารผ่าน HTTP พร้อม Ed25519 service JWT และ Google IAM เพิ่มเมื่ออยู่บน Cloud Run ไม่แชร์ตารางฐานข้อมูล PDF ประมวลผลใน subprocess ที่จำกัดเวลา/หน่วยความจำ โค้ดกลางใน `packages/core` ใช้ร่วมเฉพาะรูปแบบข้อมูลและ utility

อ่าน [การออกแบบและข้อจำกัด](docs/architecture.md) และ [สถานะเทียบ URS / งานถัดไป](docs/implementation-status.md) ประกอบกับ [แผนพัฒนาเดิม](PSTON_Review_Development_Plan.xlsx)

## สิ่งที่ทดลองได้

- อัปโหลด PDF ไม่เกิน 50 MiB ในเครื่อง / 20 MiB บน Cloud Run / 300 หน้า, ตรวจไฟล์เสียหาย/เข้ารหัส/active content; ยังไม่รับ PDF ที่มีลายเซ็นเดิม
- แก้ร่างด้วยข้อความภาษาไทย วันที่ กรอบตราประทับ ภาพลายเซ็นที่วาด, ลากตำแหน่ง, Undo/Redo และ autosave แบบตรวจ draft version
- ตรวจ PDF ฉบับจริงก่อนอนุมัติ ผูก approval กับ prepared hash, ByteRange digest, certificate, owner, nonce และ TTL
- อนุมัติด้วย WebAuthn user verification หรือปุ่มยืนยันที่เปิดเฉพาะโหมดทดลอง; เซ็น CMS ด้วย OpenSSL และตรวจผลก่อนบันทึก
- แยกต้นฉบับ/ฉบับลงนาม ตรวจ SHA-256 ก่อนเปิดไฟล์, สำเนาจากต้นฉบับ, ถังขยะ/กู้คืน
- QR ทางเลือกแสดงเฉพาะหลักฐานฉบับที่ระบบถือครอง เทียบ hash ของไฟล์โดยคำนวณในเบราว์เซอร์
- นำเข้าเฉพาะ public certificate PEM/CER/CRT เพื่อดูข้อมูล, ระงับการลงนาม, Audit hash chain

ผลตรวจแยก Crypto, Trust, Revocation และ Timestamp ใบรับรองทดสอบแสดง `untrusted`, revocation `not_checked` และ timestamp `none` เสมอ ไม่อ้างว่า QR หรือ Hash เพียงอย่างเดียวพิสูจน์ความน่าเชื่อถือของ CA

## รันชุดที่ build แล้ว

```sh
npm run build
WEB_ORIGIN=http://localhost:3000 npm start
```

เปิด http://localhost:3000 ใช้ข้อมูล `.local` เดิม และหยุด dev server ก่อนเพื่อไม่ให้พอร์ตชนกัน คำว่า build ไม่ได้หมายความว่ารุ่นนี้ผ่าน Production acceptance: Runtime production จะยอมเริ่มเฉพาะเมื่อผ่านเงื่อนไข Google Login/HTTPS/Cloud SQL/Secrets และปิด TDID signing

## Docker Compose สำหรับเครื่องพัฒนา

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f gateway
```

เปิด http://localhost:3000 ต้องหยุดบริการพอร์ต 3000 เดิมก่อน Compose สร้าง named volume แยกบริการ พร้อม bootstrap ที่สร้างกุญแจและคัดลอกเฉพาะ public keys ไปแต่ละบริการ Runtime ไม่สามารถ mount volume ของบริการอื่น และเผยแพร่เฉพาะ Gateway ที่ `127.0.0.1:3000`

```sh
docker compose down
```

คำสั่งนี้เก็บ volumes ไว้ อย่าลบ volumes หากยังต้องการข้อมูลและกุญแจทดสอบเดิม มีการตรวจ `docker compose config --quiet` แล้ว แต่ยังไม่ได้ build/run containers ในเครื่องนี้ เพราะ Docker daemon ไม่ได้เปิด

## ตรวจสอบโค้ดและพฤติกรรม

```sh
npm run check
npm run format:check
npm run test:e2e
PSTON_E2E_BUILT=1 npm run test:e2e
npm audit --audit-level=high
```

`check` รัน TypeScript, lint, unit/integration tests และ build ทดสอบ API ใช้ข้อมูลชั่วคราวและพอร์ต 4100–4104; Browser tests ใช้พอร์ต 4200–4204 และ 5273 พร้อมข้อมูลแยกใน `.local/e2e-*` ไม่ใช้ข้อมูลพื้นที่ทดลองของคุณ สามารถลบเฉพาะ `.local/e2e-*` หลังหยุด tests ได้

Browser tests ใช้ Chrome ที่ติดตั้งใน macOS หรือ Chromium ของ Playwright ระบบอื่นติดตั้งด้วย `npx playwright install chromium` และระบุ `PLAYWRIGHT_CHROMIUM_PATH` ได้ ภาพหน้าจอและ trace อยู่ใน `test-results/` รายงานอยู่ใน `playwright-report/`

CI ใน `.github/workflows/ci.yml` ตรวจโค้ด ทดสอบ และ audit dependencies โดยไม่ใช้ Cloud secrets และไม่มี deploy job ขณะนี้ยังไม่ได้รัน workflow บน GitHub

## Google และ TDID

คัดลอก `.env.example` เป็น `.env` แล้วตั้ง `PSTON_MODE=google`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_EMAILS`, `GOOGLE_REDIRECT_URI` และ `WEB_ORIGIN` ให้ตรงกัน Allowlist ใช้อีเมล Gmail/Google Workspace ที่ Google ยืนยันแล้ว เช่น `GOOGLE_ALLOWED_EMAILS=yourname@gmail.com` ระบบยังใช้ Google `sub` เป็นรหัสเจ้าของเอกสารภายใน โค้ด OIDC มี state, nonce และ PKCE แต่ยังไม่ได้ทดสอบกับบัญชี Google จริงในงานนี้ เมื่อใช้ Google mode จะไม่มี demo signing certificate

**ยังไม่รับไฟล์ P12/PFX หรือ Private Key จริง** ต้องยืนยันผลิตภัณฑ์ TDID, สิทธิ์นำเข้ากุญแจ, algorithm, chain และวิธีเรียก Cloud HSM/Remote Signing ก่อนทำ adapter ไม่มีการเดา endpoint หรือเก็บกุญแจ CA จริงไว้ในเครื่อง

งานที่เหลือก่อน Production รวมถึง TDID adapter, Cloud KMS, cloud acceptance และ migration ข้อมูลเดิม, Independent PDF validation/Trust/OCSP/CRL/TSA policy, external incremental co-sign, Recovery, backup/restore, quota/retention, IAM และ deployment acceptance รายละเอียดอยู่ในแผนสถานะ
