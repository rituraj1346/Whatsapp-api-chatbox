// End-to-end smoke test: runs the real server against a fake Graph API, with Postgres served by PGlite
// over the network protocol (the same driver path as Supabase).
import { startFakeGraph, TOKEN, SECRET, PHONE, WABA, APP } from './fake-graph.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
async function step(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

const { graph, g } = await startFakeGraph();
const GRAPH = `http://127.0.0.1:${graph.address().port}`;
const pg = await PGlite.create();
const pgServer = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1' });
await pgServer.start();
const DATABASE_URL = `postgres://postgres@${pgServer.getServerConn()}/postgres`;
/** Every stored setting value, to prove secrets are not readable in the database. */
const settingsDump = async () => (await pg.query('SELECT key, value FROM settings')).rows.map(r => r.value).join('\n');

// ---------- App server ----------
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bizinbox-'));
const PUSH_LOG = path.join(DATA, 'push-log.jsonl');
const pushLog = {
  read: () => (fs.existsSync(PUSH_LOG) ? fs.readFileSync(PUSH_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []),
  reset: () => fs.rmSync(PUSH_LOG, { force: true }),
};
let vapidPublic;
/** A browser-like push subscription with real P-256 keys. */
function clientSub(endpoint) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}
/** Fetches a PNG and returns its size and first pixel colour. */
async function png(url) {
  const res = await fetch(BASE + url);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `bad CRC in ${type}`);
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), first: '#' + raw.subarray(1, 4).toString('hex') };
}
/** Listens to /api/events with the current cookie, like another open device. */
async function sseClient() {
  const ctl = new AbortController();
  const res = await fetch(BASE + '/api/events', { headers: { Cookie: cookie }, signal: ctl.signal });
  const events = [];
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* closed */ }
  })();
  return { events, close: () => ctl.abort() };
}
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
async function startServer(extraEnv = {}) {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(path.join(ROOT, 'test/fake-push.js')).href, 'src/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DATA, GRAPH_BASE_URL: GRAPH, SECRET_KEY: '', PUSH_LOG,
      DATABASE_URL, PUBLIC_URL: 'https://chat.example.com', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ...extraEnv,
    },
  });
  server.stdout.resume();
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/api/session'); return; } catch { await sleep(50); } }
  throw new Error('server did not start');
}
async function stopServer() { const done = new Promise(r => server.once('exit', r)); server.kill(); await done; }

let cookie = '';
async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body) || typeof body === 'string') opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(BASE + url, opts);
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error('timed out waiting');
}
function webhook(payload, secret = SECRET, path = '/webhook/owner') {
  const raw = JSON.stringify(payload);
  return call('POST', path, raw, { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + hmac(secret, raw) });
}
const inbound = (from, id, msg, name = 'Asha') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE }, contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }] } }] }],
});
const statusEvt = (id, status, errors) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE }, statuses: [{ id, status, timestamp: '1', recipient_id: '1', ...(errors ? { errors } : {}) }] } }] }] });

console.log('business-inbox smoke test');
await startServer();
try {
  await step('password and login rules', async () => {
    let r = await call('GET', '/api/session');
    assert.deepEqual([r.data.hasPassword, r.data.loggedIn], [false, false]);
    assert.equal((await call('GET', '/api/conversations')).data.code, 'login_required');
    assert.equal((await call('POST', '/api/signup', { username: 'Owner', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/signup', { username: 'x', password: 'correct horse' })).status, 400);
    r = await call('POST', '/api/signup', { username: 'Owner', password: 'correct horse' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await call('POST', '/api/signup', { username: 'OWNER', password: 'another pass' })).status, 409); // taken, any case
    const saved = cookie; cookie = '';
    assert.equal((await call('POST', '/api/login', { username: 'Owner', password: 'wrong password' })).status, 401);
    assert.equal((await call('POST', '/api/login', { username: 'Owner', password: 'correct horse' })).status, 200);
    assert.ok(cookie && cookie !== saved);
    assert.equal((await call('GET', '/api/session')).data.loggedIn, true);
    assert.deepEqual((await call('GET', '/api/session')).data.user, { username: 'owner', owner: true });
  });

  await step('not-configured behaviour', async () => {
    assert.equal((await call('GET', '/api/session')).data.configured, false);
    const r = await call('POST', '/api/send', { to: '919876543210', text: 'hi' });
    assert.deepEqual([r.status, r.data.code], [409, 'not_configured']);
    assert.equal((await call('GET', '/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status, 403);
    assert.equal((await webhook({})).status, 503);
  });

  await step('bad credentials are rejected', async () => {
    let r = await call('PUT', '/api/settings/credentials', { token: 'EAAGwrong', phoneNumberId: PHONE, wabaId: WABA, appSecret: SECRET });
    assert.equal(r.status, 400); assert.match(r.data.error, /^Meta rejected these details/); assert.match(r.data.hint, /token/);
    r = await call('PUT', '/api/settings/credentials', { token: TOKEN, phoneNumberId: PHONE, wabaId: WABA, appSecret: 'wrongsecret' });
    assert.equal(r.status, 400); assert.match(r.data.hint, /App secret/);
    assert.equal((await call('GET', '/api/settings')).data.configured, false);
  });

  let verifyToken;
  await step('good credentials are encrypted, masked and locked', async () => {
    const r = await call('PUT', '/api/settings/credentials', { token: TOKEN, phoneNumberId: PHONE, wabaId: WABA, appSecret: SECRET });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.connection.token, 'EAAG••••••x9Z1');
    assert.equal(r.data.connection.appId, APP);
    assert.equal(r.data.info.verifiedName, 'Test Shop');
    assert.equal(r.data.locked, true);
    verifyToken = r.data.connection.verifyToken;
    assert.ok(verifyToken.length >= 16);
    const all = JSON.stringify((await call('GET', '/api/settings')).data);
    assert.ok(!all.includes(TOKEN) && !all.includes(SECRET));
    const dump = await settingsDump();
    assert.match(dump, /"v1:/);
    assert.ok(!dump.includes(TOKEN) && !dump.includes(SECRET), 'plaintext secret in the database');
    // the webhook was connected to the public address straight away
    assert.equal(r.data.webhookSync.state, 'ok', JSON.stringify(r.data.webhookSync));
    assert.equal(r.data.callbackUrl, 'https://chat.example.com/webhook/owner');
    assert.equal(g.subscription.callback_url, 'https://chat.example.com/webhook/owner');
  });

  await step('lock / unlock', async () => {
    let r = await call('PUT', '/api/settings/credentials', { phoneNumberId: PHONE, wabaId: WABA });
    assert.equal(r.status, 403);
    assert.equal((await call('POST', '/api/settings/unlock', { password: 'nope nope' })).status, 401);
    r = await call('POST', '/api/settings/unlock', { password: 'correct horse' });
    assert.equal(r.data.locked, false); assert.ok(r.data.unlockedUntil > Date.now() + 9 * 60e3);
    r = await call('PUT', '/api/settings/credentials', { phoneNumberId: PHONE, wabaId: WABA, token: '', appSecret: '' }); // empty = keep
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.locked, true);
    assert.equal(r.data.connection.verifyToken, verifyToken);
    await call('POST', '/api/settings/unlock', { password: 'correct horse' });
    assert.equal((await call('POST', '/api/settings/lock')).data.locked, true);
  });

  await step('webhook verification and signature', async () => {
    let r = await call('GET', `/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345`);
    assert.deepEqual([r.status, r.data], [200, 12345]);
    assert.equal((await call('GET', '/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1')).status, 403);
    assert.equal((await webhook(inbound('919800000001', 'wamid.in1', { type: 'text', text: { body: 'x' } }), 'wrong')).status, 401);
  });

  await step('incoming messages are stored and deduped, media proxy', async () => {
    assert.equal((await webhook(inbound('919800000001', 'wamid.in1', { type: 'text', text: { body: 'Hello <b>there</b>' } }))).status, 200);
    await webhook(inbound('919800000001', 'wamid.in1', { type: 'text', text: { body: 'Hello <b>there</b>' } }));
    await webhook(inbound('919800000001', 'wamid.in2', { type: 'image', image: { id: '5001', mime_type: 'image/jpeg', caption: 'pic' } }));
    await webhook(inbound('919800000001', 'wamid.in3', { type: 'location', location: { latitude: 1.5, longitude: 2.5, name: 'Shop' } }));
    const other = inbound('919800000009', 'wamid.other', { type: 'text', text: { body: 'other phone' } });
    other.entry[0].changes[0].value.metadata.phone_number_id = '9999';
    await webhook(other);
    const convs = (await call('GET', '/api/conversations')).data;
    assert.equal(convs.length, 1);
    assert.deepEqual([convs[0].name, convs[0].unread, convs[0].window_open], ['Asha', 3, true]);
    const msgs = (await call('GET', '/api/conversations/919800000001')).data.messages;
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].body, 'Hello <b>there</b>');
    assert.equal(msgs[1].media_id, '5001');
    assert.match(msgs[2].body, /maps\.google\.com\/\?q=1\.5,2\.5/);
    const m = await call('GET', '/api/media/5001');
    assert.deepEqual([m.status, m.data, m.headers.get('content-type')], [200, 'JPEGDATA', 'image/jpeg']);
  });

  await step('read receipts and the preference', async () => {
    let r = await call('POST', '/api/conversations/919800000001/seen');
    assert.equal(r.data.receipt, true);
    assert.deepEqual(g.sent.at(-1), { messaging_product: 'whatsapp', recipient_type: 'individual', status: 'read', message_id: 'wamid.in3' });
    assert.equal((await call('GET', '/api/conversations')).data[0].unread, 0);
    await call('PUT', '/api/settings/preferences', { sendReadReceipts: false });
    await webhook(inbound('919800000001', 'wamid.in4', { type: 'text', text: { body: 'again' } }));
    const before = g.sent.length;
    r = await call('POST', '/api/conversations/919800000001/seen');
    assert.equal(r.data.receipt, false); assert.equal(g.sent.length, before);
    await call('PUT', '/api/settings/preferences', { sendReadReceipts: true });
  });

  await step('sending text, out-of-order statuses, error hints', async () => {
    const r = await call('POST', '/api/send', { to: '+91 98000 00001', text: 'Hi Asha' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.wa_id, r.data.status, g.sent.at(-1).text.body], ['919800000001', 'sent', 'Hi Asha']);
    const wamid = r.data.wamid;
    await webhook(statusEvt(wamid, 'read'));
    await webhook(statusEvt(wamid, 'delivered')); // late, must not move status back
    let msgs = (await call('GET', '/api/conversations/919800000001')).data.messages;
    assert.equal(msgs.find(m => m.wamid === wamid).status, 'read');
    await webhook(statusEvt(wamid, 'failed', [{ code: 131026, title: 'Message undeliverable' }]));
    msgs = (await call('GET', '/api/conversations/919800000001')).data.messages;
    const failed = msgs.find(m => m.wamid === wamid);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /undeliverable \(131026\) — WhatsApp could not deliver/);
    const e = await call('POST', '/api/send', { to: '15550000047', text: 'late' });
    assert.deepEqual([e.status, e.data.code], [502, 131047]); assert.match(e.data.hint, /24 hours/);
    assert.equal((await call('POST', '/api/send', { to: '12', text: 'x' })).status, 400);
  });

  await step('templates and media', async () => {
    let r = await call('GET', '/api/templates');
    assert.deepEqual(r.data.templates.map(t => t.name), ['hello_world']);
    r = await call('POST', '/api/send-template', { to: '919800000001', name: 'hello_world', language: 'en_US', params: ['Asha'], preview: 'Hi Asha' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(g.sent.at(-1).template, { name: 'hello_world', language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }] });
    await call('POST', '/api/send-template', { to: '919800000001', name: 'hello_world', language: 'en_US', params: { customer: 'Asha' } });
    assert.deepEqual(g.sent.at(-1).template.components[0].parameters, [{ type: 'text', parameter_name: 'customer', text: 'Asha' }]);
    r = await call('POST', '/api/send-media?to=919800000001&filename=photo.jpg&caption=Look', Buffer.from('IMG'), { 'Content-Type': 'image/jpeg' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(g.media.at(-1), /IMG/);
    assert.deepEqual(g.sent.at(-1).image, { id: '9001', caption: 'Look' });
    assert.deepEqual([r.data.type, r.data.media_id], ['image', '9001']);
    await call('POST', '/api/send-media?to=919800000001&filename=a.pdf', Buffer.from('%PDF'), { 'Content-Type': 'application/pdf' });
    assert.deepEqual(g.sent.at(-1).document, { id: '9001', filename: 'a.pdf' });
  });

  await step('webhook: connect again, status with Meta', async () => {
    const r = await call('POST', '/api/settings/webhook/connect');
    assert.deepEqual([r.data.webhookSync.state, r.data.origin], ['ok', 'https://chat.example.com']);
    assert.deepEqual(g.subscription, { object: 'whatsapp_business_account', callback_url: 'https://chat.example.com/webhook/owner', verify_token: verifyToken, fields: 'messages' });
    assert.equal(g.subscribed, true);
    const s = await call('GET', '/api/settings/webhook/status');
    assert.deepEqual(s.data, { callbackUrl: 'https://chat.example.com/webhook/owner', active: true, messagesField: true, wabaSubscribed: true });
  });

  await step('register PIN validation', async () => {
    assert.equal((await call('POST', '/api/settings/register', { pin: '12345' })).status, 400);
    assert.equal((await call('POST', '/api/settings/register', { pin: '123456' })).status, 200);
    assert.deepEqual(g.registered, { messaging_product: 'whatsapp', pin: '123456' });
  });

  await step('business profile get/put', async () => {
    assert.equal((await call('GET', '/api/settings/business-profile')).data.profile.about, 'Hello');
    assert.equal((await call('PUT', '/api/settings/business-profile', { about: '' })).status, 400);
    assert.equal((await call('PUT', '/api/settings/business-profile', { about: 'x'.repeat(140) })).status, 400);
    assert.equal((await call('PUT', '/api/settings/business-profile', { about: 'Hi', websites: ['https://a.com', 'https://b.com', 'https://c.com'] })).status, 400);
    const r = await call('PUT', '/api/settings/business-profile', { about: 'Fresh sweets daily', email: 'shop@example.com', vertical: 'RETAIL', websites: ['https://example.com'] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.profile, { about: 'Fresh sweets daily', description: '', address: '', email: 'shop@example.com', vertical: 'RETAIL', websites: ['https://example.com'], messaging_product: 'whatsapp' });
  });

  await step('template validation, create payload with examples, delete', async () => {
    const all = (await call('GET', '/api/settings/templates')).data.templates;
    assert.deepEqual(all.map(t => t.status), ['APPROVED', 'PENDING', 'REJECTED']);
    const base = { name: 'order_update', category: 'UTILITY', language: 'en', body: 'Hi {{1}}, order {{2}} is ready', examples: ['Asha', '#42'] };
    for (const bad of [{ name: 'Order Update' }, { body: 'Hi {{2}} {{1}}' }, { examples: ['Asha'] }, { body: 'Hi {{name}}' }, { category: 'AUTH' }]) {
      assert.equal((await call('POST', '/api/settings/templates', { ...base, ...bad })).status, 400, JSON.stringify(bad));
    }
    const r = await call('POST', '/api/settings/templates', { ...base, header: 'Order', footer: 'Thanks' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(g.templatesCreated.at(-1), {
      name: 'order_update', category: 'UTILITY', language: 'en', components: [
        { type: 'HEADER', format: 'TEXT', text: 'Order' },
        { type: 'BODY', text: 'Hi {{1}}, order {{2}} is ready', example: { body_text: [['Asha', '#42']] } },
        { type: 'FOOTER', text: 'Thanks' }],
    });
    assert.equal((await call('DELETE', '/api/settings/templates/order_update')).status, 200);
    assert.deepEqual(g.deleted, ['order_update']);
  });

  await step('quick replies CRUD', async () => {
    assert.equal((await call('POST', '/api/quick-replies', { title: '', body: 'x' })).status, 400);
    const a = (await call('POST', '/api/quick-replies', { title: 'thanks', body: 'Thank you!' })).data;
    await call('PUT', `/api/quick-replies/${a.id}`, { title: 'thanks', body: 'Thank you so much!' });
    assert.equal((await call('GET', '/api/quick-replies')).data[0].body, 'Thank you so much!');
    await call('DELETE', `/api/quick-replies/${a.id}`);
    assert.deepEqual((await call('GET', '/api/quick-replies')).data, []);
  });

  await step('contact rename', async () => {
    await call('PUT', '/api/contacts/919800000001', { name: 'Asha (VIP)' });
    assert.equal((await call('GET', '/api/conversations')).data[0].custom_name, 'Asha (VIP)');
    await call('PUT', '/api/contacts/919800000001', { name: '' });
    assert.equal((await call('GET', '/api/conversations')).data[0].custom_name, null);
  });

  await step('home-screen app: manifest, icons, favicon, service worker', async () => {
    const m = await call('GET', '/manifest.webmanifest');
    assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
    assert.deepEqual([m.data.name, m.data.short_name, m.data.start_url, m.data.scope, m.data.display, m.data.theme_color],
      ['Business Inbox', 'Business Inb', '/', '/', 'standalone', '#2563eb']);
    assert.deepEqual(m.data.icons.map(i => [i.src, i.sizes, i.purpose]), [
      ['/icons/192.png?v=2563eb', '192x192', 'any'], ['/icons/512.png?v=2563eb', '512x512', 'any'], ['/icons/512.png?v=2563eb', '512x512', 'maskable']]);
    const icon = await png('/apple-touch-icon.png');
    assert.deepEqual([icon.w, icon.h, icon.first], [180, 180, '#2563eb']);
    assert.deepEqual([(await png('/icons/512.png')).w, (await png('/apple-touch-icon-precomposed.png')).w], [512, 180]);
    assert.equal((await fetch(BASE + '/icons/64.png')).status, 404);
    const fav = await fetch(BASE + '/favicon.svg');
    assert.match(fav.headers.get('content-type'), /svg/); assert.match(await fav.text(), /#2563eb/);
    const sw = await fetch(BASE + '/sw.js');
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    assert.doesNotMatch(await sw.text(), /caches\.open/);
    assert.equal((await fetch(BASE + '/')).headers.get('cache-control'), 'no-cache');
  });

  await step('branding: login required, validation, manifest/theme/icon follow the colour', async () => {
    assert.deepEqual((await call('GET', '/api/branding')).data, { appName: 'Business Inbox', accent: '#2563eb' });
    const mine = cookie; cookie = '';
    assert.equal((await call('PUT', '/api/branding', { appName: 'X', accent: '#123456' })).data.code, 'login_required');
    cookie = mine;
    assert.equal((await call('PUT', '/api/branding', { appName: '', accent: '#123456' })).status, 400);
    assert.equal((await call('PUT', '/api/branding', { appName: 'x'.repeat(31), accent: '#123456' })).status, 400);
    assert.equal((await call('PUT', '/api/branding', { appName: 'Sweet Shop', accent: 'red' })).status, 400);
    const r = await call('PUT', '/api/branding', { appName: 'Sweet Shop Inbox', accent: '#0D9488' });
    assert.deepEqual(r.data, { appName: 'Sweet Shop Inbox', accent: '#0d9488' });
    const m = (await call('GET', '/manifest.webmanifest')).data;
    assert.deepEqual([m.name, m.short_name, m.theme_color, m.icons[0].src], ['Sweet Shop Inbox', 'Sweet Shop I', '#0d9488', '/icons/192.png?v=0d9488']);
    assert.equal((await png('/apple-touch-icon.png')).first, '#0d9488');
    assert.match(await (await fetch(BASE + '/favicon.svg')).text(), /#0d9488/);
    await call('PUT', '/api/branding', { appName: 'Business Inbox', accent: '#2563eb' });
  });

  await step('multi-device: SSE gets seen after reading and contact after a rename', async () => {
    const sse = await sseClient();
    await webhook(inbound('919800000001', 'wamid.md1', { type: 'text', text: { body: 'are you there?' } }));
    await until(() => sse.events.some(e => e.kind === 'message' && e.message.wamid === 'wamid.md1'));
    await call('POST', '/api/conversations/919800000001/seen');
    await until(() => sse.events.some(e => e.kind === 'seen' && e.waId === '919800000001'));
    await call('PUT', '/api/contacts/919800000001', { name: 'Asha V' });
    const ev = await until(() => sse.events.find(e => e.kind === 'contact'));
    assert.deepEqual([ev.contact.wa_id, ev.contact.custom_name], ['919800000001', 'Asha V']);
    await call('PUT', '/api/contacts/919800000001', { name: '' });
    sse.close();
  });

  await step('push: keys, subscribe validation, payload, 410 removal, privacy, test, devices', async () => {
    let r = await call('GET', '/api/push');
    vapidPublic = r.data.publicKey;
    assert.equal(Buffer.from(vapidPublic, 'base64url').length, 65);
    assert.deepEqual([r.data.devices, r.data.list], [0, []]);
    assert.equal((await call('POST', '/api/push/test')).status, 400);
    const a = clientSub('https://push.example.com/a'), bad = { ...a, endpoint: 'http://push.example.com/a' };
    assert.equal((await call('POST', '/api/push/subscribe', { subscription: bad, device: 'X' })).status, 400);
    assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint: a.endpoint, keys: {} }, device: 'X' })).status, 400);
    await call('POST', '/api/push/subscribe', { subscription: a, device: 'iPhone' });
    await call('POST', '/api/push/subscribe', { subscription: clientSub('https://push.example.com/b'), device: 'Android' });
    await call('POST', '/api/push/subscribe', { subscription: clientSub('https://push.example.com/gone'), device: 'Old phone' });
    r = await call('GET', '/api/push');
    assert.deepEqual(r.data.list.map(d => d.device), ['iPhone', 'Android', 'Old phone']);
    assert.ok(r.data.list.every(d => /^[0-9a-f]{16}$/.test(d.id) && d.since > 0));
    assert.doesNotMatch(JSON.stringify(r.data), /push\.example\.com/);

    pushLog.reset();
    await webhook(inbound('919800000001', 'wamid.push1', { type: 'text', text: { body: 'Is the shop open today?' } }));
    const sent = await until(() => pushLog.read().length >= 3 && pushLog.read());
    const toA = sent.find(x => x.endpoint.endsWith('/a'));
    const unread = (await call('GET', '/api/conversations')).data.reduce((n, c) => n + c.unread, 0);
    assert.deepEqual(toA.payload, { title: 'Asha', body: 'Is the shop open today?', waId: '919800000001', tag: '919800000001', unread });
    assert.deepEqual([toA.headers.Urgency, toA.headers.TTL, toA.headers.Topic], ['high', 86400, '919800000001']);
    assert.match(toA.headers.Authorization, /^vapid t=.+, k=/);
    assert.equal(toA.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(toA.options.vapidDetails.publicKey, vapidPublic);
    assert.equal(toA.options.vapidDetails.subject, 'https://chat.example.com');
    await until(async () => (await call('GET', '/api/push')).data.devices === 2); // "gone" removed

    await call('PUT', '/api/settings/preferences', { pushPreview: false });
    pushLog.reset();
    await webhook(inbound('919800000001', 'wamid.push2', { type: 'text', text: { body: 'secret details' } }));
    const priv = await until(() => pushLog.read().length >= 2 && pushLog.read());
    assert.ok(priv.every(x => x.payload.body === 'New message'));
    await call('PUT', '/api/settings/preferences', { pushPreview: true });

    pushLog.reset();
    await webhook(inbound('919800000001', 'wamid.push3', { type: 'unsupported', errors: [{ code: 131051 }] }));
    await sleep(150);
    assert.equal(pushLog.read().length, 0); // unsupported messages don't notify

    r = await call('POST', '/api/push/test');
    assert.equal(r.data.sent, 2);
    assert.deepEqual(pushLog.read().map(x => x.payload.body), ['Business Inbox: Notifications are working 🎉', 'Business Inbox: Notifications are working 🎉']);

    const android = (await call('GET', '/api/push')).data.list.find(d => d.device === 'Android');
    assert.equal((await call('POST', '/api/push/remove', { id: 'nope' })).status, 404);
    await call('POST', '/api/push/remove', { id: android.id });
    assert.deepEqual((await call('GET', '/api/push')).data.list.map(d => d.device), ['iPhone']);
    pushLog.reset();
    assert.equal((await call('POST', '/api/push/test')).data.sent, 1);
    assert.deepEqual(pushLog.read().map(x => x.endpoint), [a.endpoint]);

    assert.ok(!(await settingsDump()).includes(vapidPublic), 'VAPID key in plaintext in the database');
  });

  await step('isOpen: normal, overnight and Sunday', async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wainbox-unit-'));
    const { isOpen } = await import('../src/autoreply.js');
    const at = s => new Date(s + 'Z'); // UTC times
    const wk = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
    assert.equal(isOpen(wk, at('2026-11-04T10:00:00')), true); // Wednesday
    assert.equal(isOpen(wk, at('2026-11-04T18:00:00')), false);
    assert.equal(isOpen(wk, at('2026-11-08T10:00:00')), false); // Sunday
    assert.equal(isOpen({ ...wk, days: [0] }, at('2026-11-08T10:00:00')), true);
    const night = { timezone: 'UTC', days: [5], start: '20:00', end: '02:00' }; // Friday night shift
    assert.equal(isOpen(night, at('2026-11-06T21:00:00')), true); // Fri 21:00
    assert.equal(isOpen(night, at('2026-11-07T01:30:00')), true); // Sat 01:30 = Friday's shift
    assert.equal(isOpen(night, at('2026-11-07T21:00:00')), false); // Sat 21:00
    assert.equal(isOpen({ ...night, days: [6] }, at('2026-11-08T01:00:00')), true); // Sun early = Saturday's shift
    assert.equal(isOpen({ ...wk, timezone: 'Asia/Kolkata' }, at('2026-11-04T04:00:00')), true); // 09:30 IST
  });

  await step('welcome for a new contact, away once per 12h', async () => {
    const r = await call('PUT', '/api/settings/auto-replies', {
      welcome: { enabled: true, text: 'Welcome to Test Shop!' },
      away: { enabled: true, text: 'We are closed.', timezone: 'UTC', days: [], start: '09:00', end: '18:00' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const before = g.sent.length;
    await webhook(inbound('919800000002', 'wamid.new1', { type: 'text', text: { body: 'hi' } }, 'Ravi'));
    await until(() => g.sent.length >= before + 2);
    await webhook(inbound('919800000002', 'wamid.new2', { type: 'text', text: { body: 'hello?' } }, 'Ravi'));
    await webhook(inbound('919800000002', 'wamid.new3', { type: 'reaction', reaction: { emoji: '👍', message_id: 'x' } }, 'Ravi'));
    await sleep(200);
    assert.deepEqual(g.sent.slice(before).map(s => s.text.body), ['Welcome to Test Shop!', 'We are closed.']);
    const msgs = (await call('GET', '/api/conversations/919800000002')).data.messages;
    assert.deepEqual(msgs.filter(m => m.direction === 'out').map(m => m.body), ['Welcome to Test Shop!', 'We are closed.']);
    await call('PUT', '/api/settings/auto-replies', { welcome: { enabled: false }, away: { enabled: false, timezone: 'UTC', days: [], start: '09:00', end: '18:00' } });
  });

  await step('accounts: each sign-up is a separate business, owner can remove accounts', async () => {
    const mine = cookie;
    const before = (await call('GET', '/api/conversations')).data;
    assert.ok(before.length > 0);
    cookie = '';
    assert.equal((await call('POST', '/api/signup', { username: 'ravi', password: 'ravi pass 1' })).status, 200);
    const ravi = cookie;
    let s = (await call('GET', '/api/session')).data;
    assert.deepEqual([s.user, s.configured], [{ username: 'ravi', owner: false }, false]); // own, empty WhatsApp connection
    assert.deepEqual((await call('GET', '/api/conversations')).data, []); // none of the owner's chats
    assert.deepEqual((await call('GET', '/api/quick-replies')).data, []);
    assert.deepEqual((await call('GET', `/api/conversations/${before[0].wa_id}`)).data.messages, []);
    assert.match((await call('GET', '/api/settings')).data.callbackUrl, /\/webhook\/ravi$/);
    assert.deepEqual((await call('GET', '/api/users')).data.list, []); // can't see other accounts
    assert.equal((await call('PUT', '/api/branding', { appName: 'Hacked', accent: '#000000' })).status, 403);
    assert.equal((await call('DELETE', '/api/users/owner')).status, 403);
    assert.equal((await webhook(inbound('919800000009', 'wamid.ravi1', { type: 'text', text: { body: 'x' } }), SECRET, '/webhook/ravi')).status, 503); // ravi has no app secret
    cookie = mine;
    assert.deepEqual((await call('GET', '/api/conversations')).data.map(c => c.wa_id), before.map(c => c.wa_id)); // owner's chats untouched
    assert.deepEqual((await call('GET', '/api/users')).data.list.map(u => [u.username, u.owner]), [['owner', true], ['ravi', false]]);
    assert.equal((await call('DELETE', '/api/users/owner')).status, 404); // owner can't be removed
    assert.equal((await call('DELETE', '/api/users/ravi')).status, 200);
    cookie = ravi; assert.equal((await call('GET', '/api/session')).data.loggedIn, false); // removed account is logged out
    cookie = mine;
  });

  await step('change password and logout', async () => {
    const mine = cookie;
    cookie = ''; await call('POST', '/api/login', { username: 'Owner', password: 'correct horse' }); const other = cookie;
    cookie = mine;
    assert.equal((await call('POST', '/api/settings/password', { current: 'correct horse', next: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/settings/password', { current: 'wrong one!', next: 'new password 1' })).status, 401);
    assert.equal((await call('POST', '/api/settings/password', { current: 'correct horse', next: 'new password 1' })).status, 200);
    assert.equal((await call('GET', '/api/session')).data.loggedIn, true);
    cookie = other; assert.equal((await call('GET', '/api/session')).data.loggedIn, false); // other session ended
    cookie = mine;
    await call('POST', '/api/logout');
    assert.equal(cookie, '');
    cookie = mine; assert.equal((await call('GET', '/api/session')).data.loggedIn, false);
    assert.equal((await call('POST', '/api/login', { username: 'Owner', password: 'new password 1' })).status, 200);
  });

  await step('credentials survive a restart', async () => {
    await stopServer();
    await startServer();
    const s = (await call('GET', '/api/settings')).data;
    assert.deepEqual([s.configured, s.locked, s.connection.token], [true, true, 'EAAG••••••x9Z1']);
    assert.equal((await call('GET', '/api/push')).data.publicKey, vapidPublic); // VAPID keys reused
    await call('POST', '/api/push/unsubscribe', { endpoint: 'https://push.example.com/a' });
    assert.equal((await call('GET', '/api/push')).data.devices, 0);
    assert.equal((await call('POST', '/api/send', { to: '919800000001', text: 'after restart' })).status, 200);
  });

  await step('online mode: Supabase live updates carry no message text, http address refused for the webhook', async () => {
    await stopServer();
    await startServer({ SUPABASE_URL: GRAPH, SUPABASE_ANON_KEY: 'anon-test-key', PUBLIC_URL: '' });
    const live = (await call('GET', '/api/session')).data.live;
    assert.deepEqual([live.mode, live.url, live.key], ['supabase', GRAPH, 'anon-test-key']);
    assert.match(live.topic, /^inbox-[0-9a-f]{32}$/);
    assert.equal((await call('GET', '/api/events')).status, 404); // no local stream online
    g.broadcasts.length = 0;
    await webhook(inbound('919800000001', 'wamid.live1', { type: 'text', text: { body: 'private words' } }));
    await call('POST', '/api/conversations/919800000001/seen');
    assert.deepEqual(g.broadcasts, [
      { topic: live.topic, event: 'change', payload: { kind: 'message', waId: '919800000001' } },
      { topic: live.topic, event: 'change', payload: { kind: 'seen', waId: '919800000001' } },
    ]);
    const r = await call('POST', '/api/settings/webhook/connect');
    assert.equal(r.data.webhookSync.state, 'error');
    assert.match(r.data.webhookSync.message, /https/);
    // a password change gives live updates a new channel
    await call('POST', '/api/settings/password', { current: 'new password 1', next: 'new password 1' });
    assert.notEqual((await call('GET', '/api/session')).data.live.topic, live.topic);
  });

  await step('rate limit: 10 wrong passwords → 429', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await call('POST', '/api/login', { username: 'Owner', password: 'wrong wrong' });
    assert.equal(last.status, 429);
    assert.equal((await call('POST', '/api/settings/unlock', { password: 'new password 1' })).status, 429);
  });

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null) await stopServer();
  graph.close();
  await pgServer.stop(); await pg.close();
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may still hold the file */ }
}
