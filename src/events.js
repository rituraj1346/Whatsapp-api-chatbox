import crypto from 'node:crypto';
import { insertMessage, touchContact, getSetting, setSetting, acct } from './db.js';
import { SERVERLESS, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/** How open devices hear about changes: Supabase Realtime, a local event stream, or polling. */
export const liveMode = () => (SUPABASE_URL && SUPABASE_ANON_KEY ? 'supabase' : SERVERLESS ? 'poll' : 'sse');

/** Secret channel name, given only to logged-in devices. A new one is made when the password changes. */
export async function liveTopic(renew = false) {
  let t = getSetting('live_topic');
  if (!t || renew) await setSetting('live_topic', (t = `inbox-${crypto.randomBytes(16).toString('hex')}`));
  return t;
}
/** What a logged-in browser needs to listen for changes. */
export async function liveConfig() {
  const mode = liveMode();
  return mode === 'supabase' ? { mode, url: SUPABASE_URL, key: SUPABASE_ANON_KEY, topic: await liveTopic() } : { mode };
}

// ---- Local event stream (on your own computer) ----
const clients = new Set();
export function sseHandler(req, res) {
  if (liveMode() !== 'sse') return res.status(404).json({ error: 'Not available here.' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(': connected\n\n');
  const client = { res, account: acct() }; // each open screen only hears its own account
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
  req.on('close', () => { clearInterval(ping); clients.delete(client); });
}

/**
 * Every event is one JSON object with a kind: message | status | seen | contact.
 * Through Supabase only { kind, waId } is sent (no message text); devices then reload through the logged-in API.
 */
export async function broadcast(kind, data) {
  if (liveMode() === 'supabase') {
    const waId = data.waId || data.wa_id || data.contact?.wa_id;
    try {
      const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
        method: 'POST', signal: AbortSignal.timeout(4000),
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ topic: await liveTopic(), event: 'change', payload: { kind, waId } }] }),
      });
      if (!res.ok) console.error(`Live update failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    } catch (e) { console.error('Live update failed:', e.message); }
    return;
  }
  const msg = `data: ${JSON.stringify({ kind, ...data })}\n\n`;
  for (const c of clients) if (c.account === acct()) c.res.write(msg);
}

/** Stores a message we sent (from a Graph send response) and tells open devices. */
export async function recordOutgoing(to, resp, fields) {
  const waId = resp?.contacts?.[0]?.wa_id || to;
  const ts = Date.now();
  await touchContact(waId, { ts, inbound: false });
  const message = await insertMessage({
    wamid: resp?.messages?.[0]?.id || `local-${crypto.randomUUID()}`,
    wa_id: waId, direction: 'out', status: 'sent', timestamp: ts, ...fields,
  });
  await broadcast('message', { wa_id: waId, message });
  return message;
}
