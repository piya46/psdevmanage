# Deploy Cloud Run ด้วยคำสั่งเดียว

เลือก `production` สำหรับ Google Login + HTTPS หรือ `demo` สำหรับทดลองผ่าน IAM proxy ทั้งสองแบบแยก deployment และข้อมูลกัน **TDID production signing ยังไม่เปิดใช้งาน**

## Production: ตั้งค่าครั้งแรก แล้ว deploy ด้วยคำสั่งเดียว

ส่วนนี้เป็น production deployment profile สำหรับพื้นที่จัดเก็บ/เตรียมเอกสาร **ยังไม่ใช่การรับมอบระบบลงนาม TDID ตาม URS** ผู้ใช้มี Project, โดเมน, OAuth Web Client, CER/CRT และแจ้งว่าสร้าง P12 แล้ว แต่ยังไม่ได้ตรวจไฟล์จริง, policy TDID หรือทำ cloud acceptance

สร้างไฟล์ตั้งค่าบนเครื่องก่อนครั้งแรก:

```sh
cp .env.production.example .env.production
chmod 600 .env.production
```

แก้ค่าใน `.env.production` ให้ครบ: Project ID, region/name, HTTPS origin, OAuth Web Client ID/Secret และ `GOOGLE_ALLOWED_EMAILS` (อีเมล Google ที่อนุญาตให้เข้าใช้งาน เช่น `yourname@gmail.com`; หลายบัญชีคั่นด้วย comma) จากนั้น:

```sh
# ตรวจค่าและแผน โดยไม่เรียก Google Cloud และไม่แสดง secrets
npm run deploy:gcp -- --environment production --env-file .env.production --dry-run

# สร้าง/อัปเดต production แล้วออก ไม่ต้องเปิด local proxy ค้างไว้
npm run deploy:gcp -- --environment production --env-file .env.production
```

ไฟล์ env ต้องมีสิทธิ์ 600 และใช้เฉพาะชื่อค่าที่ตัวอย่างระบุ สคริปต์อ่านเป็นข้อมูล ไม่ execute shell และไม่อัปโหลดไฟล์ env ทั้งไฟล์ ค่า `GOOGLE_CLIENT_SECRET` ส่งผ่าน stdin เข้า Secret Manager; ให้สิทธิ์อ่านเฉพาะ Identity และ pin เลขเวอร์ชัน เมื่อเปลี่ยนค่าแล้วรันซ้ำจะสร้างเวอร์ชันใหม่ ไม่เปลี่ยน database passwords หรือ service keys โดยอัตโนมัติ ค่า origin/client ID/allowlist เป็น runtime configuration ของบริการที่ต้องใช้ ห้ามใส่ P12/private key/password ของ P12 ใน env นี้

ค่าเริ่มต้น production ใช้ชื่อ `pston-prod` ห้ามใช้ชื่อทับ demo เดิม สคริปต์ตรวจ environment label ของ resources และปฏิเสธการสลับ environment บนข้อมูลชุดเดียวกัน ไม่ย้าย SQLite/PDF/บัญชี demo ขึ้น production

| ส่วน          | Production profile                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Runtime       | NODE_ENV=production, Google OIDC + email allowlist, ไม่มี demo login/test signer               |
| Browser       | HTTPS, Secure/HttpOnly/SameSite=Lax และ __Host- cookies, CSRF + exact origin                   |
| Internal APIs | Identity/Documents/Signing/Audit ยังต้องผ่าน Cloud Run IAM และ application service JWT         |
| Gateway       | เปิด roles/run.invoker ให้ allUsers เฉพาะ gateway หลัง smoke checks; API เอกสารต้อง login      |
| Cloud SQL     | PostgreSQL 17 Enterprise, regional HA, 2 vCPU / 7.5 GiB, SSD 50 GiB ขยายได้ถึง 100 GiB         |
| Backup        | Daily backup 30 ชุด, PITR/log retention 7 วัน, deletion protection; ยังต้อง restore drill      |
| Secrets       | แยกสิทธิ์รายบริการ, pin numeric version, ไม่มี test cert/key ใน production                     |
| Startup       | ปฏิเสธ HTTP origin, SQLite, ขาด credentials/bucket, demo signing หรือ URL ภายในที่ไม่ใช้ HTTPS |
| Readiness     | /ready ตรวจการเรียกบริการและ query ฐานข้อมูลทั้ง 4 บริการ พร้อม release marker                 |
| Signing       | ปิดไว้; CER/CRT นำเข้าเพื่อดู metadata ได้; P12 ตรวจบนเครื่องด้วย cert:check                   |

**ค่าใช้จ่าย:** HA Cloud SQL มีค่าเครื่องหลักและ standby ต่อเนื่อง แม้ Cloud Run scale ลง 0; ยังมีค่า disk/backups และบริการอื่น ค่า HA นี้สูงกว่า demo และเป็น tradeoff กับเป้าหมาย low fixed cost ใน URS สคริปต์ไม่ได้ตั้ง budget alert/hard spending cap ให้ ต้องคำนวณราคาตาม region และตั้ง budget ที่ project ก่อนใช้งานจริง ดู [Cloud SQL HA](https://docs.cloud.google.com/sql/docs/postgres/high-availability) และ [Pricing Calculator](https://cloud.google.com/products/calculator)

### ตั้งอีเมลที่เข้าใช้ได้

ใส่อีเมลเริ่มต้นในไฟล์ env ได้เลย ไม่ต้องค้นหา Google sub:

```dotenv
GOOGLE_ALLOWED_EMAILS=yourname@gmail.com
# หลายบัญชี: GOOGLE_ALLOWED_EMAILS=yourname@gmail.com,another@gmail.com
```

ระบบตรวจ ID token ของ Google รวม signature/issuer/audience/expiry, nonce และ `email_verified=true` ก่อนเทียบอีเมล ไม่สนตัวพิมพ์ใหญ่เล็กและตัดช่องว่างรอบรายการ แต่ไม่รวม Gmail dot/plus aliases และไม่รับ wildcard หรืออนุญาตทั้งโดเมน มีเพียงอีเมลที่ตั้งไว้เท่านั้นที่เข้าใช้ได้ ไม่มีการเปิดรับผู้ใช้คนแรกโดยอัตโนมัติ

Email allowlist รองรับ Gmail และ Google Workspace ที่ Google เป็นผู้ยืนยันเจ้าของอีเมล (มี `hd` claim สำหรับ Workspace) บัญชี Google ที่ใช้ mailbox ของผู้ให้บริการอื่นต้องมีกระบวนการพิสูจน์เจ้าของเพิ่มเติมก่อนรองรับ ดู [ข้อกำหนดการตรวจ Google ID token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)

Google `sub` ยังเป็นรหัสเจ้าของเอกสาร/session/Passkey ภายใน ไม่ย้ายหรือรวมเอกสารตามอีเมล หากเปลี่ยน allowlist ให้ deploy ใหม่; session ของอีเมลที่ถูกนำออกจะถูกปฏิเสธในคำขอถัดไปหลังใช้ configuration ใหม่ การสลับจาก sub allowlist มาเป็น email ต้อง login ใหม่หนึ่งครั้งเพื่อยืนยันอีเมล

ยังรองรับ `GOOGLE_ALLOWED_SUBS` เดิมหากไม่ได้กำหนด `GOOGLE_ALLOWED_EMAILS` แต่เมื่อกำหนด EMAILS จะใช้เฉพาะอีเมล แม้ SUBS เดิมยังอยู่ก็ไม่ให้สิทธิ์เพิ่ม หากตั้ง EMAILS ว่าง production จะปฏิเสธ startup/deploy แนะนำลบบรรทัด SUBS เดิมเมื่อย้ายมาใช้อีเมล

### โดเมนและ Google OAuth ก่อนใช้งาน

ตั้ง Authorized JavaScript origin ให้ตรง `WEB_ORIGIN` และ Authorized redirect URI เป็น `WEB_ORIGIN/api/auth/google/callback` ใน OAuth Web Client ตัวเดียวกัน ตั้ง consent screen/test users หรือ publish ตาม audience ที่ต้องการ สคริปต์ไม่แก้ OAuth Console ให้ ดู [Google OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server)

โดเมนต้องมี TLS และ route มายัง `pston-prod-gateway` ผ่านการตั้งค่า Google Cloud ที่รองรับแล้ว สคริปต์ไม่เปลี่ยน DNS ที่ registrar หรือสร้าง HTTPS load balancer อัตโนมัติ หากยังไม่พร้อม สามารถใช้ deterministic Cloud Run URL เป็น origin ตั้งแต่แรก เช่น `https://pston-prod-gateway-PROJECT_NUMBER.asia-southeast1.run.app` โดยแทน PROJECT_NUMBER จริงและตั้ง OAuth redirect ให้ตรง ดู [Cloud Run URLs](https://docs.cloud.google.com/run/docs/custom-urls) การเปลี่ยน origin ภายหลังอาจทำให้ Passkey เดิมใช้ไม่ได้เพราะผูก RP ID; ควรเลือกโดเมนถาวรก่อนลงทะเบียน

หากต้องการ deploy ก่อน map โดเมน ให้อ่าน Project Number ด้วย `gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)'` แล้วตั้ง `WEB_ORIGIN` ใน `.env.production` เป็น Cloud Run URL ข้างต้น ตั้ง OAuth Authorized JavaScript origin เป็น URL เดียวกัน และ Authorized redirect URI เป็น URL นั้นต่อท้าย `/api/auth/google/callback` จากนั้นรันคำสั่ง deploy เดิมได้ การใช้ URL นี้ยังตรวจ HTTPS, readiness และการบังคับ login ตาม production profile ครบ ไม่ต้องตั้ง DNS ก่อน

ก่อนเปิด gateway สคริปต์ตรวจ Google mode, database readiness, demo login ต้อง 404, documents ต้อง 401 เมื่อไม่มี session และ redirect/cookie Google ถูกต้อง จากนั้นตรวจ HTTPS origin ว่าถึง release ที่ deploy จริง **การตรวจ redirect ยังไม่พิสูจน์ว่า OAuth secret ถูกต้องหรือ login Google จริงสำเร็จ** ต้องทดสอบ allowlisted account, บัญชีที่ถูกปฏิเสธ, logout/session timeout และ Passkey จริงด้วย

หาก domain probe ล้มเหลวหลังเปิด gateway สคริปต์จะหยุดพร้อม error และคง resources ไว้ Gateway ยังเปิดหน้า login ได้ แต่เอกสารยังต้องยืนยันตัวตน แก้ DNS/TLS/routing แล้วรันคำสั่งเดิมซ้ำ การอัปเดตใช้ rolling revisions รายบริการ ยังไม่มี atomic release/canary หรือ automatic rollback; ห้ามอัปเดตแบบ breaking API/schema จนมี migration plan

### ตรวจ P12 ของ TDID บนเครื่อง

คำสั่ง export ในอีเมลใช้ `-inkey cert.key`: หากสร้าง P12 สำเร็จ จะบรรจุทั้งใบรับรองและ private key แต่สถานะในอีเมลไม่แทนการตรวจ validity/revocation ณ เวลาลงนาม ตรวจไฟล์จริงโดยไม่ส่งกุญแจหรือรหัสผ่านขึ้น server:

```sh
npm run cert:check -- --file /absolute/path/certificate.p12 --certificate /absolute/path/cert.cer
```

กรอกรหัสผ่านเมื่อ OpenSSL ถามใน Terminal (ไม่แสดงตัวอักษร) เครื่องมือตรวจว่ามี private key เดียว, certificate ตรงกับ key และ CER/CRT ที่ระบุ, ไม่ใช่ CA, อยู่ในช่วงอายุ และรายงาน algorithm/fingerprint สาธารณะ พร้อมความเข้ากันได้เบื้องต้นกับ RSA-SHA256 HSM ไม่บันทึก key/password เป็นไฟล์, ไม่เรียก Google Cloud และไม่เปิด signing ส่วนข้อมูลที่ decrypt จะอยู่ชั่วคราวในหน่วยความจำของ process บนเครื่องที่เชื่อถือได้ จึงไม่ใช่การรับรอง secure memory erasure เครื่องมือยังไม่ตรวจ trust chain, KeyUsage/EKU/policy, revocation หรือ TSA

ขั้นต่อไปตาม URS คือยืนยัน TDID อนุญาตให้นำกุญแจไปใช้ใน HSM, ตรวจ certificate policy/algorithm/chain, ใช้ trusted importer แปลงเป็น PKCS#8 DER และ wrap ด้วย Cloud KMS ImportJob ก่อนส่งขึ้น cloud, ผูก certificate กับ key version แบบตายตัว และให้ Signing SA เฉพาะสิทธิ์ asymmetricSign ของ key นั้น ห้ามนำ raw P12/password ไปเก็บใน app env, Secret Manager หรือ API ของแอปแทนขั้นตอนนี้ ปัจจุบันยังไม่มี wrapped importer หรือ HSM signing adapter ใน repo นี้ ดู [Key import](https://docs.cloud.google.com/kms/docs/key-import) และ [Key wrapping](https://docs.cloud.google.com/kms/docs/key-wrapping)

### งานรับมอบก่อนเปิดใช้งานจริง

- ทดสอบ IAM จริงทุกบริการ, deny ของบัญชีที่ไม่อยู่ใน allowlist, OAuth/Passkey จริง และ dependency/image vulnerability scan
- ตั้ง Cloud Monitoring uptime check ที่ /ready, แจ้งเตือน 5xx/latency, DB disk/connections, outbox ค้าง และ Billing budget ให้ทีมรับผิดชอบ; สคริปต์ยังไม่สร้าง alert policies/notification channels
- ทดสอบ restore SQL+PDF และจับคู่ hash, rollback revision ที่เข้ากันได้กับ schema, บันทึก RPO/RTO และทดสอบ secret rotation/recovery
- Rate limit ปัจจุบันอยู่ในแต่ละ instance และใช้ peer IP โดยไม่เชื่อ X-Forwarded-For จาก client; ยังไม่ใช่ distributed abuse protection ควรใช้ Load Balancer/Cloud Armor พร้อมปิด ingress ตรงตาม deployment design และทำ load test ก่อนเปิดวงกว้าง
- ก่อนเปิด TDID signing ต้องผ่าน HSM import/provider, audit KMS, chain/revocation/time policy, independent PDF validator และการรับมอบตาม URS

## Demo ผ่าน IAM proxy

รันจากโฟลเดอร์โปรเจกต์ โดยแทน `YOUR_PROJECT_ID` ด้วย Project ID ที่ตั้งใจใช้และเปิด Billing แล้ว:

```sh
npm run deploy:gcp -- --project YOUR_PROJECT_ID
```

สคริปต์สร้าง **Cloud Run 5 บริการ**, build React/Node.js ด้วย Cloud Build, จัดเตรียม Cloud SQL PostgreSQL, Cloud Storage, Secret Manager และ IAM แล้วตรวจการเชื่อมต่อก่อนเปิดเบราว์เซอร์ที่ **http://localhost:5180** ผ่าน Cloud Run proxy ตัวแอปและข้อมูลรันบน Google Cloud; เครื่องคุณทำหน้าที่ proxy ที่ยืนยันตัวตนด้วยบัญชี Google เท่านั้น

ต้องมี **Node.js 22.13–22.x, npm, Google Cloud CLI และ OpenSSL 3.x** ไม่ต้องเปิด Docker ในเครื่อง และไม่ต้องสร้าง `.env` สำหรับ cloud สคริปต์เรียก `gcloud auth login` หากยังไม่มีบัญชีและรันใน interactive terminal ตัว Cloud Run proxy อาจขอติดตั้ง component เพิ่มเมื่อใช้ครั้งแรก โปรดติดตั้ง Google Cloud CLI รุ่นที่รองรับ `gcloud run services proxy`

บัญชี deploy ต้องสร้างทรัพยากร เปิด APIs, ใช้ service accounts, อ่าน/สร้าง secret versions และแก้ IAM ของ project/resources ได้ เช่น Project Owner ใน **โปรเจกต์ทดลองเฉพาะ** ที่ผู้ดูแลอนุญาต หรือชุด custom roles ที่ครอบคลุมสิทธิ์เหล่านี้ สคริปต์ไม่เพิ่ม Owner/Editor ให้บัญชี runtime และไม่เลือก active project ของ gcloud โดยอัตโนมัติ นโยบายองค์กรหรือ quota ที่ห้าม public-IP Cloud SQL, service-account creation หรือ region นี้ต้องให้ผู้ดูแลแก้ก่อน

## คำสั่งใช้งาน

```sh
# ดูรายการทรัพยากรและไฟล์ที่จะอัปโหลด โดยไม่ติดต่อ Google Cloud
npm run deploy:gcp -- --project YOUR_PROJECT_ID --dry-run

# เปลี่ยนชื่อ deployment, region และพอร์ต (ใช้ค่าเดิมทุกครั้งเมื่ออัปเดต)
npm run deploy:gcp -- --project YOUR_PROJECT_ID --name pston-dev --region asia-southeast1 --port 5180

# Deploy แล้วจบคำสั่ง โดยไม่เปิด proxy
npm run deploy:gcp -- --project YOUR_PROJECT_ID --no-proxy

# เปิดเว็บอีกครั้งโดยไม่ build/deploy ใหม่
npm run deploy:gcp -- --project YOUR_PROJECT_ID --connect
```

ค่าเริ่มต้นคือ `pston-dev`, region Singapore `asia-southeast1`, พอร์ต `5180` กด Ctrl+C เพื่อปิด proxy ได้ โดย cloud services และข้อมูลยังอยู่ การอัปเดตโค้ดใช้คำสั่ง deploy เดิม สคริปต์ตรวจป้ายเจ้าของ resource ก่อนใช้ซ้ำ และเก็บ keys/passwords/database/PDF เดิมไว้ หากเปลี่ยนพอร์ตต้อง deploy อีกครั้งเพื่อปรับ Origin และ WebAuthn configuration

`--no-proxy` ยังให้ URL `*.run.app` แต่ URL นั้นต้องผ่าน Google IAM จึงเปิดตรงจาก browser ที่ไม่มี ID token ไม่ได้ ใช้ `--connect` เพื่อเปิดผ่าน proxy ข้อมูล deployment ล่าสุดที่ไม่มี secret อยู่ใน `.local/gcp-deploy/<project>/<region>/<name>/last-deployment.json`

## สิ่งที่สคริปต์จัดเตรียม

| ส่วน               | ค่าเริ่มต้น / ขอบเขต                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run          | `gateway`, `identity`, `documents`, `signing`, `audit`; แยก service account; เปิด IAM invoker check; ไม่มี `allUsers`                                                 |
| React              | build แล้วเสิร์ฟจาก Gateway ใช้ API origin เดียวกัน                                                                                                                   |
| Scaling            | 0–2 instances ต่อบริการ, CPU 1; Documents 2 GiB / concurrency 2, Signing 1 GiB / concurrency 2, Gateway 1 GiB / concurrency 8, Identity/Audit 512 MiB / concurrency 8 |
| Cloud SQL          | PostgreSQL 17 Enterprise, 1 vCPU / RAM 3.75 GiB, SSD 10 GiB ขยายอัตโนมัติถึง 100 GiB, zonal                                                                           |
| Database isolation | ฐานข้อมูลและ login role แยก Identity/Documents/Signing/Audit; ไม่มีสิทธิ์ข้ามฐาน; Gateway ไม่ต่อ DB                                                                   |
| SQL connection     | Cloud SQL connector ผ่าน Unix socket; กำหนด connector required; ไม่มี authorized networks; pool สูงสุด 3 connections ต่อ instance                                     |
| Object storage     | bucket PDF สำหรับ Documents และผลลงนามสำหรับ Signing แยกกัน; public access prevention, uniform IAM, versioning และ soft delete 7 วัน                                  |
| PDF permissions    | บริการอ่านและสร้าง object ของตัวเองเท่านั้น; เขียนแบบ `ifGenerationMatch=0` เพื่อห้ามทับหลักฐานเดิม                                                                   |
| Secret Manager     | private service keys, database passwords และใบรับรองทดสอบ; pin version; แต่ละ runtime อ่านเฉพาะ secret ของตัวเองและ public-key map                                    |
| Build              | Artifact Registry + Cloud Build service account; source bucket แยกและลบ source เก่าเมื่ออายุเกิน 7 วัน                                                                |
| Database bootstrap | Cloud Run Job แยกบัญชีสำหรับสร้าง roles/databases; ลบ job หลังสำเร็จ ไม่ส่ง admin password ให้ runtime                                                                |
| Audit delivery     | state และ outbox commit พร้อมกัน; flush ขณะตอบคำขอ; Scheduler 3 jobs เรียก drain ด้วย Google IAM ทุกนาที                                                              |
| Backup             | Cloud SQL daily backup 7 ชุด + point-in-time recovery; ป้องกันลบ instance; ยังต้องทดสอบ restore จริง                                                                  |

Cloud SQL มี IP สำหรับ Cloud SQL connector แต่ไม่ได้เปิด PostgreSQL ให้ IP ทั่วไปเชื่อมต่อโดยตรง ส่วน Cloud Run รับ ingress ผ่าน endpoint ที่ป้องกันด้วย IAM การเรียกระหว่างบริการใช้ Google ID token ใน `X-Serverless-Authorization` ร่วมกับ application service JWT ที่ผูก audience/caller/actor

Scheduler เรียกได้เฉพาะ services ที่มี outbox ส่วน endpoint drain ไม่รับเอกสารหรือคืนข้อมูลผู้ใช้ เมื่อ audit ปลายทางล่ม event จะอยู่ในฐานข้อมูลต่อและลองใหม่ ระบบยังไม่มี independent checkpoint หรือ WORM

## ข้อมูลเดิมและข้อจำกัดรุ่นนี้

- เป็น **cloud environment สำหรับทดลอง** ใช้ใบรับรอง Self-signed ที่สร้างใหม่สำหรับ deployment ไม่ใช่ TDID ส่วน production profile แยกใช้ Google Login และปิด signing
- แยกจากข้อมูลใน `.local` ของเครื่อง: ไม่อัปโหลด SQLite, PDF, private keys เดิม, `.env`, P12/PFX หรือเอกสาร URS การย้ายข้อมูลเดิมต้องทำ migration พร้อมตรวจ hash/owner/certificate เพิ่มต่างหาก
- โหมด demo ใช้เจ้าของพื้นที่ทดลองร่วมกัน จึงให้สิทธิ์ Gateway เฉพาะผู้ deploy; อย่าเปิดสาธารณะก่อนทำ Google OIDC/allowlist และ acceptance สำหรับ production
- PDF บน Cloud Run จำกัด **20 MiB** รวมผล compose/prepare เพื่อให้ JSON/base64 ระหว่างบริการอยู่ใต้เพดาน HTTP/1 32 MiB ส่วน local ยังรับ 50 MiB เส้นทาง private direct/resumable upload สำหรับไฟล์ใหญ่ยังไม่ทำ
- URL ใน QR ใช้ browser origin `localhost` ของ deployment นี้ จึงยังไม่ใช่ public verification link สำหรับส่งให้บุคคลภายนอก
- Transactions ในแต่ละบริการ serialize ด้วย PostgreSQL advisory lock เพื่อกัน approval ใช้ซ้ำและรักษา audit chain เหมาะกับช่วงทดลองผู้ใช้จำนวนน้อย ยังไม่ใช่ผลทดสอบ load/HA
- ไม่เก็บ metadata หรือ PDF ถาวรใน container filesystem; ใช้ `/tmp` เฉพาะงานประมวลผลชั่วคราว หาก service หยุดระหว่างลงนาม ให้รอ request หมดอายุและ grace 5 นาที แล้ว reconcile จากผลเดิมโดยไม่เซ็นซ้ำ

## ค่าใช้จ่ายและการหยุดใช้งาน

Cloud Run ใช้ request-based billing และ min instances 0 แต่ Scheduler จะปลุกบางบริการทุกนาที **Cloud SQL คิดค่าเครื่องต่อเนื่องแม้ไม่มีผู้ใช้งาน** และยังมีค่า storage, backups, builds, Artifact Registry, secrets, scheduler และ network ตามการใช้จริง ไม่ได้ตั้ง hard budget cap ให้โดยอัตโนมัติ ดูราคาที่ [Google Cloud Pricing Calculator](https://cloud.google.com/products/calculator) และตั้ง Billing budget/alert ใน project

ปิด terminal ปิดเพียง proxy หากต้องพักสภาพแวดล้อม ให้ pause Scheduler ทั้ง 3 jobs ใน console แล้วหยุด Cloud SQL ผ่านหน้า instance หรือคำสั่งนี้:

```sh
gcloud sql instances patch pston-dev-sql --activation-policy=NEVER --project YOUR_PROJECT_ID
```

ข้อมูลบน disk/backups/artifacts/secrets ยังมีค่าเก็บรักษาระหว่างหยุด หากกลับมาใช้ ให้เปิด Cloud SQL ด้วย `--activation-policy=ALWAYS`, resume Scheduler และ `--connect` สคริปต์ไม่ลบข้อมูลเพื่อประหยัดค่าใช้จ่ายให้อัตโนมัติ

## หากหยุดที่ Billing not enabled

ตรวจ Project ID ที่ระบุใน `PSTON_GCP_PROJECT` ของ env ก่อน แล้วดูสถานะ:

```sh
gcloud billing projects describe YOUR_PROJECT_ID
gcloud billing accounts list --filter='open=true'
```

หาก `billingEnabled: false` และ `billingAccountName` ว่าง หมายถึงยังไม่ผูกบัญชี Billing ถ้ามีชื่อบัญชีแล้วแต่ยัง false ให้ตรวจสถานะบัญชีและการชำระเงินใน Cloud Billing การเปิด Billing ต้องเชื่อม project กับบัญชีที่ active; รายชื่อบัญชีที่อ่านได้ไม่ได้หมายความว่ามีสิทธิ์เชื่อมทุกบัญชี ดู [วิธีเปิด Billing และสิทธิ์ที่ต้องมี](https://docs.cloud.google.com/billing/docs/how-to/modify-project)

เลือกบัญชีที่จะรับค่าใช้จ่ายของโปรเจกต์ แล้วเชื่อมผ่าน Console → Billing หรือคำสั่งนี้โดยแทน ID ที่เลือกจริง:

```sh
gcloud billing projects link YOUR_PROJECT_ID --billing-account=BILLING_ACCOUNT_ID
gcloud billing projects describe YOUR_PROJECT_ID --format='value(billingEnabled)'
```

เมื่อเป็น `True` ให้รัน deploy เดิมอีกครั้ง สคริปต์ตรวจ Billing ก่อน enable APIs และสร้าง resources จึงไม่ต้องลบ database/buckets เพื่อแก้ข้อผิดพลาดนี้ และจะไม่เลือกหรือเชื่อม billing account ให้อัตโนมัติ

### หากเชื่อม Billing แล้วพบ Cloud billing quota exceeded

บัญชี Billing ที่มี `open=true` ยังอาจติดโควต้าจำนวนโปรเจกต์ที่เปิด Billing ได้ เมื่อคำสั่ง link คืน `FAILED_PRECONDITION / google.rpc.QuotaFailure` พร้อมข้อความนี้ ให้ตรวจสถานะ project อีกครั้ง แล้วใช้ [แบบฟอร์มขอเพิ่ม Billing project quota](https://support.google.com/code/contact/billing_quota_increase) ตามลิงก์ที่ Google ส่งกลับ ระบุบัญชี Billing, อีเมล, จำนวนโปรเจกต์ที่ต้องการเพิ่ม และเหตุผลการใช้บริการแบบมีค่าใช้จ่าย

ตัวอย่าง PSTON ต้องเพิ่มเพียง 1 project slot สำหรับ project เดิมที่ยังผูกไม่ได้ ไม่จำเป็นต้องสร้าง project แยกให้แต่ละ microservice โควต้าของแต่ละบัญชีไม่เท่ากัน; จำนวน project ที่ list ได้ไม่ใช่การอ่านค่าขีดจำกัดโควต้าโดยตรง การอนุมัติเป็นของ Google และไม่มีผลทันทีจากการแก้ env หรือรัน deploy ซ้ำ ดู [Project quota requests](https://support.google.com/cloud/answer/6330231)

คง project เดิมไว้ระหว่างรออนุมัติ การ unlink/delete project อื่นอาจหยุดบริการที่ใช้งานอยู่และไม่ใช่ขั้นตอนแก้ปัญหาของสคริปต์นี้ หากเลือกใช้บัญชี Billing อื่น ต้องเลือกบัญชีที่รับค่าใช้จ่ายให้ชัดเจนก่อนเชื่อม

## เมื่อ deploy ไม่สำเร็จ / อัปเดต / ย้อนรุ่น

สคริปต์หยุดที่ขั้นตอนที่ผิดพลาดและคงข้อมูลไว้ ไม่ rollback หรือลบฐานข้อมูลให้เอง แก้ permission/quota/build ที่รายงานแล้วรันคำสั่งเดิมซ้ำ หาก Cloud SQL ยังสร้างไม่เสร็จให้รอ operation ใน console สำเร็จก่อน หาก init job ล้มเหลวจะคง job ไว้ให้ตรวจ logs; job ใช้ admin secret เฉพาะบัญชี bootstrap

Cloud Run มี revision เดิมไว้สำหรับเปลี่ยน traffic กลับทาง console การอัปเดตครั้งนี้ใช้ schema แบบสร้างเพิ่มเท่านั้น **การย้อน image ไม่ได้ย้อนข้อมูลในฐาน** ควรสำรองข้อมูลและตรวจ compatibility ก่อนเปลี่ยน schema ในอนาคต Cloud SQL backup กับ object versions ช่วยกู้ข้อมูลได้ แต่ยังไม่มีหลักฐาน restore drill ของระบบนี้

ดู logs ตัวอย่าง (เปลี่ยนชื่อ/region หากเลือกค่าอื่น):

```sh
gcloud run services logs read pston-dev-gateway --region asia-southeast1 --project YOUR_PROJECT_ID --limit 50
gcloud run services logs read pston-dev-documents --region asia-southeast1 --project YOUR_PROJECT_ID --limit 50
```

ปัญหาที่พบบ่อย: เปิด Billing ไม่ครบ, API/IAM ยัง propagate, port 5180 ชน, Cloud Run proxy component ไม่พร้อม, secret ที่ผู้ดูแลหมุนเวอร์ชันแล้วไม่ตรงกัน หรือ quota/นโยบายองค์กรขัดกับ resource ที่สร้าง อย่าส่ง secret values หรือ private keys ลง chat/log เพื่อแก้ปัญหา

หากพบ `gcloud ... did not return valid JSON` ให้ตรวจ `gcloud info --format='value(basic.python_location,basic.python_version)'` บน macOS ที่ยังใช้ Python 3.9 เคยพบ `importlib.metadata` ไม่มี `packages_distributions` และข้อความ error ปนกับ JSON ของคำสั่ง Storage แม้ exit code เป็น 0 ต้องแก้ Python ที่ gcloud ใช้ ไม่ควรตัดข้อความ error ทิ้งแล้วฝืนใช้ผลลัพธ์ ดู [การติดตั้งและ Python ที่รองรับ](https://docs.cloud.google.com/sdk/docs/install-sdk) เช่นติดตั้ง `python@3.13` ผ่าน Homebrew แล้วกำหนด `CLOUDSDK_PYTHON` ให้ชี้ interpreter นั้น หรือสร้างและเปิดใช้ virtualenv ของ gcloud ก่อนรัน deploy ซ้ำ สคริปต์รายงานชื่อคำสั่ง/HTTP status โดยไม่พิมพ์ response ที่อาจมีข้อมูลลับ

## หลักฐานทดสอบ

มี unit tests สำหรับ PostgreSQL engine ผ่าน PGlite และ SQLite, transaction rollback/outbox/approval concurrency; storage adapter tests สำหรับ create-only PDF objects; mock Google Cloud orchestration สำหรับสร้างครั้งแรก/รันซ้ำและ IAM; API integration และ browser E2E ของ application เส้นทางลงนาม

**ยังไม่ได้ deploy ไปยัง project จริงในรอบนี้** และไม่ได้ทดสอบ Cloud SQL/Cloud Storage/IAM จริง, billing, Cloud Run cold start/load หรือ restore drill การทดสอบ mock ตรวจลำดับและ configuration ของสคริปต์ ไม่ทดแทน cloud acceptance

อ้างอิง: [Cloud SQL จาก Cloud Run](https://docs.cloud.google.com/sql/docs/postgres/connect-run), [Service-to-service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service), [Private service proxy](https://docs.cloud.google.com/run/docs/authenticating/developers), [Cloud Run limits](https://docs.cloud.google.com/run/quotas), [Cloud Storage preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
