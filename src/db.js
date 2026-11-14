import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import postgres from 'postgres';
import { DATA_DIR, DATABASE_URL } from './config.js';

/** Which account (username) the current request works for. Each account is a separate business. */
export const tenant = new AsyncLocalStorage();
export const acct = () => tenant.getStore()?.account || '';
/** The current account; throws instead of touching shared rows when there is none. */
const A = () => { const a = acct(); if (!a) throw new Error('No account for this request'); return a; };
/** Body parsers continue in the socket's async context; this keeps the request's account. */
export const keep = mw => (req, res, next) => mw(req, res, AsyncResource.bind(next));

// Supabase exposes the public schema through its REST API; RLS with no policies keeps these tables private.
const TABLES = ['contacts', 'messages', 'settings', 'sessions', 'quick_replies', 'auto_reply_log', 'push_subscriptions', 'login_fails', 'users'];
export const ACCOUNT_TABLES = ['contacts', 'messages', 'settings', 'quick_replies', 'auto_reply_log', 'push_subscriptions'];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  account TEXT NOT NULL DEFAULT '', wa_id TEXT NOT NULL, name TEXT, custom_name TEXT, last_inbound_at BIGINT, last_message_at BIGINT,
  PRIMARY KEY (account, wa_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY, account TEXT NOT NULL DEFAULT '', wamid TEXT UNIQUE, wa_id TEXT NOT NULL,
  direction TEXT NOT NULL, type TEXT, body TEXT, media_id TEXT, media_mime TEXT, filename TEXT,
  status TEXT, error TEXT, seen INT DEFAULT 0, timestamp BIGINT, raw TEXT
);
CREATE TABLE IF NOT EXISTS settings (account TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, value TEXT, PRIMARY KEY (account, key));
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at BIGINT, unlocked_until BIGINT DEFAULT 0);
CREATE TABLE IF NOT EXISTS quick_replies (id BIGSERIAL PRIMARY KEY, account TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auto_reply_log (account TEXT NOT NULL DEFAULT '', wa_id TEXT NOT NULL, last_away BIGINT, PRIMARY KEY (account, wa_id));
CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, account TEXT NOT NULL DEFAULT '', keys TEXT NOT NULL, device TEXT, created_at BIGINT);
CREATE TABLE IF NOT EXISTS login_fails (ip TEXT PRIMARY KEY, count INT NOT NULL, reset_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, owner BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS username TEXT;
-- Tables made by the single-business version get an account column (hasUsers in auth.js fills it in)
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['${ACCOUNT_TABLES.join("','")}'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'account') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN account TEXT NOT NULL DEFAULT %L', t, '');
      IF t IN ('contacts', 'settings', 'auto_reply_log') THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_pkey');
        EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (account, %I)', t, CASE t WHEN 'settings' THEN 'key' ELSE 'wa_id' END);
      END IF;
    END IF;
  END LOOP;
END $$;
DROP INDEX IF EXISTS messages_wa;
CREATE INDEX IF NOT EXISTS messages_account_wa ON messages(account, wa_id, timestamp);
${TABLES.map(t => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n')}
`;

async function open() {
  if (DATABASE_URL) { // Supabase (or any Postgres)
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
    const sql = postgres(DATABASE_URL, {
      max: 1, idle_timeout: 20, prepare: false, ssl: local ? false : 'require', onnotice: () => {},
      types: { int8: { to: 20, from: [20], serialize: String, parse: Number } }, // ms timestamps and counts as numbers
    });
    try { await sql.unsafe(SCHEMA); } catch { await sql.unsafe(SCHEMA); } // two cold starts can race on CREATE TABLE
    return (text, params) => sql.unsafe(text, params);
  }
  // On your own computer: a built-in Postgres stored in data/pg. Not a static import, so Netlify's bundle leaves it out.
  const pkg = '@electric-sql/pglite';
  const { PGlite } = await import(pkg);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new PGlite(path.join(DATA_DIR, 'pg'));
  await db.exec(SCHEMA);
  return async (text, params) => (await db.query(text, params)).rows;
}
let client;
/** Runs one SQL statement ($1, $2 … parameters) and returns the rows. */
export async function q(text, params = []) {
  client ||= open().catch(e => { client = null; throw e; });
  return (await client)(text, params);
}
const one = async (text, params) => (await q(text, params))[0];

const RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

export const getContact = waId => one('SELECT * FROM contacts WHERE account = $1 AND wa_id = $2', [A(), waId]);

/** Creates/updates a contact. Returns true if this is their first ever inbound message. */
export async function touchContact(waId, { name, ts, inbound }) {
  const c = await getContact(waId);
  if (!c) {
    const created = await q(`INSERT INTO contacts (account, wa_id, name, last_inbound_at, last_message_at) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (account, wa_id) DO NOTHING RETURNING wa_id`, [A(), waId, name || null, inbound ? ts : null, ts]);
    if (created.length) return !!inbound;
  }
  await q(`UPDATE contacts SET name = COALESCE($1, name),
      last_inbound_at = CASE WHEN $2::boolean THEN GREATEST(COALESCE(last_inbound_at, 0), $3::bigint) ELSE last_inbound_at END,
      last_message_at = GREATEST(COALESCE(last_message_at, 0), $3::bigint) WHERE account = $4 AND wa_id = $5`,
  [name || null, !!inbound, ts, A(), waId]);
  return !!inbound && !c?.last_inbound_at;
}

export async function renameContact(waId, customName) {
  return (await q('UPDATE contacts SET custom_name = $1 WHERE account = $2 AND wa_id = $3 RETURNING wa_id', [customName || null, A(), waId])).length > 0;
}

/** Inserts unless the wamid exists. Returns the stored row, or null if it was a duplicate. */
export async function insertMessage(m) {
  return (await one(`INSERT INTO messages
    (account, wamid, wa_id, direction, type, body, media_id, media_mime, filename, status, error, seen, timestamp, raw)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (wamid) DO NOTHING RETURNING *`, [
    A(), m.wamid, m.wa_id, m.direction, m.type || 'text', m.body ?? null, m.media_id ?? null, m.media_mime ?? null,
    m.filename ?? null, m.status ?? null, m.error ?? null, m.direction === 'out' ? 1 : 0, m.timestamp,
    m.raw ? JSON.stringify(m.raw) : null])) || null;
}

/** Status only moves forward. Returns the updated row or null. */
export async function updateStatus(wamid, status, error) {
  const m = await one('SELECT * FROM messages WHERE account = $1 AND wamid = $2', [A(), wamid]);
  if (!m || !(status in RANK) || RANK[status] <= (RANK[m.status] ?? -1)) return null;
  await q('UPDATE messages SET status = $1, error = COALESCE($2, error) WHERE id = $3', [status, error || null, m.id]);
  return { ...m, status, error: error || m.error };
}

export async function listConversations() {
  const dayAgo = Date.now() - 24 * 3600e3;
  const rows = await q(`SELECT c.*,
      (SELECT COUNT(*) FROM messages WHERE account = c.account AND wa_id = c.wa_id AND direction = 'in' AND seen = 0) AS unread,
      m.body AS last_body, m.type AS last_type, m.direction AS last_direction, m.status AS last_status
    FROM contacts c
    LEFT JOIN messages m ON m.id = (SELECT id FROM messages WHERE account = c.account AND wa_id = c.wa_id ORDER BY timestamp DESC, id DESC LIMIT 1)
    WHERE c.account = $1
    ORDER BY c.last_message_at DESC NULLS LAST`, [A()]);
  return rows.map(c => ({ ...c, window_open: (c.last_inbound_at || 0) > dayAgo }));
}

export const getMessages = waId => q(`SELECT id, wamid, wa_id, direction, type, body, media_id, media_mime, filename, status, error, timestamp
    FROM messages WHERE account = $1 AND wa_id = $2 ORDER BY timestamp, id`, [A(), waId]);

/** Marks inbound messages as seen; returns the wamid of the latest inbound message if any were unseen. */
export async function markSeen(waId) {
  const r = await q("UPDATE messages SET seen = 1 WHERE account = $1 AND wa_id = $2 AND direction = 'in' AND seen = 0 RETURNING id", [A(), waId]);
  if (!r.length) return null;
  return (await one("SELECT wamid FROM messages WHERE account = $1 AND wa_id = $2 AND direction = 'in' ORDER BY timestamp DESC, id DESC LIMIT 1", [A(), waId]))?.wamid;
}

export const unreadTotal = async () => (await one("SELECT COUNT(*) AS n FROM messages WHERE account = $1 AND direction = 'in' AND seen = 0", [A()])).n;

// ---- Settings: read once per request, so getSetting can stay synchronous ----
// Branding names the whole site (icon, home-screen name, login page), so it is shared; everything else belongs to one account.
const SHARED = new Set(['branding']);
export async function loadSettings() {
  const rows = await q("SELECT account, key, value FROM settings WHERE account = $1 OR account = ''", [acct()]);
  tenant.getStore().settings = new Map(rows.filter(r => (r.account === '') === SHARED.has(r.key)).map(r => [r.key, r.value]));
}
export function getSetting(key, fallback = null) {
  const v = tenant.getStore()?.settings?.get(key);
  return v == null ? fallback : JSON.parse(v);
}
export async function setSetting(key, value) {
  const v = JSON.stringify(value);
  await q('INSERT INTO settings (account, key, value) VALUES ($1, $2, $3) ON CONFLICT (account, key) DO UPDATE SET value = excluded.value',
    [SHARED.has(key) ? '' : A(), key, v]);
  tenant.getStore()?.settings?.set(key, v);
}
