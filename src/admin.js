import crypto from 'node:crypto';
import express from 'express';
import { DEFAULT_GRAPH_VERSION, originOf } from './config.js';
import { q, getSetting, setSetting, acct } from './db.js';
import {
  getCredentials, saveCredentials, isConfigured, mask, getProfile, getPreferences, getAutoReplies, getBranding,
} from './settings.js';
import { guardPassword, setPassword, validPassword, endOtherSessions, setUnlocked, UNLOCK_MS, cleanUsername, listUsers, deleteUser } from './auth.js';
import * as wa from './whatsapp.js';
import { wrap, bad, AppError } from './whatsapp.js';
import * as push from './push.js';
import { liveTopic } from './events.js';

export const adminRouter = express.Router();
const r = adminRouter;

// ---- Webhook: Meta sends this account's new messages to <this app's address>/webhook/<account> ----
const hookUrl = origin => `${origin}/webhook/${acct()}`;
const syncState = () => getSetting('webhook_sync', { state: 'idle', message: '', callbackUrl: '' });

/** Points Meta's webhook at this app. Saves and returns the result. */
export async function syncWebhook(origin) {
  if (!isConfigured()) return syncState();
  const callbackUrl = hookUrl(origin);
  let sync;
  if (!origin.startsWith('https://')) {
    sync = { state: 'error', message: 'Meta only sends messages to an https address. This works once the app is online (for example on Netlify).', callbackUrl };
  } else {
    try {
      await wa.connectWebhook(callbackUrl);
      sync = { state: 'ok', message: 'Connected. Meta sends new messages to this app.', callbackUrl };
    } catch (e) {
      sync = { state: 'error', message: `${e.message}${e.hint ? ' ' + e.hint : ''}`, callbackUrl };
    }
  }
  await setSetting('webhook_sync', sync);
  return sync;
}

const isUnlocked = req => req.session.unlocked_until > Date.now();

function settingsPayload(req) {
  const c = getCredentials();
  const origin = originOf(req);
  const sync = syncState();
  return {
    configured: !!c,
    locked: !!c && !isUnlocked(req),
    unlockedUntil: c && isUnlocked(req) ? req.session.unlocked_until : 0,
    connection: c && {
      phoneNumberId: c.phoneNumberId, wabaId: c.wabaId, appId: c.appId, verifyToken: c.verifyToken,
      graphVersion: c.graphVersion, token: mask(c.token), appSecret: mask(c.appSecret),
    },
    info: getProfile(),
    origin,
    // a connection made for an older address doesn't count
    webhookSync: sync.callbackUrl && sync.callbackUrl !== hookUrl(origin) ? { state: 'idle', message: '', callbackUrl: '' } : sync,
    callbackUrl: hookUrl(origin),
    preferences: getPreferences(),
  };
}

r.get('/settings', (req, res) => res.json(settingsPayload(req)));

// ---- Credentials ----
r.post('/settings/unlock', wrap(async (req, res) => {
  if (!(await guardPassword(req, res, req.body?.password))) return;
  const until = Date.now() + UNLOCK_MS;
  await setUnlocked(req.session.token_hash, until);
  req.session.unlocked_until = until;
  res.json(settingsPayload(req));
}));
r.post('/settings/lock', wrap(async (req, res) => {
  await setUnlocked(req.session.token_hash, 0);
  req.session.unlocked_until = 0;
  res.json(settingsPayload(req));
}));

r.put('/settings/credentials', wrap(async (req, res) => {
  const saved = getCredentials();
  if (saved && !isUnlocked(req)) throw new AppError(403, 'Connection details are locked. Click Edit and enter your password first.');
  const b = req.body || {};
  const str = k => (typeof b[k] === 'string' ? b[k].trim() : '');
  const creds = {
    token: str('token') || saved?.token || '',
    appSecret: str('appSecret') || saved?.appSecret || '',
    phoneNumberId: str('phoneNumberId'),
    wabaId: str('wabaId'),
    appId: str('appId') || saved?.appId || '',
    verifyToken: str('verifyToken') || saved?.verifyToken || crypto.randomBytes(16).toString('hex'),
    graphVersion: str('graphVersion') || saved?.graphVersion || DEFAULT_GRAPH_VERSION,
  };
  for (const [k, label] of [['token', 'Access token'], ['phoneNumberId', 'Phone number ID'], ['wabaId', 'WhatsApp Business Account ID'], ['appSecret', 'App secret']]) {
    if (!creds[k]) throw bad(`${label} is required.`);
  }
  if (!/^\d+$/.test(creds.phoneNumberId) || !/^\d+$/.test(creds.wabaId) || (creds.appId && !/^\d+$/.test(creds.appId))) {
    throw bad('The IDs are numbers only. Check you did not paste the phone number itself.');
  }
  if (!/^v\d+\.\d+$/.test(creds.graphVersion)) throw bad('Graph API version looks like v21.0');
  if (!/^[\w.~-]{1,100}$/.test(creds.verifyToken)) throw bad('The verify token may only use letters, numbers, - _ . ~');
  let info;
  try {
    info = await wa.verifyCredentials(creds);
  } catch (e) {
    throw new AppError(400, `Meta rejected these details: ${e.message}`, { code: e.code, hint: e.hint });
  }
  creds.appId = info.appId;
  await saveCredentials(creds);
  await setSetting('profile', info);
  await setUnlocked(req.session.token_hash, 0);
  req.session.unlocked_until = 0;
  await syncWebhook(originOf(req)); // connected straight away, nothing to do on Meta's site
  res.json(settingsPayload(req));
}));

r.post('/settings/webhook/connect', wrap(async (req, res) => {
  if (!isConfigured()) throw wa.notConfigured();
  await syncWebhook(originOf(req));
  res.json(settingsPayload(req));
}));
r.get('/settings/webhook/status', wrap(async (req, res) => res.json(await wa.webhookStatus())));

// ---- Phone registration & business profile ----
r.post('/settings/register', wrap(async (req, res) => {
  const pin = String(req.body?.pin ?? '');
  if (!/^\d{6}$/.test(pin)) throw bad('The PIN must be exactly 6 digits.');
  await wa.registerNumber(pin);
  res.json({ ok: true });
}));

const VERTICALS = [
  ['', 'Not set'], ['AUTO', 'Automotive'], ['BEAUTY', 'Beauty, spa and salon'], ['APPAREL', 'Clothing and apparel'],
  ['EDU', 'Education'], ['ENTERTAIN', 'Entertainment'], ['EVENT_PLAN', 'Event planning and service'], ['FINANCE', 'Finance and banking'],
  ['GROCERY', 'Food and grocery'], ['GOVT', 'Public service'], ['HOTEL', 'Hotel and lodging'], ['HEALTH', 'Medical and health'],
  ['NONPROFIT', 'Non-profit'], ['PROF_SERVICES', 'Professional services'], ['RETAIL', 'Shopping and retail'],
  ['TRAVEL', 'Travel and transportation'], ['RESTAURANT', 'Restaurant'], ['OTHER', 'Other'],
];
r.get('/settings/business-profile', wrap(async (req, res) => {
  res.json({ profile: await wa.getBusinessProfile(), verticals: VERTICALS });
}));
r.put('/settings/business-profile', wrap(async (req, res) => {
  const b = req.body || {};
  const s = k => String(b[k] ?? '').trim();
  const p = { about: s('about'), description: s('description'), address: s('address'), email: s('email'), vertical: s('vertical') };
  if (!p.about) throw bad('"About" is required.');
  if (p.about.length > 139) throw bad('"About" can be at most 139 characters.');
  if (p.description.length > 512) throw bad('The description can be at most 512 characters.');
  if (p.address.length > 256) throw bad('The address can be at most 256 characters.');
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw bad('That email address does not look right.');
  if (!VERTICALS.some(([k]) => k === p.vertical)) throw bad('Choose a category from the list.');
  const websites = (Array.isArray(b.websites) ? b.websites : []).map(w => String(w).trim()).filter(Boolean);
  if (websites.length > 2) throw bad('You can add at most 2 websites.');
  for (const w of websites) if (!/^https?:\/\/\S+\.\S+/.test(w)) throw bad(`"${w}" must start with http:// or https://`);
  p.websites = websites;
  if (!p.vertical) delete p.vertical;
  await wa.updateBusinessProfile(p);
  res.json({ profile: await wa.getBusinessProfile(), verticals: VERTICALS });
}));

// ---- Templates ----
export function buildTemplate(b = {}) {
  const name = String(b.name || '').trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw bad('The name may only use lowercase letters, numbers and _ (for example order_update).');
  if (!['UTILITY', 'MARKETING'].includes(b.category)) throw bad('Choose a category.');
  const language = String(b.language || '');
  if (!/^[a-z]{2,3}(_[A-Za-z]{2,4})?$/.test(language)) throw bad('Choose a language.');
  const header = String(b.header || '').trim(), body = String(b.body || '').trim(), footer = String(b.footer || '').trim();
  if (!body) throw bad('The message body is required.');
  if (body.length > 1024) throw bad('The body can be at most 1024 characters.');
  if (header.length > 60 || footer.length > 60) throw bad('Header and footer can be at most 60 characters each.');
  if (/\{\{/.test(header + footer)) throw bad('Variables like {{1}} are only allowed in the body.');
  if (/\{\{(?!\d+\}\})/.test(body)) throw bad('Variables must look like {{1}}, {{2}}, {{3}}…');
  const order = [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))];
  if (order.some((v, i) => v !== i + 1)) throw bad('Number the variables in order: {{1}}, then {{2}}, then {{3}}…');
  const examples = (Array.isArray(b.examples) ? b.examples : []).slice(0, order.length).map(e => String(e).trim());
  if (examples.length < order.length || examples.some(e => !e)) throw bad('Meta needs an example for every variable.');
  const components = [];
  if (header) components.push({ type: 'HEADER', format: 'TEXT', text: header });
  components.push({ type: 'BODY', text: body, ...(order.length ? { example: { body_text: [examples] } } : {}) });
  if (footer) components.push({ type: 'FOOTER', text: footer });
  return { name, category: b.category, language, components };
}
r.get('/settings/templates', wrap(async (req, res) => res.json({ templates: await wa.listTemplates() })));
r.post('/settings/templates', wrap(async (req, res) => res.json(await wa.createTemplate(buildTemplate(req.body)))));
r.delete('/settings/templates/:name', wrap(async (req, res) => {
  if (!/^[a-z0-9_]+$/.test(req.params.name)) throw bad('Invalid template name.');
  res.json(await wa.deleteTemplate(req.params.name));
}));

// ---- Quick replies ----
function quickReply(b = {}) {
  const title = String(b.title || '').trim(), body = String(b.body || '').trim();
  if (!title || !body) throw bad('A quick reply needs a shortcut and a message.');
  if (title.length > 60 || body.length > 4096) throw bad('The shortcut can be 60 characters and the message 4096.');
  return [title, body];
}
const qrId = req => (/^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : 0);
r.get('/quick-replies', wrap(async (req, res) => res.json(await q('SELECT * FROM quick_replies WHERE account = $1 ORDER BY lower(title), id', [acct()]))));
r.post('/quick-replies', wrap(async (req, res) => {
  res.json((await q('INSERT INTO quick_replies (title, body, account) VALUES ($1, $2, $3) RETURNING *', [...quickReply(req.body), acct()]))[0]);
}));
r.put('/quick-replies/:id', wrap(async (req, res) => {
  const row = (await q('UPDATE quick_replies SET title = $1, body = $2 WHERE id = $3 AND account = $4 RETURNING *', [...quickReply(req.body), qrId(req), acct()]))[0];
  if (!row) return res.status(404).json({ error: 'Quick reply not found.' });
  res.json(row);
}));
r.delete('/quick-replies/:id', wrap(async (req, res) => {
  await q('DELETE FROM quick_replies WHERE id = $1 AND account = $2', [qrId(req), acct()]);
  res.json({ ok: true });
}));

// ---- Auto-replies ----
r.get('/settings/auto-replies', (req, res) => res.json(getAutoReplies()));
r.put('/settings/auto-replies', wrap(async (req, res) => {
  const b = req.body || {}, cur = getAutoReplies();
  const welcome = { enabled: !!b.welcome?.enabled, text: String(b.welcome?.text ?? cur.welcome.text).trim() };
  const a = b.away || {};
  const away = {
    enabled: !!a.enabled, text: String(a.text ?? cur.away.text).trim(), timezone: String(a.timezone || cur.away.timezone),
    days: [...new Set((Array.isArray(a.days) ? a.days : []).map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort(),
    start: String(a.start || ''), end: String(a.end || ''),
  };
  if (welcome.enabled && !welcome.text) throw bad('Write the welcome message.');
  if (away.enabled && !away.text) throw bad('Write the away message.');
  if (welcome.text.length > 4096 || away.text.length > 4096) throw bad('Messages can be at most 4096 characters.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: away.timezone }); } catch { throw bad('Choose a time zone from the list.'); }
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(away.start) || !time.test(away.end)) throw bad('Opening times look like 09:00.');
  await setSetting('auto_replies', { welcome, away });
  res.json(getAutoReplies());
}));

// ---- Chats & security ----
r.put('/settings/preferences', wrap(async (req, res) => {
  const b = req.body || {}, cur = getPreferences();
  await setSetting('preferences', {
    sendReadReceipts: typeof b.sendReadReceipts === 'boolean' ? b.sendReadReceipts : cur.sendReadReceipts,
    pushPreview: typeof b.pushPreview === 'boolean' ? b.pushPreview : cur.pushPreview,
  });
  res.json(getPreferences());
}));
r.post('/settings/password', wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!validPassword(next)) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  if (!(await guardPassword(req, res, current))) return;
  await setPassword(req.session.username, next);
  await endOtherSessions(req.session.token_hash, req.session.username);
  await liveTopic(true); // logged-out devices stop hearing live updates
  res.json({ ok: true });
}));

// ---- Accounts: the owner (first account) sees all accounts and can remove one, e.g. a spam sign-up ----
const ownerOnly = req => { if (!req.session.owner) throw new AppError(403, 'Only the owner of this site can do that.'); };
r.get('/users', wrap(async (req, res) => res.json({
  me: req.session.username, owner: !!req.session.owner, list: req.session.owner ? await listUsers() : [],
})));
r.delete('/users/:username', wrap(async (req, res) => {
  ownerOnly(req);
  if (!(await deleteUser(cleanUsername(req.params.username)))) throw new AppError(404, "Account not found (the owner can't be removed).");
  res.json({ ok: true });
}));

// ---- Branding ----
r.put('/branding', wrap(async (req, res) => {
  ownerOnly(req); // the name and colour are shared by every account on this site
  const appName = String(req.body?.appName ?? '').trim();
  const accent = String(req.body?.accent ?? '').trim().toLowerCase();
  if (!appName || appName.length > 30) throw bad('The app name must be 1 to 30 characters.');
  if (!/^#[0-9a-f]{6}$/.test(accent)) throw bad('Choose a colour like #2563eb.');
  await setSetting('branding', { appName, accent });
  res.json(getBranding());
}));

// ---- Push notifications ----
r.get('/push', wrap(async (req, res) => {
  const { publicKey } = await push.vapidKeys();
  const list = await push.listDevices();
  res.json({ publicKey, devices: list.length, list });
}));
r.post('/push/subscribe', wrap(async (req, res) => { await push.subscribe(req.body?.subscription, req.body?.device); res.json({ ok: true }); }));
r.post('/push/unsubscribe', wrap(async (req, res) => { await push.unsubscribe(req.body?.endpoint); res.json({ ok: true }); }));
r.post('/push/remove', wrap(async (req, res) => {
  if (!(await push.removeById(String(req.body?.id || '')))) return res.status(404).json({ error: 'Device not found.' });
  res.json({ ok: true });
}));
r.post('/push/test', wrap(async (req, res) => res.json({ sent: await push.sendTest(originOf(req)) })));
