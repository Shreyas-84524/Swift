const { createClient } = require('@supabase/supabase-js');
const { loadEnvConfig } = require('@next/env');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  loadEnvConfig(path.join(__dirname, '..'));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const email = process.env.SWIFT_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.SWIFT_OWNER_PASSWORD;
  if (!url || !key || !email || !password) throw new Error('Set SUPABASE_URL, SUPABASE_SECRET_KEY, SWIFT_OWNER_EMAIL, and SWIFT_OWNER_PASSWORD. Never pass secrets as command-line arguments.');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let existing;
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error('Cannot list Supabase Auth users; check project and administrative key.');
    existing = data.users.find(user => user.email?.toLowerCase() === email);
    if (existing || data.users.length < 100) break;
  }
  const attributes = { email, password, email_confirm: true };
  const { data, error } = existing
    ? await client.auth.admin.updateUserById(existing.id, attributes)
    : await client.auth.admin.createUser(attributes);
  if (error || !data.user) throw new Error('Supabase owner provisioning failed; check the project password policy and Auth settings.');
  const file = path.join(__dirname, '../.env.local');
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  content = content.replace(/^SWIFT_OWNER_USER_ID=.*(?:\r?\n|$)/gm, '');
  fs.writeFileSync(file, `${content.trimEnd()}\nSWIFT_OWNER_USER_ID=${data.user.id}\n`, {mode:0o600});
  console.log('Supabase Auth owner provisioned. User ID saved to ignored .env.local. No password or administrative key saved.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
