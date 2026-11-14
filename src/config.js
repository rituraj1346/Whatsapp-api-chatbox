import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Netlify bundles this file as CommonJS, where import.meta is empty (ROOT is only used on your own computer)
export const ROOT = import.meta.url ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : process.cwd();
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env is optional */ }

const env = process.env;
export const PORT = Number(env.PORT) || 3000;
export const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
/** Running as a Netlify Function (no disk, no long-lived connections). */
export const SERVERLESS = !!(env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME);
// Supabase: Postgres connection string (Connect → Transaction pooler) and the public anon key for live updates
export const DATABASE_URL = env.DATABASE_URL || env.SUPABASE_DB_URL || '';
export const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '';
/** https://<ref>.supabase.co, from SUPABASE_URL or worked out from the connection string. */
export const SUPABASE_URL = (() => {
  if (env.SUPABASE_URL) return env.SUPABASE_URL.replace(/\/$/, '');
  if (/^https:\/\/[\w-]+\.supabase\.co/.test(env.SUPABASE_DATABASE_URL || '')) return env.SUPABASE_DATABASE_URL.replace(/\/$/, ''); // Netlify's Supabase extension
  const ref = DATABASE_URL.match(/postgres\.([a-z0-9]{20})[:@]/)?.[1] || DATABASE_URL.match(/@db\.([a-z0-9]{20})\.supabase\.co/)?.[1];
  return ref ? `https://${ref}.supabase.co` : '';
})();
/** Fixed public address (else Netlify's site URL, else the address the browser used). */
export const PUBLIC_URL = (env.PUBLIC_URL || env.URL || '').replace(/\/$/, '');
// Test-only override
export const GRAPH_BASE_URL = (env.GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/$/, '');
export const DEFAULT_GRAPH_VERSION = 'v21.0';

/** Things missing from the hosting settings; the app shows them instead of starting. */
export const SETUP_MISSING = SERVERLESS ? [!DATABASE_URL && 'DATABASE_URL', !env.SECRET_KEY && 'SECRET_KEY'].filter(Boolean) : [];

function loadKey() {
  const k = env.SECRET_KEY;
  if (k) return /^[0-9a-fA-F]{64}$/.test(k) ? Buffer.from(k, 'hex') : crypto.createHash('sha256').update(k).digest();
  if (SERVERLESS) return null; // reported through SETUP_MISSING
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
export const SECRET_KEY = loadKey();

/** This app's public address, for Meta's webhook and push. */
export const originOf = req => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
