import crypto from 'node:crypto';
import express from 'express';
import { getCredentials } from './settings.js';
import { insertMessage, touchContact, updateStatus, keep } from './db.js';
import { broadcast } from './events.js';
import { handleInbound } from './autoreply.js';
import { hintFor } from './whatsapp.js';
import { notifyMessage } from './push.js';
import { originOf } from './config.js';

export const webhookRouter = express.Router();

webhookRouter.get(['/webhook', '/webhook/:account'], (req, res) => {
  const c = getCredentials();
  if (c && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === c.verifyToken) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  }
  res.sendStatus(403);
});

webhookRouter.post(['/webhook', '/webhook/:account'], keep(express.raw({ type: () => true, limit: '5mb' })), async (req, res) => {
  const c = getCredentials();
  if (!c) return res.sendStatus(503);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const got = Buffer.from(req.get('x-hub-signature-256') || '');
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', c.appSecret).update(body).digest('hex'));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.sendStatus(401);
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return res.sendStatus(400); }
  // Process first, then answer: a Netlify Function stops when it answers. If saving fails, Meta retries later (duplicates are skipped).
  try { await processPayload(payload, c, originOf(req)); } catch (e) { console.error('Webhook processing failed:', e); return res.sendStatus(500); }
  res.sendStatus(200);
});

export function describeMessage(m) {
  const t = m.type;
  const out = { type: t || 'unsupported', body: '' };
  switch (t) {
    case 'text': out.body = m.text?.body || ''; break;
    case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
      const x = m[t] || {};
      Object.assign(out, { media_id: x.id, media_mime: x.mime_type, body: x.caption || '', filename: x.filename });
      break;
    }
    case 'location': {
      const l = m.location || {};
      const label = [l.name, l.address].filter(Boolean).join(', ');
      out.body = `📍 ${label ? label + '\n' : ''}https://maps.google.com/?q=${l.latitude},${l.longitude}`;
      break;
    }
    case 'contacts':
      out.body = (m.contacts || []).map(x => `👤 ${x.name?.formatted_name || 'Contact'}${x.phones?.length ? ': ' + x.phones.map(p => p.phone).join(', ') : ''}`).join('\n');
      break;
    case 'interactive': {
      const i = m.interactive || {};
      out.body = i.button_reply?.title || (i.list_reply && [i.list_reply.title, i.list_reply.description].filter(Boolean).join(' — '))
        || (i.nfm_reply && `📝 Form reply:\n${formReply(i.nfm_reply.response_json)}`) || '[Interactive reply]';
      break;
    }
    case 'button': out.body = m.button?.text || '[Button reply]'; break;
    case 'reaction': out.body = m.reaction?.emoji ? `Reacted ${m.reaction.emoji} to a message` : 'Removed a reaction'; break;
    case 'order': {
      const o = m.order || {};
      const items = (o.product_items || []).map(p => `• ${p.quantity} × ${p.product_retailer_id} — ${p.item_price} ${p.currency}`);
      out.body = ['🛒 Order', ...items, o.text].filter(Boolean).join('\n');
      break;
    }
    case 'system': out.body = `ℹ️ ${m.system?.body || 'The customer changed their number.'}`; break;
    case 'request_welcome': out.body = '👋 The customer opened the chat'; break;
    case 'unsupported': {
      // Meta does not pass on some types (view-once photos, polls, events, edited or deleted messages…)
      const e = m.errors?.[0];
      const what = m.unsupported?.type ? `a ${m.unsupported.type} message` : 'a message';
      out.body = `⚠️ The customer sent ${what} that WhatsApp's API does not deliver${e?.code ? ` (${e.code})` : ''}. Ask them to send it as a normal photo, file or text.`;
      break;
    }
    default: out.body = `[${t || 'Unknown'} message — open WhatsApp on a phone to see it]`;
  }
  if (m.referral) out.body = `📣 From ad: ${m.referral.headline || m.referral.source_url || 'ad'}\n${out.body}`;
  return out;
}

function formReply(json) {
  let r;
  try { r = JSON.parse(json || '{}'); } catch { return String(json || ''); }
  return Object.entries(r).filter(([k]) => k !== 'flow_token').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
}

function errorText(e) {
  if (!e) return null;
  const hint = hintFor(e.code, e.message);
  return `${e.title || e.message || 'Failed'} (${e.code})${e.error_data?.details ? ': ' + e.error_data.details : ''}${hint ? ' — ' + hint : ''}`;
}

export async function processPayload(payload, c, origin) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value;
      if (change.field !== 'messages' || !v) continue;
      if (v.metadata?.phone_number_id && v.metadata.phone_number_id !== c.phoneNumberId) continue;
      const names = Object.fromEntries((v.contacts || []).map(x => [x.wa_id, x.profile?.name]));
      for (const m of v.messages || []) {
        const ts = Number(m.timestamp) * 1000 || Date.now();
        const message = await insertMessage({ wamid: m.id, wa_id: m.from, direction: 'in', timestamp: ts, raw: m, ...describeMessage(m) });
        if (!message) continue; // duplicate delivery from Meta
        const isNew = await touchContact(m.from, { name: names[m.from], ts, inbound: true });
        await Promise.all([broadcast('message', { wa_id: m.from, message }), notifyMessage(m.from, message, origin)]);
        await handleInbound(m.from, message.type, isNew);
      }
      for (const s of v.statuses || []) {
        const row = await updateStatus(s.id, s.status, errorText(s.errors?.[0]));
        if (row) await broadcast('status', { wa_id: row.wa_id, wamid: s.id, status: row.status, error: row.error });
      }
    }
  }
}
