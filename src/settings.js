import crypto from 'node:crypto';
import { SECRET_KEY, DEFAULT_GRAPH_VERSION } from './config.js';
import { getSetting, setSetting } from './db.js';

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
export function decrypt(str) {
  const [v, iv, tag, ct] = String(str).split(':');
  if (v !== 'v1') throw new Error('Unknown format');
  const d = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
}

let cache = { raw: undefined, value: null }; // decrypted once per stored value
export function getCredentials() {
  const raw = getSetting('credentials');
  if (raw !== cache.raw) {
    let value = null;
    try { value = raw ? decrypt(raw) : null; } catch { /* wrong key = treat as not configured */ }
    cache = { raw, value };
  }
  return cache.value;
}
export async function saveCredentials(c) {
  await setSetting('credentials', encrypt({ ...c, graphVersion: c.graphVersion || DEFAULT_GRAPH_VERSION }));
}
export const isConfigured = () => !!getCredentials();

export const mask = s => (s ? `${s.slice(0, 4)}••••••${s.slice(-4)}` : '');

export const getProfile = () => getSetting('profile', {});
export const getPreferences = () => ({ sendReadReceipts: true, pushPreview: true, ...getSetting('preferences', {}) });
export const DEFAULT_BRANDING = { appName: 'Business Inbox', accent: '#2563eb' };
export const getBranding = () => ({ ...DEFAULT_BRANDING, ...getSetting('branding', {}) });
export function getAutoReplies() {
  const s = getSetting('auto_replies', {});
  return {
    welcome: { enabled: false, text: 'Hi! Thanks for messaging us. We will reply soon.', ...s.welcome },
    away: {
      enabled: false, text: 'Thanks for your message! We are closed right now and will reply when we open.',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00',
      ...s.away,
    },
  };
}
