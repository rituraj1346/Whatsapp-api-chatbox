import crypto from 'node:crypto';
import { GRAPH_BASE_URL, DEFAULT_GRAPH_VERSION } from './config.js';
import { getCredentials } from './settings.js';

export class AppError extends Error {
  constructor(status, error, extra = {}) { super(error); Object.assign(this, { status, ...extra }); }
}
/** Express 4 does not catch rejected promises; pass them to the error handler. */
export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const bad = msg => new AppError(400, msg);
export const notConfigured = () =>
  new AppError(409, 'WhatsApp is not connected yet. Open Settings → Connection.', { code: 'not_configured' });

const HINTS = {
  100: 'Meta did not accept one of the values. Check the Phone number ID and WhatsApp Business Account ID on the API Setup page.',
  190: 'The access token is wrong or has expired. Create a permanent System User token in Business Settings and save it again.',
  200: 'The token is missing a permission. Give the System User whatsapp_business_messaging and whatsapp_business_management and create a new token.',
  131030: 'This number is not on the allowed list of your test number. Add it under API Setup → "To", or use a real registered number.',
  131047: 'More than 24 hours have passed since this customer last wrote. You can only send an approved template now.',
  131026: 'WhatsApp could not deliver this message. The number may not use WhatsApp, or has not accepted the latest terms.',
  132001: 'This template does not exist in this language, or is not approved yet. Check Settings → Templates.',
  133010: 'This phone number is not registered with the Cloud API yet. Register it in Settings → Connection with a 6-digit PIN.',
};
export function hintFor(code, message = '') {
  if (/appsecret_proof/i.test(message)) return 'The App secret does not belong to the same Meta app as the access token. Copy it again from App settings → Basic.';
  return HINTS[code] || '';
}

export const appSecretProof = (secret, token) => crypto.createHmac('sha256', secret).update(token).digest('hex');

/** Calls the Graph API. Uses the user token + appsecret_proof unless an app token is given. */
export async function graph(path, { method = 'GET', query = {}, body, form, creds = getCredentials(), appToken = false } = {}) {
  if (!creds) throw notConfigured();
  const token = appToken ? `${creds.appId}|${creds.appSecret}` : creds.token;
  const url = new URL(`${GRAPH_BASE_URL}/${creds.graphVersion || DEFAULT_GRAPH_VERSION}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  if (!appToken) url.searchParams.set('appsecret_proof', appSecretProof(creds.appSecret, token));
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: form || (body && JSON.stringify(body)) });
  } catch (e) {
    throw new AppError(502, `Could not reach WhatsApp: ${e.cause?.code || e.message}`, { hint: 'Check your internet connection.' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = data.error || {};
    const msg = err.error_user_msg || err.message || `HTTP ${res.status}`;
    throw new AppError(502, msg, { code: err.code, hint: hintFor(err.code, err.message) });
  }
  return data;
}

const phone = () => getCredentials()?.phoneNumberId;
const waba = () => getCredentials()?.wabaId;

/** Proves token + app secret, finds names and the App ID. Throws AppError on failure. */
export async function verifyCredentials(creds) {
  const p = await graph(creds.phoneNumberId, { creds, query: { fields: 'display_phone_number,verified_name,quality_rating' } });
  const w = await graph(creds.wabaId, { creds, query: { fields: 'name' } });
  let app = null;
  try { app = await graph('app', { creds, query: { fields: 'id,name' } }); } catch { /* fall back to the manual App ID */ }
  return {
    displayPhoneNumber: p.display_phone_number, verifiedName: p.verified_name, qualityRating: p.quality_rating,
    wabaName: w.name, appId: app?.id || creds.appId || '', appName: app?.name || '',
  };
}

const send = payload => graph(`${phone()}/messages`, { method: 'POST', body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload } });
export const sendText = (to, text) => send({ to, type: 'text', text: { body: text, preview_url: true } });
export const sendTemplate = (to, name, language, components) =>
  send({ to, type: 'template', template: { name, language: { code: language }, ...(components?.length ? { components } : {}) } });
export const markRead = messageId => send({ status: 'read', message_id: messageId });

export function mediaKind(mime) {
  if (/^image\/(jpeg|png)$/.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  return 'document';
}
export async function sendMedia(to, buffer, mime, filename, caption) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), filename || 'file');
  const { id } = await graph(`${phone()}/media`, { method: 'POST', form });
  const kind = mediaKind(mime);
  const media = { id };
  if (caption && kind !== 'audio') media.caption = caption;
  if (kind === 'document') media.filename = filename || 'file';
  const r = await send({ to, type: kind, [kind]: media });
  return { ...r, mediaId: id, kind };
}
/** Returns the fetch Response for a media file. */
export async function downloadMedia(id) {
  const info = await graph(id);
  const res = await fetch(info.url, { headers: { Authorization: `Bearer ${getCredentials().token}` } });
  if (!res.ok) throw new AppError(502, `Could not download media (HTTP ${res.status})`);
  return res;
}

export const registerNumber = pin => graph(`${phone()}/register`, { method: 'POST', body: { messaging_product: 'whatsapp', pin } });

export async function getBusinessProfile() {
  const r = await graph(`${phone()}/whatsapp_business_profile`, { query: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' } });
  return r.data?.[0] || {};
}
export const updateBusinessProfile = p => graph(`${phone()}/whatsapp_business_profile`, { method: 'POST', body: { messaging_product: 'whatsapp', ...p } });

export async function listTemplates() {
  const all = [];
  let after;
  do {
    const r = await graph(`${waba()}/message_templates`, { query: { fields: 'name,status,category,language,components,rejected_reason', limit: 100, after } });
    all.push(...(r.data || []));
    after = r.paging?.next ? r.paging.cursors?.after : null;
  } while (after);
  return all;
}
export const createTemplate = t => graph(`${waba()}/message_templates`, { method: 'POST', body: t });
export const deleteTemplate = name => graph(`${waba()}/message_templates`, { method: 'DELETE', query: { name } });

export async function connectWebhook(callbackUrl) {
  const c = getCredentials();
  if (!c) throw notConfigured();
  if (!c.appId) throw new AppError(400, 'The App ID is unknown. Enter it under Connection → Advanced.');
  await graph(`${c.appId}/subscriptions`, {
    method: 'POST', appToken: true,
    query: { object: 'whatsapp_business_account', callback_url: callbackUrl, verify_token: c.verifyToken, fields: 'messages' },
  });
  await graph(`${c.wabaId}/subscribed_apps`, { method: 'POST' });
}
export async function webhookStatus() {
  const c = getCredentials();
  if (!c) throw notConfigured();
  if (!c.appId) throw new AppError(400, 'The App ID is unknown. Enter it under Connection → Advanced.');
  const subs = await graph(`${c.appId}/subscriptions`, { appToken: true });
  const sub = (subs.data || []).find(s => s.object === 'whatsapp_business_account');
  const apps = await graph(`${c.wabaId}/subscribed_apps`);
  return {
    callbackUrl: sub?.callback_url || '',
    active: !!sub?.active,
    messagesField: !!sub?.fields?.some(f => (f.name || f) === 'messages'),
    wabaSubscribed: (apps.data || []).some(a => (a.whatsapp_business_api_data?.id || a.id) === c.appId),
  };
}
