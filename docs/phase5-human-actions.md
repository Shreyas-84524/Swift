# Swift Phase 5: Manual Human Actions Checklist

This document details the exact human portal click-paths and manual steps required across external cloud consoles, database dashboards, and physical devices to operate Swift in production.

---

## 1. Firebase Console Setup

1. **Project Registration**:
   - Go to [Firebase Console](https://console.firebase.google.com/).
   - Click **Add project** > Name it (e.g., `swift-sms-gateway`) > Disable Google Analytics (optional) > **Create project**.
2. **Android App Registration**:
   - In project overview, click the **Android** icon (`+ Add app`).
   - Package name: `com.multi.encription.sms` (must match `build.gradle.kts` exactly).
   - App nickname: `Swift Android Gateway`.
   - Click **Register app**.
   - Download `google-services.json` and save to local repository path:
     `app/google-services.json`.
3. **Generate Service Account for Backend FCM Dispatch**:
   - Click the gear icon ⚙️ next to **Project Overview** > **Project settings**.
   - Navigate to the **Service accounts** tab.
   - Click **Generate new private key** > Confirm **Generate key**.
   - Save the downloaded JSON securely on your local workstation.
   - Note the fields: `project_id`, `client_email`, and `private_key`.

---

## 2. Supabase / PostgreSQL Dashboard Setup

1. **Project Creation**:
   - Go to [Supabase Dashboard](https://supabase.com/dashboard).
   - Click **New project** > Select organization > Name project > Generate a strong database password > Select AWS region closest to your Vercel deployment.
2. **Run Migrations (Strict Order)**:
   - Navigate to **SQL Editor** in the left sidebar.
   - Sequentially open and run each migration from the `database/` folder:
     1. `database/schema.sql`
     2. `database/002_admin_portal.sql`
     3. `database/003_supabase_auth_rls.sql`
     4. `database/004_phase1_templates_and_push.sql`
     5. `database/005_phase1_corrections.sql`
     6. `database/006_phase2_outbox_push.sql`
     7. `database/007_phase4_outbox_recovery.sql`
     8. `database/008_phase5_hardening.sql`
3. **Connection Pooling Configuration**:
   - In left sidebar, click **Project Settings** (gear icon) > **Database**.
   - Scroll down to **Connection Pooling (Supavisor)**.
   - Copy the **Transaction Mode** URI (Port `6543`).
   - Use this URI as the `DATABASE_URL` in Vercel to prevent connection exhaustion during serverless scale.
4. **API Keys**:
   - Under **Project Settings** > **API**:
     - Copy `Project URL` -> `NEXT_PUBLIC_SUPABASE_URL`
     - Copy `anon public` key -> `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     - Copy `service_role secret` -> `SUPABASE_SERVICE_ROLE_KEY`
5. **Initial Owner Admin Provisioning**:
   - Navigate to **Authentication** > **Users** > **Add user** > **Create user**.
   - Enter owner email and a secure password.
   - Run the initial provisioning script locally:
     ```bash
     cd backend
     ADMIN_EMAIL="owner@yourdomain.com" npm run owner:configure
     ```

---

## 3. Vercel Hosting Dashboard Setup

1. **Import Repository**:
   - In [Vercel Dashboard](https://vercel.com/dashboard), click **Add New...** > **Project**.
   - Select the `SMS-Gateway-Free` repository.
   - Root directory: Set to `backend`.
2. **Environment Variables**:
   Under **Environment Variables**, configure:
   - `DATABASE_URL`: Transaction pooler string from Supabase.
   - `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL.
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key.
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key.
   - `FIREBASE_PROJECT_ID`: From service account JSON.
   - `FIREBASE_CLIENT_EMAIL`: From service account JSON.
   - `FIREBASE_PRIVATE_KEY`: Full private key string with `\n` line breaks.
   - For an external POST scheduler, set `OUTBOX_SCHEDULER_SECRET` to a random 64-character hex value (`openssl rand -hex 32`).
   - For Vercel Cron, set `CRON_SECRET` to a separate random value. Vercel Hobby's once-daily minimum is not sufficient for rapid recovery; use a suitable scheduler or plan.
   - Do not manually override `NODE_ENV` on Vercel.
3. **Deploy**:
   - Click **Deploy**.
   - Once deployed, copy your assigned production domain (e.g., `https://swift-gateway.vercel.app`).

---

## 4. Physical Android Device Preparation

1. **Hardware & SIM**:
   - Insert an active SIM card into SIM slot 1.
   - Confirm outgoing SMS works by sending a test SMS from the device's native Messages app.
   - Plug the phone into a reliable, continuous AC power adapter.
   - Connect phone to a stable 2.4GHz/5GHz Wi-Fi network.
2. **Android Developer Settings**:
   - Open **Settings** > **About phone** > Tap **Build number** 7 times.
   - Return to **Settings** > **System** > **Developer options**.
   - Enable **Stay awake** (screen stays awake while charging, recommended for maximum gateway uptime).
3. **App Permissions & Battery Whitelist**:
   - Install the signed release APK.
   - Open **Settings** > **Apps** > **Swift Gateway**:
     - **Permissions**: Grant `SMS` (Allow), `Phone` (Allow), `Notifications` (Allow).
     - **Battery**: Set to **Unrestricted** (do NOT use "Optimized" or "Restricted").
     - **Pause app activity if unused**: Toggle **OFF**.
4. **Gateway Enrollment**:
   - Open Swift Gateway app.
   - Enter your deployed Vercel domain URL.
   - In the Swift Admin Web Portal, navigate to **Gateways** > **Register Gateway** > generate a live gateway key (`otp_gw_live_...`).
   - Enter the key into the app and tap **Connect**.
   - Verify the status displays **Connected / Idle**.

---

## 5. Release Keystore Generation

For compiling release APKs for production distribution:

1. Generate a PKCS12 release keystore using Java `keytool`:
   ```bash
   keytool -genkey -v -keystore swift-release.keystore -alias swift-gateway -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Store `swift-release.keystore` outside version control in a secure vault (e.g. 1Password or HashiCorp Vault).
3. Configure `local.properties` (ignored by git) for signing:
   ```properties
   RELEASE_STORE_FILE=/path/to/swift-release.keystore
   RELEASE_STORE_PASSWORD=your_store_password
   RELEASE_KEY_ALIAS=swift-gateway
   RELEASE_KEY_PASSWORD=your_key_password
   ```
