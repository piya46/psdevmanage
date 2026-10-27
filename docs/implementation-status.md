# สถานะการพัฒนาและแผนถัดไป

อ้างอิง PSTON URS Thai v1.1 และการตัดสินใจของผู้ใช้: พัฒนาคนเดียว, TDID, Node.js + React, Microservices

เอกสาร URS มี 186 Functional Requirements (164 MUST / 22 SHOULD), 23 NFR, 38 Acceptance Tests และ 18 Business Rules รุ่นนี้มีเส้นทางเอกสารในเครื่องและสคริปต์ Cloud Run พร้อม data adapters ที่ทดสอบในเครื่อง ไม่ใช่การผ่านรับมอบ URS ทั้งฉบับ

## สถานะที่ตรวจได้ในโค้ด

| กลุ่ม URS | มีแล้วในรุ่นพัฒนา                                                                                                  | งานที่ยังไม่ผ่านรับมอบ                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| AUTH      | Google OIDC/allowlist implementation, session timeout/revoke, CSRF, WebAuthn registration/transaction approval     | ทดสอบ Google จริง, Recovery Kit, device/session UI, failure auditing ครบ, production HTTPS              |
| CERT      | Public certificate metadata, expiry checks ของ test signer, ปิด sign เมื่อไม่มี provider                           | TDID P12/PFX policy, wrapped import, HSM/remote adapter, chain/revocation                               |
| EDIT      | PDF upload, Thai text/date/stamp/drawing, drag, Undo/Redo, autosave, real preview                                  | เครื่องมือขั้นสูง/template, fixture matrix ครบหลายขนาด/rotation/crop, performance รับมอบ                |
| SIGN      | CMS test signing, hash/digest binding, WebAuthn, TTL, idempotency, service auth, recovery จากผลที่เก็บไว้          | TDID/HSM จริง, independent validator, algorithm/chain/PAdES conformance, production MFA/recovery policy |
| LOCK      | Signed revision อ่านอย่างเดียว, duplicate original                                                                 | DocMDP/FieldMDP, incremental co-sign, external import/lineage, compatibility matrix                     |
| INTEG     | SHA-256 original/revision, ตรวจตอนอ่าน, OpenSSL CMS, แสดง Trust/Revocation/Time แยก                                | ตรวจ PDF ภายนอก, multi-signature, modification policy, trust/revocation/time validation                 |
| QR        | Optional QR ก่อนเซ็น, opaque ID, minimal public evidence, browser hash comparison                                  | Lifecycle/disable policy, public quota/abuse test, external revision policy                             |
| VAULT     | Owner isolation, revisions, search/filter/trash, PostgreSQL และ Cloud Storage adapters                             | Cloud acceptance, migration, KMS, restore drill, quota/retention/purge, pagination >200                 |
| AUD       | Transactional outbox, idempotent ingest, SQL hash chain, scheduled cloud drain configuration                       | Checkpoint อิสระ, WORM/retention, failure event coverage, export และ restore proof                      |
| SEC / OPS | Service identities, CSRF/origin, rate/PDF limits, lock, Compose/CI, one-command Cloud Run/IAM/Secret configuration | Effective IAM/cloud deployment proof, KMS, monitoring, recovery, rollback/restore drills, cost controls |

## หลักฐานทดสอบที่จัดไว้

- Unit tests: SQLite และ PostgreSQL engine (PGlite), state/outbox rollback, owner isolation, duplicate claims, concurrent approval 8 คำขอสำเร็จครั้งเดียว; Cloud Storage adapter create-only และ source/secret exclusion
- Deployment orchestration: mock Google Cloud สร้างครั้งแรก/รันซ้ำโดยคง secrets/storage และปฏิเสธ inherited public IAM; ยังไม่ใช่ cloud integration test
- API integration: unauthorized/origin/CSRF rejection, original hash, stale draft, owner access, forged/cross-document approval, cryptographic signing/download, QR minimal disclosure, request retry, tampered/appended PDF rejection, post-approval edit rejection, idempotency conflict, emergency lock, unsafe upload, trash/restore, audit chain, restart reconciliation และ logout
- Browser E2E: Thai PDF editor → actual preview → virtual WebAuthn user verification → signed download → public evidence; replay challenge ถูกปฏิเสธ และตรวจ viewport มือถือ
- Build, lint, TypeScript และ dependency audit; มี CI definition พร้อมรันเมื่อเก็บ repo ใน GitHub

Browser ใช้ virtual authenticator ใน Chrome จึงยังไม่แทนการทดสอบอุปกรณ์จริงทุกชนิด Google OIDC/TDID/Cloud APIs ยังไม่ได้ทดสอบกับ credential จริงหรือ deploy project จริงในรอบนี้ ไม่มีผล Acrobat/pyHanko compatibility หรือ production load/restore test ในรอบนี้ Docker Compose ตรวจ config ได้ แต่ยังไม่ได้รัน containers เพราะ daemon ไม่เปิด

## ลำดับงานสำหรับผู้พัฒนาคนเดียว

| ลำดับ | งาน                                            | เงื่อนไขจบ                                                                                                                                         |
| ----- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | TDID technical proof และกำหนด signing contract | ทราบผลิตภัณฑ์/ชนิด key, policy การนำเข้า, API หรือ HSM ที่ใช้ได้, test certificate/chain และผลจาก independent validator                            |
| 2     | Production auth และ data adapters              | Google จริง + allowlist/Recovery, PostgreSQL/Storage cloud acceptance, private upload, quota/retention และ migration/restore tests                 |
| 3     | HSM/Remote signing + verification              | Digest-bound approval, certificate/key-version mapping, timeout reconciliation, crypto/trust/revocation/time policy และใบรับรองจริงผ่าน acceptance |
| 4     | PDF interoperability                           | Incremental signatures, DocMDP/FieldMDP, external import/lineage, independent validation และ Acrobat compatibility fixtures                        |
| 5     | Operations และรับมอบ MUST                      | IAM evidence, bootstrap/CI/deploy แยก, monitoring/budget, backup/restore, rollback และ traceability ครบทุก MUST                                    |

ประมาณการเต็มขอบเขตยังใช้ช่วง **24–32 สัปดาห์สำหรับผู้พัฒนาคนเดียว** เป็นฐานวางแผน ไม่ใช่กำหนดส่งยืนยัน งาน TDID proof ต้องจบก่อนประเมินเส้นทาง production signing ให้แน่นอน ตัวเลขนี้รวมงานที่ยังไม่อยู่ใน prototype และต้องทบทวนหลังทดสอบใบรับรอง/API จริง

ข้อมูลที่ต้องมีสำหรับ TDID proof คือชื่อผลิตภัณฑ์และประเภทใบรับรอง, ช่องทางเก็บ/ใช้กุญแจ, เอกสาร integration, test/sandbox access, certificate chain และ policy ที่อนุญาตให้นำเข้า/ใช้กุญแจ ห้ามส่ง private key หรือรหัส P12 ผ่านข้อความสนทนา ให้กำหนดช่องทางทดสอบที่เหมาะสมเมื่อเลือกแนวทางแล้ว

## Cloud Run ที่เพิ่มในรอบนี้

รัน npm run deploy:gcp -- --project YOUR_PROJECT_ID เพื่อสร้าง Cloud Run 5 บริการ, Cloud SQL PostgreSQL, Cloud Storage และ Secret Manager โดย build บน Cloud Build และเปิดเว็บผ่าน Google IAM proxy ไม่ต้องมี Docker daemon ในเครื่อง [คู่มือ deploy](deploy-gcp.md) ระบุ prerequisites, ค่าใช้จ่ายต่อเนื่องของ Cloud SQL, การอัปเดต/หยุด และข้อจำกัดไว้ครบ

Cloud deploy แยกจากข้อมูล SQLite/PDF เดิม ไม่อัปโหลดข้อมูลใน .local หรือ .env และยังใช้ certificate ทดสอบ ขนาด PDF cloud จำกัด 20 MiB; TDID production signing ยังไม่พร้อม ส่วน production profile แยกเปิด Gateway ผ่าน HTTPS + Google allowlist โดยไม่เปิด demo signing

## Production profile และข้อมูล TDID ล่าสุด

ผู้ใช้แจ้งว่ามี Project, โดเมน HTTPS, Google OAuth, CER/CRT และสร้าง P12 แล้ว ภาพอีเมลแสดงขั้นตอนรวม cert.cer กับ cert.key เป็น P12; ยังไม่ได้เปิดไฟล์หรือยืนยัน private key/chain/policy/revocation จริง ไม่มีการส่งหรืออัปโหลด private key ในงานรอบนี้

เพิ่ม `.env.production.example` และ `--environment production --env-file .env.production`: ตรวจสิทธิ์ไฟล์/allowlisted keys, ส่ง OAuth secret เข้า Secret Manager ผ่าน stdin, pin/rotate version โดยไม่ใส่ค่าใน command/image; แยก environment labels, Cloud SQL HA + backups 30 ชุด/PITR, private internal services และเปิด Gateway หลังตรวจ auth/readiness จากนั้นตรวจ HTTPS origin ให้ถึง release จริง

Runtime ตรวจ production configuration ก่อน startup, ใช้ __Host- cookies, Google verified email/azp/required claims, ตรวจ allowlist ซ้ำเมื่ออ่าน session และปิด demo endpoint/test keys แก้ rate-limit plugin ให้ลงทะเบียนก่อน routes และมี database readiness; ยังไม่ได้เพิ่ม Cloud Armor/distributed limits, monitoring alerts หรือ automatic rollback

เพิ่ม `npm run cert:check -- --file /path/certificate.p12 --certificate /path/cert.cer` ให้ OpenSSL ถามรหัสผ่านใน Terminal และตรวจ key/cert/validity ใน memory ไม่อัปโหลดกุญแจหรือบันทึกรหัสผ่าน ผลมีเฉพาะข้อมูลสาธารณะ ไม่ใช่ chain/revocation/TDID policy validation และยังไม่มี wrapped importer/HSM signer

Tests เพิ่มสำหรับ runtime rejection, rate-limit regression, encrypted P12 จริงด้วย fixture, config/secret exclusion และ mock production deploy/redeploy/rotation/HA drift ไม่มีผล deploy จริงหรือการลงนาม TDID จริง การมี production profile จึงไม่หมายถึงผ่าน production acceptance ตาม URS

ผลตรวจรอบนี้: TypeScript/lint/build ผ่าน, unit/integration tests รวม 35 cases ผ่าน (รวม Google claim/session policy เพิ่มเติม), browser E2E ของ demo ที่ build แล้ว 3 cases ผ่าน และ Docker Compose config ผ่าน การตรวจเหล่านี้ไม่ได้ใช้ Google/TDID credentials จริงและยังไม่ได้ build/run Docker container หรือ deploy Google Cloud จริง

## Email allowlist

ปรับตามคำขอให้ตั้ง GOOGLE_ALLOWED_EMAILS ด้วยอีเมลเริ่มต้นได้ ไม่ต้องหา sub รองรับหลายอีเมลแบบ exact match หลัง normalize case/whitespace; ตรวจ Google verified email และ Gmail/Workspace authority, ยังคง sub เป็น owner ID และตรวจ allowlist ซ้ำเมื่ออ่าน session เพิ่ม validator ร่วมสำหรับ runtime/deploy, ปรับตัวอย่าง env และส่งค่าเฉพาะ Identity ใน Cloud Run ค่า email มีผลเหนือ legacy sub list รวมถึงการตั้ง email ว่างจะไม่ fallback ไปเปิดสิทธิ์เดิม การเปลี่ยนจาก sub-only ต้อง login ใหม่เพื่อยืนยันอีเมล

ผลตรวจ email allowlist: npm run check ผ่านทั้ง TypeScript, lint, unit/integration 38 cases และ build; ทดสอบการ normalize อีเมล, ปฏิเสธ unverified/บัญชีอื่น/aliases/third-party mailbox, ถอนสิทธิ์ session, legacy compatibility และส่ง email configuration เฉพาะ Identity ใน mock deployment แล้ว ยังไม่ได้ทดสอบ Google Login หรือ deploy บน cloud จริงในรอบนี้
