import crypto from 'node:crypto';
import { q, ACCOUNT_TABLES } from './db.js';

const SESSION_MS = 30 * 24 * 3600e3;
export const UNLOCK_MS = 10 * 60e3;
const COOKIE = 'wa_session';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export const validPassword = pw => typeof pw === 'string' && pw.length >= 8;
export const cleanUsername = u => String(u ?? '').trim().toLowerCase();
export const validUsername = u => /^[a-z0-9._-]{3,30}$/.test(u);
export const USERNAME_RULE = 'The username must be 3 to 30 characters: letters, numbers, dot, dash or underscore.';
const hashPw = pw => {
  const salt = crypto.randomBytes(16);
  return [salt.toString('base64'), crypto.scryptSync(pw, salt, 64).toString('base64')];
};

/** True once any account exists. The older single-password version becomes the owner account "admin", with all its data. */
export async function hasUsers() {
  if ((await q('SELECT 1 FROM users LIMIT 1')).length) return true;
  const row = (await q("SELECT value FROM settings WHERE account = '' AND key = 'admin_password'"))[0];
  if (!row) return false;
  const old = JSON.parse(row.value);
  await q('INSERT INTO users (username, salt, hash, owner, created_at) VALUES ($1, $2, $3, TRUE, $4) ON CONFLICT DO NOTHING',
    ['admin', old.salt, old.hash, Date.now()]);
  await q("DELETE FROM settings WHERE account = '' AND key = 'admin_password'");
  for (const t of ACCOUNT_TABLES) {
    await q(`UPDATE ${t} SET account = 'admin' WHERE account = ''${t === 'settings' ? " AND key <> 'branding'" : ''}`);
  }
  return true;
}
/** Returns false if the username is taken. The very first account owns the site. */
export async function createUser(username, pw) {
  return (await q(`INSERT INTO users (username, salt, hash, owner, created_at)
    VALUES ($1, $2, $3, NOT EXISTS (SELECT 1 FROM users), $4)
    ON CONFLICT (username) DO NOTHING RETURNING username`, [username, ...hashPw(pw), Date.now()])).length > 0;
}
export const ownerName = async () => (await q('SELECT username FROM users WHERE owner ORDER BY created_at LIMIT 1'))[0]?.username;
export const setPassword = (username, pw) => q('UPDATE users SET salt = $1, hash = $2 WHERE username = $3', [...hashPw(pw), username]);
export const listUsers = () => q('SELECT username, owner, created_at FROM users ORDER BY created_at, username');
/** Deletes an account with all its chats and settings. The owner can't be deleted. */
export async function deleteUser(username) {
  const gone = (await q('DELETE FROM users WHERE username = $1 AND NOT owner RETURNING username', [username])).length > 0;
  if (!gone) return false;
  await q('DELETE FROM sessions WHERE username = $1', [username]);
  for (const t of ACCOUNT_TABLES) await q(`DELETE FROM ${t} WHERE account = $1`, [username]);
  return true;
}
async function checkPassword(username, pw) {
  const u = (await q('SELECT salt, hash FROM users WHERE username = $1', [username]))[0];
  if (!u || typeof pw !== 'string') return false;
  const want = Buffer.from(u.hash, 'base64');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(u.salt, 'base64'), want.length), want);
}

/** The visitor's IP. Netlify passes it in its own header. */
const clientIp = req => req.get('x-nf-client-connection-ip') || req.ip;

// 10 wrong passwords per IP per 15 minutes (shared by login, unlock and change password).
// Stored in the database because each Netlify Function instance has its own memory.
/** Checks a password with rate limiting. Sends the error response and resolves false on failure. */
export async function guardPassword(req, res, pw, username = req.session?.username) {
  const ip = clientIp(req), now = Date.now();
  const f = (await q('SELECT count FROM login_fails WHERE ip = $1 AND reset_at > $2', [ip, now]))[0];
  if (f && f.count >= 10) { res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' }); return false; }
  if (await checkPassword(username, pw)) return true;
  await q(`INSERT INTO login_fails (ip, count, reset_at) VALUES ($1, 1, $2)
    ON CONFLICT (ip) DO UPDATE SET count = CASE WHEN login_fails.reset_at > $3 THEN login_fails.count + 1 ELSE 1 END,
      reset_at = CASE WHEN login_fails.reset_at > $3 THEN login_fails.reset_at ELSE $2 END`, [ip, now + 15 * 60e3, now]);
  res.status(401).json({ error: req.session ? 'Wrong password.' : 'Wrong username or password.' });
  return false;
}

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE) return v;
  }
}
export async function createSession(req, res, username) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
  await q('INSERT INTO sessions (token_hash, expires_at, username) VALUES ($1, $2, $3)', [sha(token), Date.now() + SESSION_MS, username]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${req.secure ? '; Secure' : ''}`);
  return sha(token);
}
export async function getSession(req) {
  const t = readCookie(req);
  // the join also ends sessions of deleted users and of the old single-password login
  const s = t && (await q('SELECT s.*, u.owner FROM sessions s JOIN users u ON u.username = s.username WHERE s.token_hash = $1', [sha(t)]))[0];
  return s && s.expires_at > Date.now() ? s : null;
}
export async function destroySession(req, res) {
  const s = await getSession(req);
  if (s) await q('DELETE FROM sessions WHERE token_hash = $1', [s.token_hash]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`);
}
export const endOtherSessions = (keep, username) => q('DELETE FROM sessions WHERE username = $1 AND token_hash != $2', [username, keep]);
export const setUnlocked = (hash, until) => q('UPDATE sessions SET unlocked_until = $1 WHERE token_hash = $2', [until, hash]);

export async function requireAuth(req, res, next) {
  try {
    const s = req.session !== undefined ? req.session : await getSession(req); // usually found already by the account middleware
    if (!s) return res.status(401).json({ code: 'login_required', error: 'Please log in.' });
    req.session = s;
    next();
  } catch (e) { next(e); }
}
