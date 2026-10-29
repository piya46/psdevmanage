# สถานะการพัฒนาและแผนถัดไป

อ้างอิง PSTON URS Thai v1.1 และการตัดสินใจของผู้ใช้: พัฒนาคนเดียว, TDID, Node.js + React, Microservices

เอกสาร URS มี 186 Functional Requirements (164 MUST / 22 SHOULD), 23 NFR, 38 Acceptance Tests และ 18 Business Rules รุ่นนี้มีเส้นทางเอกสารในเครื่องและ deploy production profile บน Cloud Run แล้ว แต่ยังไม่ผ่านรับมอบ URS ทั้งฉบับ

## การนำเข้าใบรับรองและลงนาม HSM — 30 ตุลาคม 2026

เพิ่มหน้า P12/PFX import ตามคำขอผู้ใช้: อ่านและ wrap กุญแจใน browser worker, ส่งเฉพาะ public certificate และ wrapped key ไป Cloud HSM, ผูก owner/fingerprint/key version และอนุมัติ PDF ด้วย Passkey ก่อนลงนามจริง ตรวจ TDID G3/NRCA G1 chain, KeyUsage/EKU, validity และ signed CRLs; หากตรวจไม่ได้จะหยุด ไม่มี raw private key/password ใน API, DB หรือ app env

ผ่าน `npm run check`: TypeScript, ESLint, unit/integration 54 tests และ build; ผ่าน Chrome E2E ของ build จริง 4 cases รวมรหัส P12 ผิดต้องไม่ส่ง request, browser wrapping ที่ unwrap/เทียบ public key ได้, Passkey approval และ signed download ทดสอบ KMS transport ด้วย fixture และตรวจ detached CMS/CAdES แบบอิสระด้วย OpenSSL แล้ว ผล Cloud HSM จริงและ deployment รอบนี้กำลังตรวจ จึงยังไม่ถือว่าผ่านจาก tests จำลองเพียงอย่างเดียว

ใบรับรอง TDID ของผู้ใช้ยังไม่ได้ถูกนำเข้า/ลงนาม ผู้ใช้จะอัปโหลดผ่านหน้าเว็บเอง รองรับ production TDID CA G3 แบบ RSA เท่านั้น ไม่มี TSA/Trusted Timestamp, PAdES-LT/LTA, multi-signature, recovery หรือผล Acrobat/pyHanko acceptance รุ่นนี้ไม่เท่ากับการรับมอบ URS ทุกข้อ ดูขั้นตอนและขอบเขต [นำเข้า P12 ผ่านเว็บ](deploy-gcp.md#นำเข้า-p12-ผ่านหน้าเว็บและลงนาม)

## ผล deploy ก่อนเพิ่ม HSM — 29 ตุลาคม 2026

เปิดใช้งานที่ https://pston-prod-gateway-874466691788.asia-southeast1.run.app ใน project `piyawebs`, region `asia-southeast1`, deployment `pston-prod` โดยใช้ Billing MA-001 และเลื่อนการ map โดเมนตามคำขอผู้ใช้ `.env.production` ใช้ Cloud Run URL เป็น WEB_ORIGIN แล้ว

- Cloud Run ทั้ง 5 บริการพร้อมและใช้ release เดียวกัน `20261027183251239-204645`; Gateway เปิดหน้าเว็บได้ และ Identity/Documents/Signing/Audit ยังตอบ 403 หากเรียกโดยไม่มี Google IAM
- Cloud SQL PostgreSQL 17 เป็น RUNNABLE, regional HA, backups 30 ชุด, PITR 7 วัน และ deletion protection; init job สำเร็จพร้อมตรวจ CONNECT ของ role/database ทั้ง 16 คู่ว่าเข้าได้เฉพาะฐานของตน แล้วลบ bootstrap job
- สร้าง private Storage buckets, Secret Manager และ Scheduler 3 jobs แล้ว; `/ready` ผ่านการเรียกบริการและอ่านฐานข้อมูลทั้ง 4, `/api/documents` ตอบ 401 เมื่อไม่ login, demo login ตอบ 404
- Chrome เปิด React ได้ ไม่มี JavaScript error และไปถึงหน้าลงชื่อเข้าใช้ของ Google โดยไม่พบ redirect_uri_mismatch; ตรวจ Secure/HttpOnly OAuth cookie แล้ว **ยังไม่ได้กรอกบัญชี Google จนจบ callback/token exchange** หรือทดสอบ upload/edit ด้วย session จริงบน cloud
- TDID signing ยังปิดอยู่ และยังไม่ได้ทำ load/restore drill, monitoring/budget alerts หรือ custom domain

แก้ปัญหาจาก deploy จริง: Python 3.9 ทำให้ gcloud Storage พิมพ์ข้อความปน JSON (เครื่องนี้ใช้ Python 3.13 แล้ว), รองรับข้อความ `Cannot find job/service` เมื่อสร้างครั้งแรก, ให้ administrator มี SET/INHERIT membership ก่อน CREATE DATABASE OWNER บน PostgreSQL 17 และเพิ่ม retry แบบจำกัดสำหรับ startup/readiness probes โดยไม่ retry การสร้างทรัพยากรหรือ login actions

ผลตรวจสคริปต์ล่าสุด: deployment unit/integration tests 17 กรณีและ ESLint ของไฟล์ที่แก้ผ่าน รวม retry หลัง IAM/network/startup failure, การหยุดเมื่อครบจำนวนครั้ง, การปฏิเสธ HTTP/JSON ที่ไม่ถูกต้อง และการไม่พิมพ์ response ที่อาจมีข้อมูลลับ ไม่ได้รันชุด browser demo E2E เดิมซ้ำในรอบแก้ deployment นี้

หลักฐาน local อยู่ใน `.local/gcp-deploy/piyawebs/asia-southeast1/pston-prod/`: `last-deployment.json`, `verification.json`, `browser-verification.json` และ `frontend.png` ไฟล์เหล่านี้ไม่ถูกอัปโหลดเข้า build หรือเก็บใน source control

## สถานะที่ตรวจได้ในโค้ด

| กลุ่ม URS | มีแล้วในรุ่นพัฒนา                                                                                                  | งานที่ยังไม่ผ่านรับมอบ                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| AUTH      | Google OIDC/allowlist implementation, HTTPS Cloud Run, session timeout/revoke, CSRF, WebAuthn registration/transaction approval | Google login จนจบ callback, Recovery Kit, device/session UI, failure auditing ครบ |
| CERT | Browser P12 wrapped import, HSM key/certificate mapping, TDID G3/NRCA chain + CRL, public certificate metadata | ใบรับรองผู้ใช้จริง, CA รุ่นอื่น, credential lifecycle/retention |
| EDIT      | PDF upload, Thai text/date/stamp/drawing, drag, Undo/Redo, autosave, real preview                                  | เครื่องมือขั้นสูง/template, fixture matrix ครบหลายขนาด/rotation/crop, performance รับมอบ                |
| SIGN | HSM RSA-SHA256 CMS/CAdES, digest/key binding, WebAuthn, TTL, idempotency, uncertain import/sign reconciliation, OpenSSL validator | ใบรับรองผู้ใช้จริง, Acrobat/PAdES conformance matrix, TSA/LTV, recovery policy |
| LOCK      | Signed revision อ่านอย่างเดียว, duplicate original                                                                 | DocMDP/FieldMDP, incremental co-sign, external import/lineage, compatibility matrix                     |
| INTEG     | SHA-256 original/revision, ตรวจตอนอ่าน, OpenSSL CMS, แสดง Trust/Revocation/Time แยก                                | ตรวจ PDF ภายนอก, multi-signature, modification policy, trust/revocation/time validation                 |
| QR        | Optional QR ก่อนเซ็น, opaque ID, minimal public evidence, browser hash comparison                                  | Lifecycle/disable policy, public quota/abuse test, external revision policy                             |
| VAULT     | Owner isolation, revisions, search/filter/trash, PostgreSQL และ Cloud Storage adapters                             | Cloud acceptance, migration, KMS, restore drill, quota/retention/purge, pagination >200                 |
| AUD       | Transactional outbox, idempotent ingest, SQL hash chain, scheduled cloud drain configuration                       | Checkpoint อิสระ, WORM/retention, failure event coverage, export และ restore proof                      |
| SEC / OPS | Service identities, CSRF/origin, rate/PDF limits, lock, Compose/CI, Cloud Run deployment และ IAM smoke checks จริง | KMS, monitoring, recovery, rollback/restore drills, load acceptance, cost controls |

## หลักฐานทดสอบที่จัดไว้

- Unit tests: SQLite และ PostgreSQL engine (PGlite), state/outbox rollback, owner isolation, duplicate claims, concurrent approval 8 คำขอสำเร็จครั้งเดียว; Cloud Storage adapter create-only และ source/secret exclusion
- Deployment orchestration: mock Google Cloud สร้างครั้งแรก/รันซ้ำโดยคง secrets/storage และปฏิเสธ inherited public IAM; ยังไม่ใช่ cloud integration test
- API integration: unauthorized/origin/CSRF rejection, original hash, stale draft, owner access, forged/cross-document approval, cryptographic signing/download, QR minimal disclosure, request retry, tampered/appended PDF rejection, post-approval edit rejection, idempotency conflict, emergency lock, unsafe upload, trash/restore, audit chain, restart reconciliation และ logout
- Browser E2E: Thai PDF editor → actual preview → virtual WebAuthn user verification → signed download → public evidence; replay challenge ถูกปฏิเสธ และตรวจ viewport มือถือ
- Build, lint, TypeScript และ dependency audit; มี CI definition พร้อมรันเมื่อเก็บ repo ใน GitHub

Browser E2E ของ demo ใช้ virtual authenticator ใน Chrome จึงยังไม่แทนการทดสอบอุปกรณ์จริงทุกชนิด ผล cloud deployment และ browser smoke ของ production อยู่ในหัวข้อล่าสุดด้านบน ยังไม่มีผล Google login จนจบ callback, TDID signing, Acrobat/pyHanko compatibility หรือ production load/restore test; Docker Compose ตรวจ config ได้ แต่ยังไม่ได้รัน containers บนเครื่อง ส่วน image จริง build และรันบน Cloud Run แล้ว

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

Cloud deploy แยกจากข้อมูล SQLite/PDF เดิม ไม่อัปโหลดข้อมูลใน .local หรือ .env และยังใช้ certificate ทดสอบ ขนาด PDF cloud จำกัด 20 MiB; production profile แยกเปิด Gateway ผ่าน HTTPS + Google allowlist โดยไม่เปิด demo signing และเลือก Cloud HSM ได้ตามหัวข้อล่าสุด

## ประวัติการเพิ่ม production profile ก่อน HSM

ผู้ใช้แจ้งว่ามี Project, โดเมน HTTPS, Google OAuth, CER/CRT และสร้าง P12 แล้ว ภาพอีเมลแสดงขั้นตอนรวม cert.cer กับ cert.key เป็น P12; ยังไม่ได้เปิดไฟล์หรือยืนยัน private key/chain/policy/revocation จริง ไม่มีการส่งหรืออัปโหลด private key ในงานรอบนี้

เพิ่ม `.env.production.example` และ `--environment production --env-file .env.production`: ตรวจสิทธิ์ไฟล์/allowlisted keys, ส่ง OAuth secret เข้า Secret Manager ผ่าน stdin, pin/rotate version โดยไม่ใส่ค่าใน command/image; แยก environment labels, Cloud SQL HA + backups 30 ชุด/PITR, private internal services และเปิด Gateway หลังตรวจ auth/readiness จากนั้นตรวจ HTTPS origin ให้ถึง release จริง

Runtime ตรวจ production configuration ก่อน startup, ใช้ __Host- cookies, Google verified email/azp/required claims, ตรวจ allowlist ซ้ำเมื่ออ่าน session และปิด demo endpoint/test keys แก้ rate-limit plugin ให้ลงทะเบียนก่อน routes และมี database readiness; ยังไม่ได้เพิ่ม Cloud Armor/distributed limits, monitoring alerts หรือ automatic rollback

เพิ่ม `npm run cert:check -- --file /path/certificate.p12 --certificate /path/cert.cer` ให้ OpenSSL ถามรหัสผ่านใน Terminal และตรวจ key/cert/validity ใน memory ไม่อัปโหลดกุญแจหรือบันทึกรหัสผ่าน ผลมีเฉพาะข้อมูลสาธารณะ ไม่ใช่ chain/revocation/TDID policy validation ส่วน browser wrapped importer/HSM signer เพิ่มภายหลังตามหัวข้อล่าสุด

Tests เพิ่มสำหรับ runtime rejection, rate-limit regression, encrypted P12 จริงด้วย fixture, config/secret exclusion และ mock production deploy/redeploy/rotation/HA drift ผล deploy จริงอยู่ด้านบน ส่วนการลงนาม TDID และ production acceptance ตาม URS ยังไม่ผ่านรับมอบ

ผลตรวจช่วงเพิ่ม production profile ก่อน cloud deployment: TypeScript/lint/build ผ่าน, unit/integration tests รวม 35 cases ผ่าน (รวม Google claim/session policy เพิ่มเติม), browser E2E ของ demo ที่ build แล้ว 3 cases ผ่าน และ Docker Compose config ผ่าน การตรวจชุดนี้ไม่ได้ใช้ Google/TDID credentials จริง

## Email allowlist

ปรับตามคำขอให้ตั้ง GOOGLE_ALLOWED_EMAILS ด้วยอีเมลเริ่มต้นได้ ไม่ต้องหา sub รองรับหลายอีเมลแบบ exact match หลัง normalize case/whitespace; ตรวจ Google verified email และ Gmail/Workspace authority, ยังคง sub เป็น owner ID และตรวจ allowlist ซ้ำเมื่ออ่าน session เพิ่ม validator ร่วมสำหรับ runtime/deploy, ปรับตัวอย่าง env และส่งค่าเฉพาะ Identity ใน Cloud Run ค่า email มีผลเหนือ legacy sub list รวมถึงการตั้ง email ว่างจะไม่ fallback ไปเปิดสิทธิ์เดิม การเปลี่ยนจาก sub-only ต้อง login ใหม่เพื่อยืนยันอีเมล

ผลตรวจ email allowlist ก่อน cloud deployment: npm run check ผ่านทั้ง TypeScript, lint, unit/integration 38 cases และ build; ทดสอบการ normalize อีเมล, ปฏิเสธ unverified/บัญชีอื่น/aliases/third-party mailbox, ถอนสิทธิ์ session, legacy compatibility และส่ง email configuration เฉพาะ Identity ใน mock deployment แล้ว ผลนี้ยังไม่ใช่การทดสอบบัญชี Google จริงจนจบ login
