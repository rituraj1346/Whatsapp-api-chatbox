import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { ROOT, SERVERLESS, SETUP_MISSING } from './config.js';
import * as store from './db.js';
import { isConfigured, getProfile, getPreferences, getBranding } from './settings.js';
import { iconPng, iconSvg } from './icons.js';
import { hasUsers, ownerName, validPassword, cleanUsername, validUsername, USERNAME_RULE, createUser, guardPassword, createSession, getSession, destroySession, requireAuth } from './auth.js';
import * as wa from './whatsapp.js';
import { wrap, bad, AppError } from './whatsapp.js';
import { webhookRouter } from './webhook.js';
import { sseHandler, recordOutgoing, broadcast, liveConfig } from './events.js';
import { adminRouter } from './admin.js';

/** Netlify Functions take about 6 MB per request, and binary files arrive base64-encoded. */
const MAX_UPLOAD = SERVERLESS ? 4 * 1024 * 1024 : 100 * 1024 * 1024;

export const app = express();
app.set('trust proxy', SERVERLESS ? true : 'loopback');
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  });
  next();
});

// Hosting not finished (Netlify environment variables missing): say exactly what to add
app.use((req, res, next) => {
  if (!SETUP_MISSING.length) return next();
  res.status(503).json({
    code: 'server_setup',
    error: `Almost there: add ${SETUP_MISSING.join(' and ')} in Netlify → Site configuration → Environment variables, then deploy again. The README explains each value.`,
  });
});
// Which account this request is for: the logged-in user, or for Meta's webhook the name in /webhook/<account>
// (plain /webhook = the owner, as set up by the single-business version). Then that account's settings are read once.
async function startRequest(req) {
  const ctx = store.tenant.getStore();
  const hook = req.path.match(/^\/webhook(?:\/([a-z0-9._-]+))?\/?$/);
  if (hook) ctx.account = hook[1] || (await ownerName()) || '';
  else { req.session = await getSession(req); ctx.account = req.session?.username || ''; }
  await store.loadSettings();
}
app.use((req, res, next) => store.tenant.run({}, () => startRequest(req).then(() => next(), e => {
  console.error('Database error:', e);
  res.status(503).json({
    code: 'database',
    error: 'Cannot reach the database. If you use Supabase\'s free plan, open supabase.com and check the project is not paused. Also check DATABASE_URL in Netlify.',
  });
})));

app.use(webhookRouter); // public, verified by signature

// ---- Home-screen app: manifest and icons (public, generated from branding) ----
/** ?v=rrggbb picks the colour (used for live previews); otherwise the saved brand colour. */
const iconColor = req => (/^[0-9a-f]{6}$/i.test(req.query.v || '') ? `#${req.query.v.toLowerCase()}` : getBranding().accent);
app.get('/manifest.webmanifest', (req, res) => {
  const { appName, accent } = getBranding();
  const v = accent.slice(1);
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
    name: appName, short_name: appName.length <= 12 ? appName : appName.slice(0, 12).trim(),
    start_url: '/', scope: '/', display: 'standalone', theme_color: accent, background_color: accent,
    icons: [
      { src: `/icons/192.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/icons/512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/icons/512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});
const sendIcon = (res, size, color) => res.type('image/png').set('Cache-Control', 'no-cache').send(iconPng(size, color));
app.get(['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'], (req, res) => sendIcon(res, 180, iconColor(req)));
app.get('/icons/:size.png', (req, res) => {
  const size = Number(req.params.size);
  if (![180, 192, 512].includes(size)) return res.sendStatus(404);
  sendIcon(res, size, iconColor(req));
});
app.get('/favicon.svg', (req, res) => res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(iconSvg(iconColor(req))));

const json = store.keep(express.json({ limit: '1mb' }));
const api = express.Router();
app.use('/api', api);

// ---- Public endpoints ----
api.get('/branding', (req, res) => res.json(getBranding()));
api.get('/session', wrap(async (req, res) => {
  const s = req.session, loggedIn = !!s;
  res.json({
    hasPassword: await hasUsers(), loggedIn, configured: loggedIn && isConfigured(), info: loggedIn ? getProfile() : null,
    ...(loggedIn ? { user: { username: s.username, owner: s.owner }, live: await liveConfig(), maxUpload: MAX_UPLOAD } : {}),
  });
}));
// Anyone can create an account. Each account is its own business with its own WhatsApp number and chats.
api.post('/signup', json, wrap(async (req, res) => {
  await hasUsers(); // moves an older single-business install into the "admin" account first
  const username = cleanUsername(req.body?.username);
  if (!validUsername(username)) throw bad(USERNAME_RULE);
  if (!validPassword(req.body?.password)) throw bad('The password must be at least 8 characters.');
  if (!(await createUser(username, req.body.password))) throw new AppError(409, `The username "${username}" is taken. Choose another one.`);
  await createSession(req, res, username);
  res.json({ ok: true });
}));
api.post('/login', json, wrap(async (req, res) => {
  await hasUsers();
  const username = cleanUsername(req.body?.username);
  if (!(await guardPassword(req, res, req.body?.password, username))) return;
  await createSession(req, res, username);
  res.json({ ok: true });
}));
api.post('/logout', wrap(async (req, res) => { await destroySession(req, res); res.json({ ok: true }); }));

// ---- Everything below needs a login ----
api.use(requireAuth);
api.get('/events', sseHandler);

// raw body for media uploads, before the JSON parser
api.post('/send-media', store.keep(express.raw({ type: () => true, limit: MAX_UPLOAD })), wrap(async (req, res) => {
  if (!isConfigured()) throw wa.notConfigured();
  const to = phone(req.query.to);
  const mime = String(req.get('content-type') || '').split(';')[0].trim();
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('The file is empty.');
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw bad('Unknown file type.');
  const filename = String(req.query.filename || 'file').slice(0, 200);
  const caption = String(req.query.caption || '').slice(0, 1024);
  const r = await wa.sendMedia(to, req.body, mime, filename, caption);
  res.json(await recordOutgoing(to, r, { type: r.kind, body: caption, media_id: r.mediaId, media_mime: mime, filename }));
}));

api.use(json);
api.use(adminRouter);

function phone(v) {
  const p = String(v ?? '').replace(/\D/g, '');
  if (p.length < 6 || p.length > 15) throw bad('Enter the full phone number with country code, for example 919876543210.');
  return p;
}
const needConfig = (req, res, next) => next(isConfigured() ? undefined : wa.notConfigured());

api.get('/conversations', wrap(async (req, res) => res.json(await store.listConversations())));
api.get('/conversations/:waId', wrap(async (req, res) => {
  const contact = (await store.listConversations()).find(c => c.wa_id === req.params.waId) || { wa_id: req.params.waId, window_open: false, unread: 0 };
  res.json({ contact, messages: await store.getMessages(req.params.waId) });
}));
api.post('/conversations/:waId/seen', wrap(async (req, res) => {
  const wamid = await store.markSeen(req.params.waId);
  if (wamid) await broadcast('seen', { waId: req.params.waId });
  let receipt = false;
  if (wamid && isConfigured() && getPreferences().sendReadReceipts) {
    try { await wa.markRead(wamid); receipt = true; } catch (e) { console.error('Read receipt failed:', e.message); }
  }
  res.json({ ok: true, receipt });
}));
api.put('/contacts/:waId', wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (name.length > 100) throw bad('The name can be at most 100 characters.');
  if (!(await store.renameContact(req.params.waId, name))) return res.status(404).json({ error: 'Contact not found.' });
  const contact = await store.getContact(req.params.waId);
  await broadcast('contact', { contact });
  res.json(contact);
}));

api.post('/send', needConfig, wrap(async (req, res) => {
  const to = phone(req.body?.to);
  const text = String(req.body?.text ?? '').trim();
  if (!text) throw bad('Type a message first.');
  if (text.length > 4096) throw bad('A message can be at most 4096 characters.');
  res.json(await recordOutgoing(to, await wa.sendText(to, text), { type: 'text', body: text }));
}));

api.get('/templates', needConfig, wrap(async (req, res) => {
  res.json({ templates: (await wa.listTemplates()).filter(t => t.status === 'APPROVED') });
}));
api.post('/send-template', needConfig, wrap(async (req, res) => {
  const b = req.body || {};
  const to = phone(b.to);
  if (!/^[a-z0-9_]+$/.test(b.name || '') || !/^[\w-]+$/.test(b.language || '')) throw bad('Choose a template.');
  const p = b.params;
  const parameters = Array.isArray(p)
    ? p.map(text => ({ type: 'text', text: String(text) }))
    : p && typeof p === 'object' ? Object.entries(p).map(([parameter_name, text]) => ({ type: 'text', parameter_name, text: String(text) })) : [];
  if (parameters.some(x => !x.text.trim())) throw bad('Fill in every variable.');
  const r = await wa.sendTemplate(to, b.name, b.language, parameters.length ? [{ type: 'body', parameters }] : []);
  const body = typeof b.preview === 'string' && b.preview.trim() ? b.preview.slice(0, 4096) : `[Template: ${b.name}]`;
  res.json(await recordOutgoing(to, r, { type: 'template', body }));
}));

// shortcut: on Netlify a received file over about 4 MB can't be passed through a Function; host on Render/a VPS if large videos matter.
api.get('/media/:id', needConfig, wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw bad('Invalid media id.');
  const r = await wa.downloadMedia(req.params.id);
  res.set({ 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
  if (r.headers.get('content-length')) res.set('Content-Length', r.headers.get('content-length'));
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
}));

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
// On your own computer the app serves its own pages (Netlify serves them from public/ itself).
// no-cache: installed apps check for a new version every time
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: res => res.set('Cache-Control', 'no-cache') }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message, code: err.code, hint: err.hint });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too big to send.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong in the app. See the server log for details.' });
});
