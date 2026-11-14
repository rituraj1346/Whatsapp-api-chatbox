'use strict';
// Shared helpers. The DOM is built with createElement/textContent only: customer messages are untrusted.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div', {class: 'x', onclick: fn}, 'text', childNode) */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof Blob) { opts.body = body; opts.headers['Content-Type'] = body.type || 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(url, opts); } catch { throw Object.assign(new Error('Cannot reach the app. Is it still running?'), { status: 0 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(data.error || `Something went wrong (${res.status})`), { status: res.status, code: data.code, hint: data.hint });
    if (res.status === 401 && data.code === 'login_required') window.onLoginRequired?.();
    if (res.status === 409 && data.code === 'not_configured') window.onNotConfigured?.();
    throw err;
  }
  return data;
}

const errText = e => (e.hint ? `${e.message}\n${e.hint}` : e.message);
function showError(el, e) { el.textContent = e ? errText(e) : ''; el.hidden = !e; }

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'toast bad' : 'toast'; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}

/** Disables a button and shows busy text while fn runs. */
async function busy(btn, text, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  if (text) btn.textContent = text;
  try { return await fn(); } finally { btn.disabled = false; if (text) btn.textContent = old; }
}

const pad = n => String(n).padStart(2, '0');
const timeOf = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayKey = ts => new Date(ts).toDateString();
function dayLabel(ts) {
  const d = new Date(ts), today = new Date(), y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (today - d < 6 * 86400e3) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function listTime(ts) {
  if (!ts) return '';
  const l = dayLabel(ts);
  return l === 'Today' ? timeOf(ts) : l.length > 10 ? new Date(ts).toLocaleDateString() : l;
}
const prettyPhone = waId => (waId ? `+${waId}` : '');
function initials(name) {
  const parts = String(name || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : (parts[0] || '#').slice(0, 2)).toUpperCase();
}
const AVATAR_COLORS = ['#25a18e', '#6b5bd2', '#e26a3a', '#1f8bd6', '#c84b8a', '#3e9b4f', '#a5762b', '#5b7087'];
function avatarFor(el, name, key) {
  el.textContent = initials(name);
  let n = 0; for (const c of String(key)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  el.style.background = AVATAR_COLORS[n % AVATAR_COLORS.length];
}

/** Text with clickable http(s) links, built safely. */
function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"']+/g)) {
    frag.append(text.slice(last, m.index), h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Could not copy. Select the text and copy it by hand.', true); }
}

// Close buttons inside dialogs
document.addEventListener('click', e => {
  const b = e.target.closest('[data-close]');
  if (b) b.closest('dialog').close();
});

function showScreen(id) {
  $('#loading').hidden = true;
  for (const s of ['auth', 'settings', 'inbox']) $('#' + s).hidden = s !== id;
}

// ---------- Branding ----------
const brand = { appName: 'Business Inbox', accent: '#2563eb' };
/** Readable text colour (black or white) for a #rrggbb background. */
function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#111b21' : '#ffffff';
}
/** Applies a branding (saved or a live preview) to the whole page. */
function applyBranding(b) {
  const root = document.documentElement.style;
  root.setProperty('--brand', b.accent);
  root.setProperty('--brand-text', textOn(b.accent));
  const v = b.accent.slice(1);
  for (const img of $$('.brand-icon')) img.src = `/favicon.svg?v=${v}`;
  for (const el of $$('.brand-name')) el.textContent = b.appName;
  $('meta[name="theme-color"]').content = b.accent;
  $('meta[name="apple-mobile-web-app-title"]').content = b.appName;
  $('link[rel="icon"]').href = `/favicon.svg?v=${v}`;
  $('link[rel="apple-touch-icon"]').href = `/apple-touch-icon.png?v=${v}`;
  window.updateTitle?.();
}

// ---------- Device ----------
const UA = navigator.userAgent;
const isIOS = () => /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
const isAndroid = () => /Android/.test(UA);
const isPhone = () => isIOS() || isAndroid();
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isTouch = () => matchMedia('(pointer: coarse)').matches;
const isNarrow = () => matchMedia('(max-width: 760px)').matches;
function deviceName() {
  if (/iPhone|iPod/.test(UA)) return 'iPhone';
  if (isIOS()) return 'iPad';
  if (isAndroid()) return 'Android';
  if (/Macintosh/.test(UA)) return 'Mac';
  if (/Windows/.test(UA)) return 'Windows';
  return /Linux/.test(UA) ? 'Linux' : 'Computer';
}

// Android / computer install prompt
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; window.onInstallChange?.(); });
window.addEventListener('appinstalled', () => { installPrompt = null; window.onInstallChange?.(); });
async function promptInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  window.onInstallChange?.();
}
/** What to tell this device about installing. */
function installHelp() {
  const name = brand.appName;
  if (isStandalone()) return { installed: true, text: `✓ You are using the installed ${name} app.` };
  if (installPrompt) return { button: true, text: `Install ${name} for a full-screen app with notifications.` };
  if (isIOS()) return { text: `Add this app to your Home Screen: tap Share (the square with an arrow) in Safari, then "Add to Home Screen". Then open ${name} from your Home Screen.` };
  if (isAndroid()) return { text: 'Install this app: open the browser menu ⋮ and tap "Install app" (or "Add to Home screen").' };
  if (/Macintosh/.test(UA) && /Safari/.test(UA) && !/Chrome|Chromium|Edg|Firefox/.test(UA)) return { text: 'In Safari, choose File → Add to Dock.' };
  return { text: 'In Chrome or Edge, click the install icon at the right end of the address bar (or menu ⋮ → "Install…").' };
}

function urlB64ToBytes(s) {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
