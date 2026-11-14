import { q, acct } from './db.js';
import { getAutoReplies } from './settings.js';
import { sendText } from './whatsapp.js';
import { recordOutgoing } from './events.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const AWAY_GAP = 12 * 3600e3;

/** Opening hours check in the given time zone. Overnight shifts (start > end) belong to the day they start. */
export function isOpen(away, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: away.timezone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  const day = DAYS.indexOf(get('weekday'));
  const now = Number(get('hour')) * 60 + Number(get('minute'));
  const start = toMin(away.start), end = toMin(away.end), days = away.days || [];
  if (start === end) return days.includes(day); // same time twice = open all day
  if (start < end) return days.includes(day) && now >= start && now < end;
  return (days.includes(day) && now >= start) || (days.includes((day + 6) % 7) && now < end);
}

async function reply(waId, text) {
  try {
    await recordOutgoing(waId, await sendText(waId, text), { type: 'text', body: text });
  } catch (e) {
    console.error(`Auto-reply to ${waId} failed: ${e.message}`);
  }
}

export async function handleInbound(waId, type, isNew, now = Date.now()) {
  if (type === 'reaction' || type === 'unsupported') return;
  const { welcome, away } = getAutoReplies();
  if (isNew && welcome.enabled && welcome.text) await reply(waId, welcome.text);
  if (away.enabled && away.text && !isOpen(away, new Date(now))) {
    const last = (await q('SELECT last_away FROM auto_reply_log WHERE account = $1 AND wa_id = $2', [acct(), waId]))[0]?.last_away || 0;
    if (now - last < AWAY_GAP) return;
    await q('INSERT INTO auto_reply_log (account, wa_id, last_away) VALUES ($1, $2, $3) ON CONFLICT (account, wa_id) DO UPDATE SET last_away = excluded.last_away', [acct(), waId, now]);
    await reply(waId, away.text);
  }
}
