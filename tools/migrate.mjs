// Brings the Supabase database up to date with supabase/schema.sql.
// Runs on every Cloudflare build (npm run build), before the site deploys.
// schema.sql is written so running it again is safe: it only creates or
// changes what's missing and never deletes data. The file is sent as one
// request, which Postgres runs as one transaction, so a failure changes
// nothing and stops the deploy.
//
// Needs the Cloudflare *build* secret SUPABASE_ACCESS_TOKEN (Supabase →
// Account → Access Tokens). The project is read from SUPABASE_URL in
// wrangler.jsonc. Without the token this does nothing, so local builds and
// tests still work. No packages needed: it uses Supabase's Management API.
import { readFile } from 'node:fs/promises';

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.log('SUPABASE_ACCESS_TOKEN is not set: skipping the database update.');
  process.exit(0);
}

// Cloudflare also builds other branches (preview versions); only the main
// branch may change the real database.
const branch = process.env.WORKERS_CI_BRANCH;
if (branch && branch !== (process.env.MIGRATE_BRANCH || 'main')) {
  console.log(`Branch "${branch}" is not main: skipping the database update.`);
  process.exit(0);
}

const root = new URL('../', import.meta.url);
const wrangler = await readFile(new URL('wrangler.jsonc', root), 'utf8');
const projectUrl = process.env.SUPABASE_URL || (wrangler.match(/"SUPABASE_URL"\s*:\s*"([^"]+)"/) || [])[1];
const ref = projectUrl && (projectUrl.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1];
if (!ref) {
  console.error('Could not find the Supabase project (SUPABASE_URL in wrangler.jsonc).');
  process.exit(1);
}

const sql = await readFile(new URL('supabase/schema.sql', root), 'utf8');
const api = process.env.SUPABASE_API_URL || 'https://api.supabase.com';
const res = await fetch(`${api}/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
if (!res.ok) {
  const body = (await res.text()).slice(0, 2000);
  console.error(`Database update failed (HTTP ${res.status}), nothing was changed:\n${body}`);
  if (res.status === 401 || res.status === 403) console.error('Check the SUPABASE_ACCESS_TOKEN build secret in Cloudflare.');
  process.exit(1);
}
console.log(`Database ${ref} is up to date with supabase/schema.sql.`);

// Sign-in safety settings (Supabase → Authentication). Applied on every main
// deploy so they can't drift: no public sign-ups (an admin adds everyone, in
// Settings → Users), passwords of 10+ characters, email changes confirmed on
// both addresses, and sign-in tokens that can only be used once. Plan-limited
// extras (leaked-password check) are tried separately and skipped if the plan
// doesn't have them. Set SKIP_AUTH_SETTINGS=1 to leave these alone.
if (!process.env.SKIP_AUTH_SETTINGS) {
  const patch = async (body, label) => {
    const r = await fetch(`${api}/v1/projects/${ref}/config/auth`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.ok) console.log(`Sign-in settings: ${label}.`);
    else console.warn(`Sign-in settings: couldn’t set ${label} (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
  };
  await patch({ disable_signup: true, password_min_length: 10, mailer_secure_email_change_enabled: true, refresh_token_rotation_enabled: true },
    'no public sign-ups, 10+ character passwords, confirmed email changes, one-time refresh tokens');
  await patch({ password_hibp_enabled: true }, 'refuse passwords known from data breaches');
  await patch({ security_update_password_require_reauthentication: true }, 'password changes straight from the browser need a recent sign-in (the site changes passwords through the Worker after checking the current password or security answers)');
}
