import crypto from 'node:crypto';
import webpush from 'web-push';
import { q, getSetting, setSetting, getContact, unreadTotal, acct } from './db.js';
import { encrypt, decrypt, getPreferences, getBranding } from './settings.js';
import { AppError } from './whatsapp.js';

/** VAPID keys: generated once, stored encrypted. */
export async function vapidKeys() {
  const raw = getSetting('vapid');
  if (raw) { try { return decrypt(raw); } catch { /* key changed: start over */ } }
  const vapid = webpush.generateVAPIDKeys();
  await setSetting('vapid', encrypt(vapid));
  await q('DELETE FROM push_subscriptions WHERE account = $1', [acct()]); // old subscriptions belong to the old keys
  return vapid;
}

export const deviceId = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

export async function listDevices() {
  return (await q('SELECT endpoint, device, created_at FROM push_subscriptions WHERE account = $1 ORDER BY created_at', [acct()]))
    .map(r => ({ id: deviceId(r.endpoint), device: r.device, since: r.created_at }));
}

export async function subscribe(sub, device) {
  let url;
  try { url = new URL(sub?.endpoint); } catch { /* handled below */ }
  if (url?.protocol !== 'https:') throw new AppError(400, 'Invalid push subscription (endpoint must be https).');
  const { p256dh, auth } = sub.keys || {};
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth) throw new AppError(400, 'Invalid push subscription (keys missing).');
  // a device that logs into another account moves to that account
  await q(`INSERT INTO push_subscriptions (endpoint, keys, device, created_at, account) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (endpoint) DO UPDATE SET keys = excluded.keys, device = excluded.device, account = excluded.account`,
  [sub.endpoint, JSON.stringify({ p256dh, auth }), String(device || 'Device').slice(0, 40), Date.now(), acct()]);
}
export const unsubscribe = endpoint => q('DELETE FROM push_subscriptions WHERE endpoint = $1 AND account = $2', [String(endpoint || ''), acct()]);
export async function removeById(id) {
  const row = (await q('SELECT endpoint FROM push_subscriptions WHERE account = $1', [acct()])).find(r => deviceId(r.endpoint) === id);
  if (row) await unsubscribe(row.endpoint);
  return !!row;
}

/** Sends to every device; removes devices the push service says are gone. Returns the number reached. */
async function sendAll(payload, origin) {
  const rows = await q('SELECT endpoint, keys FROM push_subscriptions WHERE account = $1', [acct()]);
  if (!rows.length) return 0;
  const { publicKey, privateKey } = await vapidKeys();
  const subject = /^https:/.test(origin || '') ? origin : 'mailto:admin@example.com';
  const options = {
    TTL: 24 * 3600, urgency: 'high', topic: String(payload.tag || 'msg').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'msg',
    vapidDetails: { subject, publicKey, privateKey },
  };
  const body = JSON.stringify(payload);
  let ok = 0;
  await Promise.all(rows.map(async r => {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: JSON.parse(r.keys) }, body, { ...options, timeout: 5000 });
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await unsubscribe(r.endpoint);
      else console.error(`Push to a device failed: ${e.statusCode || ''} ${e.message}`);
    }
  }));
  return ok;
}

const MEDIA_LABEL = { image: '📷 Photo', video: '🎥 Video', audio: '🎤 Audio', document: '📄 Document', sticker: 'Sticker' };

export async function notifyMessage(waId, message, origin) {
  if (['unsupported', 'system'].includes(message.type)) return 0;
  try {
    const c = (await getContact(waId)) || {};
    const text = message.body || MEDIA_LABEL[message.type] || 'New message';
    return await sendAll({
      title: c.custom_name || c.name || `+${waId}`,
      body: getPreferences().pushPreview ? text.slice(0, 300) : 'New message',
      waId, tag: waId, unread: await unreadTotal(),
    }, origin);
  } catch (e) { console.error('Push failed:', e.message); return 0; }
}

export async function sendTest(origin) {
  if (!(await q('SELECT COUNT(*) AS n FROM push_subscriptions WHERE account = $1', [acct()]))[0].n) throw new AppError(400, 'No device has notifications turned on yet.');
  const { appName } = getBranding();
  return sendAll({ title: appName, body: `${appName}: Notifications are working 🎉`, tag: 'test', unread: await unreadTotal() }, origin);
}
