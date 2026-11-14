'use strict';
/* global $, $$, h, api, showError, toast, busy, errText, showScreen, timeOf, dayKey, dayLabel, listTime, prettyPhone, avatarFor, linkify, Settings, Push, brand, applyBranding, installHelp, promptInstall, isPhone, isTouch, isNarrow, lsGet, lsSet */

const state = { info: {}, convs: [], current: null, contact: null, messages: [], quick: [], templates: null, live: { mode: 'sse' }, maxUpload: 100 * 1024 * 1024 };
const displayName = c => c?.custom_name || c?.name || prettyPhone(c?.wa_id);

// ================= Start-up & auth =================
async function boot() {
  let s;
  try {
    const [b, sess] = await Promise.all([api('GET', '/api/branding'), api('GET', '/api/session')]);
    Object.assign(brand, b); applyBranding(brand); s = sess;
  } catch (e) { $('#loading').textContent = errText(e); return; }
  if (!s.hasPassword) return showAuth('signup');
  if (!s.loggedIn) return showAuth('login');
  state.info = s.info || {};
  window.me = s.user; // { username, owner }
  state.live = s.live || { mode: 'sse' };
  state.maxUpload = s.maxUpload || state.maxUpload;
  connectEvents();
  if (!s.configured) return Settings.open('connection', { firstRun: true });
  await showInbox();
  // Deep link from a notification: /#chat=<waId>
  const m = location.hash.match(/^#chat=(\d+)$/);
  if (m) { history.replaceState(history.state, '', location.pathname); openChat(m[1]); }
}

function showAuth(mode) {
  closeEvents();
  const create = mode === 'signup';
  showScreen('auth');
  $('#auth-form').dataset.mode = mode;
  $('#auth-title').textContent = create ? 'Create an account' : `Log in to ${brand.appName}`;
  $('#auth-sub').textContent = create
    ? 'Choose a username and password. Next, you connect your own WhatsApp Business number. Only you see your chats.'
    : 'Enter your username and password.';
  $('#auth-pw2-row').hidden = !create;
  $('#auth-pw2').required = create;
  $('#auth-pw').autocomplete = create ? 'new-password' : 'current-password';
  $('#auth-btn').textContent = create ? 'Sign up' : 'Log in';
  $('#auth-switch span').textContent = mode === 'login' ? 'New here?' : 'Already have an account?';
  $('#auth-switch button').textContent = mode === 'login' ? 'Create an account' : 'Log in';
  $('#auth-pw').value = ''; $('#auth-pw2').value = '';
  showError($('#auth-error'), null);
  $('#auth-user').focus();
}

$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const create = e.target.dataset.mode === 'signup';
  const pw = $('#auth-pw').value;
  if (create && pw.length < 8) return showError($('#auth-error'), new Error('Use at least 8 characters.'));
  if (create && pw !== $('#auth-pw2').value) return showError($('#auth-error'), new Error('The two passwords are not the same.'));
  try {
    await busy($('#auth-btn'), null, () => api('POST', create ? '/api/signup' : '/api/login', { username: $('#auth-user').value, password: pw }));
    boot();
  } catch (err) { showError($('#auth-error'), err); }
});

$('#auth-switch button').addEventListener('click', () => showAuth($('#auth-form').dataset.mode === 'login' ? 'signup' : 'login'));
window.onLoginRequired = () => showAuth('login');
window.onNotConfigured = () => Settings.open('connection');
window.onConfigured = info => { state.info = info || {}; };

// ================= Inbox =================
async function showInbox() {
  Settings.revertBranding();
  showScreen('inbox');
  renderInstallTip();
  const info = state.info;
  $('#me-name').textContent = info.verifiedName || 'My business';
  $('#me-number').textContent = info.displayPhoneNumber || '';
  avatarFor($('#me-avatar'), info.verifiedName || 'WA', 'me');
  $('#me-avatar').style.background = '';
  await loadConversations();
  if (state.current) openChat(state.current, { keepScroll: true });
}

async function loadConversations() {
  state.convs = await api('GET', '/api/conversations');
  renderChatList();
  updateTitle();
}
/** "(N) App name" title and the app-icon badge: N = unread messages. */
function updateTitle() {
  const unread = state.convs.reduce((n, c) => n + (c.unread || 0), 0);
  document.title = unread ? `(${unread}) ${brand.appName}` : brand.appName;
  try { (unread ? navigator.setAppBadge?.(unread) : navigator.clearAppBadge?.())?.catch(() => {}); } catch { /* optional */ }
}
window.updateTitle = updateTitle;

/** Closes this chat's notifications (it is on screen now). */
async function closeNotifications(waId) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const n of (await reg?.getNotifications({ tag: waId })) || []) n.close();
  } catch { /* not supported */ }
}

// ---- Install tip above the chat list (phones, not installed yet) ----
function renderInstallTip() {
  const i = installHelp();
  const show = isPhone() && !i.installed && lsGet('installTipHidden') !== '1';
  $('#install-tip').hidden = !show;
  if (!show) return;
  $('#install-tip-text').textContent = i.text;
  $('#install-tip-btn').hidden = !i.button;
}
window.onInstallChange = () => { renderInstallTip(); if (Settings.tab === 'security' && !$('#settings').hidden) Settings.renderInstall(); };
$('#install-tip-btn').addEventListener('click', promptInstall);
$('#install-tip-close').addEventListener('click', () => { lsSet('installTipHidden', '1'); renderInstallTip(); });

function lastPreview(c) {
  const icon = { image: '📷 ', video: '🎥 ', audio: '🎤 ', document: '📄 ', sticker: '💟 ', template: '📋 ' }[c.last_type] || '';
  const fallback = { image: 'Photo', video: 'Video', audio: 'Audio', document: 'Document', sticker: 'Sticker' }[c.last_type] || '';
  return icon + (c.last_body || fallback);
}

function tick(status, error) {
  if (status === 'failed') return h('span', { class: 'tick failed', title: error || 'Not delivered' }, '⚠');
  if (status === 'pending') return h('span', { class: 'tick', title: 'Sending' }, '🕓');
  const two = status === 'delivered' || status === 'read';
  return h('span', { class: 'tick' + (status === 'read' ? ' read' : ''), title: status || '' }, two ? '✓✓' : '✓');
}

function renderChatList() {
  const q = $('#search').value.trim().toLowerCase();
  const list = state.convs.filter(c => !q || [c.custom_name, c.name, c.wa_id, c.last_body].some(v => String(v || '').toLowerCase().includes(q.replace(/^\+/, ''))));
  $('#no-chats').hidden = state.convs.length > 0;
  $('#chat-list').replaceChildren(...list.map(c => {
    const av = h('div', { class: 'avatar' });
    avatarFor(av, displayName(c), c.wa_id);
    return h('li', { class: 'chat-item' + (c.wa_id === state.current ? ' active' : ''), onclick: () => openChat(c.wa_id), tabindex: 0,
      onkeydown: e => { if (e.key === 'Enter') openChat(c.wa_id); } },
    av,
    h('div', { class: 'ci-body' },
      h('div', { class: 'ci-top' }, h('span', { class: 'ci-name' }, displayName(c)), h('span', { class: 'ci-time' + (c.unread ? ' unread' : '') }, listTime(c.last_message_at))),
      h('div', { class: 'ci-bottom' },
        h('span', { class: 'ci-last' }, c.last_direction === 'out' ? tick(c.last_status) : null, c.last_direction === 'out' ? ' ' : null, lastPreview(c)),
        c.unread ? h('span', { class: 'unread-badge' }, String(c.unread)) : null)));
  }));
}
$('#search').addEventListener('input', renderChatList);

async function openChat(waId, { keepScroll = false } = {}) {
  const changed = state.current !== waId;
  state.current = waId;
  if (isNarrow() && history.state?.view !== 'chat') history.pushState({ view: 'chat' }, ''); // Android Back closes the chat
  $('#inbox').classList.add('show-thread');
  $('#placeholder').hidden = true;
  $('#thread').hidden = false;
  if (changed) { $('#text').value = ''; autoGrow(); closeQuick(); }
  renderChatList();
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const data = await api('GET', `/api/conversations/${encodeURIComponent(waId)}`);
  if (state.current !== waId) return;
  state.contact = data.contact; state.messages = data.messages;
  renderThreadHead();
  renderMessages();
  if (changed || !keepScroll || atBottom) box.scrollTop = box.scrollHeight;
  if (changed && window.matchMedia('(min-width: 761px)').matches && !$('#composer').hidden) $('#text').focus();
  markSeen();
  if (!document.hidden) closeNotifications(waId);
}

function closeChat() {
  state.current = null;
  $('#inbox').classList.remove('show-thread');
  $('#thread').hidden = true;
  $('#placeholder').hidden = false;
  renderChatList();
}
$('#back-to-list').addEventListener('click', () => (history.state?.view === 'chat' ? history.back() : closeChat()));

// Android Back button / browser back: close dialogs and popovers, then leave Settings or the chat
window.addEventListener('popstate', e => {
  for (const d of $$('dialog[open]')) d.close();
  closeQuick();
  const view = e.state?.view;
  if (!$('#settings').hidden) {
    if (!Settings.data?.configured) return;
    showInbox();
    if (view !== 'chat' && state.current) closeChat();
    return;
  }
  if (state.current && view !== 'chat') closeChat();
});

function renderThreadHead() {
  const c = state.contact;
  avatarFor($('#t-avatar'), displayName(c), c.wa_id);
  $('#t-name').textContent = displayName(c);
  const left = (c.last_inbound_at || 0) + 24 * 3600e3 - Date.now();
  const win = left > 0 ? `Can reply · ${Math.floor(left / 3600e3)}h ${Math.floor((left % 3600e3) / 60e3)}m left` : 'Template only';
  $('#t-sub').textContent = `${prettyPhone(c.wa_id)} · ${win}`;
  $('#composer').hidden = left <= 0;
  $('#window-closed').hidden = left > 0;
}

function mediaEl(m) {
  if (!m.media_id) return null;
  const src = `/api/media/${encodeURIComponent(m.media_id)}`;
  if (m.type === 'image' || m.type === 'sticker') {
    return h('img', { class: 'media', src, alt: m.type === 'sticker' ? 'Sticker' : 'Photo', loading: 'lazy', onclick: () => window.open(src, '_blank', 'noopener') });
  }
  if (m.type === 'video') return h('video', { class: 'media', src, controls: true, preload: 'metadata' });
  if (m.type === 'audio') return h('audio', { src, controls: true, preload: 'none' });
  return h('a', { class: 'doc', href: src, download: m.filename || 'document', target: '_blank', rel: 'noopener' }, '📄 ', m.filename || 'Document');
}

function renderMessages() {
  const box = $('#messages');
  const nodes = [];
  let lastDay = null, lastDir = null;
  for (const m of state.messages) {
    if (dayKey(m.timestamp) !== lastDay) {
      lastDay = dayKey(m.timestamp); lastDir = null;
      nodes.push(h('div', { class: 'day-sep' }, dayLabel(m.timestamp)));
    }
    const out = m.direction === 'out';
    nodes.push(h('div', { class: `msg ${out ? 'out' : 'in'}${m.direction !== lastDir ? ' tail' : ''}` },
      m.type === 'template' ? h('span', { class: 'tpl-tag' }, '📋 Template') : null,
      mediaEl(m),
      m.body ? linkify(m.body) : null,
      h('span', { class: 'meta' }, timeOf(m.timestamp), out ? tick(m.status, m.error) : null),
      out && m.status === 'failed' && m.error ? h('span', { class: 'err' }, m.error) : null));
    lastDir = m.direction;
  }
  if (!nodes.length) nodes.push(h('div', { class: 'day-sep' }, 'No messages yet'));
  box.replaceChildren(...nodes);
}

async function markSeen() {
  const c = state.convs.find(x => x.wa_id === state.current);
  if (!c?.unread || document.hidden) return;
  try { await api('POST', `/api/conversations/${encodeURIComponent(c.wa_id)}/seen`); } catch { return; }
  c.unread = 0;
  loadConversations();
}
window.addEventListener('focus', markSeen);
document.addEventListener('visibilitychange', markSeen);

// ================= Composer =================
const text = $('#text');
function autoGrow() { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 140) + 'px'; }

$('#composer').addEventListener('submit', async e => {
  e.preventDefault();
  const body = text.value.trim();
  if (!body || !state.current) return;
  const btn = $('#send-btn');
  try {
    await busy(btn, null, () => api('POST', '/api/send', { to: state.current, text: body }));
    text.value = ''; autoGrow();
    await refresh();
  } catch (err) { toast(errText(err), true); }
  text.focus();
});

text.addEventListener('input', () => {
  autoGrow();
  const v = text.value;
  if (v.startsWith('/') && !v.includes('\n')) openQuick(v.slice(1), false);
  else if (!$('#qr-pop').hidden && qr.fromSlash) closeQuick();
});
text.addEventListener('keydown', e => {
  if (!$('#qr-pop').hidden && quickKeys(e)) return;
  // Phones (touch): Enter adds a new line and the button sends, like WhatsApp. Computers: Enter sends.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) {
    e.preventDefault();
    $('#composer').requestSubmit($('#send-btn')); // pass the button: a bare requestSubmit() has no submitter
  }
});

// ---- Attach ----
$('#attach-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.current) return;
  if (file.size > state.maxUpload) return toast(`That file is too big (${Math.round(state.maxUpload / 1048576)} MB max).`, true);
  const caption = text.value.trim();
  const q = new URLSearchParams({ to: state.current, filename: file.name, caption });
  toast(`Sending ${file.name}…`);
  try {
    await api('POST', `/api/send-media?${q}`, file.type ? file : new Blob([file], { type: 'application/octet-stream' }));
    text.value = ''; autoGrow();
    toast('Sent');
    await refresh();
  } catch (err) { toast(errText(err), true); }
});

// ---- Quick replies popover ----
const qr = { items: [], filtered: [], active: 0, fromSlash: false };
async function openQuick(filter, focusSearch) {
  const pop = $('#qr-pop');
  if (pop.hidden) {
    try { state.quick = await api('GET', '/api/quick-replies'); } catch (e) { return toast(errText(e), true); }
  }
  qr.fromSlash = !focusSearch;
  pop.hidden = false;
  $('#qr-search').value = focusSearch ? filter : '';
  $('#qr-search').hidden = !focusSearch;
  filterQuick(filter);
  if (focusSearch) $('#qr-search').focus();
}
function filterQuick(filter) {
  const f = String(filter || '').toLowerCase();
  qr.filtered = state.quick.filter(q => !f || q.title.toLowerCase().includes(f) || q.body.toLowerCase().includes(f));
  qr.active = 0;
  renderQuick();
}
function renderQuick() {
  $('#qr-empty').hidden = qr.filtered.length > 0;
  $('#qr-empty').textContent = state.quick.length ? 'No quick replies match.' : 'No quick replies yet.';
  $('#qr-list').replaceChildren(...qr.filtered.map((q, i) => h('li', {
    role: 'option', class: i === qr.active ? 'active' : '', 'aria-selected': String(i === qr.active),
    onmousedown: e => { e.preventDefault(); chooseQuick(q); },
  }, h('b', {}, '/' + q.title), h('span', {}, q.body))));
  $('#qr-list').children[qr.active]?.scrollIntoView({ block: 'nearest' });
}
function chooseQuick(q) {
  text.value = qr.fromSlash ? q.body : (text.value ? text.value + (text.value.endsWith(' ') ? '' : ' ') : '') + q.body;
  closeQuick();
  autoGrow();
  text.focus();
}
function closeQuick() { $('#qr-pop').hidden = true; }
/** Arrow/Enter/Escape inside the popover. Returns true if handled. */
function quickKeys(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = qr.filtered.length;
    if (n) { qr.active = (qr.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderQuick(); }
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey && qr.filtered.length) { e.preventDefault(); chooseQuick(qr.filtered[qr.active]); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeQuick(); text.focus(); return true; }
  return false;
}
$('#qr-btn').addEventListener('click', () => ($('#qr-pop').hidden ? openQuick('', true) : closeQuick()));
$('#qr-search').addEventListener('input', e => filterQuick(e.target.value));
$('#qr-search').addEventListener('keydown', quickKeys);
$('#qr-manage').addEventListener('click', e => { e.preventDefault(); closeQuick(); Settings.open('quick'); });
document.addEventListener('mousedown', e => { if (!e.target.closest('#qr-pop, #qr-btn')) closeQuick(); });

// ================= Templates dialog =================
const tplDlg = { to: null };
async function openTemplateDialog(to) {
  tplDlg.to = to;
  showError($('#tpl-send-error'), null);
  const dlg = $('#template-dialog');
  try { state.templates = (await api('GET', '/api/templates')).templates; } catch (e) { return toast(errText(e), true); }
  const none = !state.templates.length;
  $('#tpl-none').hidden = !none;
  $('#tpl-pick').hidden = none;
  $('#tpl-send').hidden = none;
  if (!none) {
    $('#tpl-select').replaceChildren(...state.templates.map((t, i) => h('option', { value: i }, `${t.name} (${t.language})`)));
    renderTemplateVars();
  }
  dlg.showModal();
}
const tplText = (t, type) => t.components?.find(c => c.type === type)?.text || '';
function tplVars(t) { return [...new Set([...tplText(t, 'BODY').matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map(m => m[1]))]; }
function renderTemplateVars() {
  const t = state.templates[$('#tpl-select').value];
  $('#tpl-vars').replaceChildren(...tplVars(t).map(v => h('label', {}, `Value for {{${v}}}`,
    h('input', { 'data-var': v, required: true, oninput: renderTemplatePreview }))));
  renderTemplatePreview();
}
function templateFilled() {
  const t = state.templates[$('#tpl-select').value];
  const vals = Object.fromEntries($$('#tpl-vars input').map(i => [i.dataset.var, i.value]));
  const body = tplText(t, 'BODY').replace(/\{\{\s*([\w]+)\s*\}\}/g, (all, v) => vals[v] || all);
  return { t, vals, body };
}
function renderTemplatePreview() {
  const { t, body } = templateFilled();
  $('#tpl-preview').replaceChildren(tplText(t, 'HEADER') ? h('b', {}, tplText(t, 'HEADER')) : '', body,
    tplText(t, 'FOOTER') ? h('small', {}, tplText(t, 'FOOTER')) : '');
}
$('#tpl-select').addEventListener('change', renderTemplateVars);
$('#template-form').addEventListener('submit', async e => {
  e.preventDefault();
  const { t, vals, body } = templateFilled();
  const names = tplVars(t);
  const positional = names.every(n => /^\d+$/.test(n));
  const params = positional ? names.sort((a, b) => a - b).map(n => vals[n]) : vals;
  const preview = [tplText(t, 'HEADER'), body, tplText(t, 'FOOTER')].filter(Boolean).join('\n');
  try {
    await busy($('#tpl-send'), 'Sending…', () => api('POST', '/api/send-template', { to: tplDlg.to, name: t.name, language: t.language, params, preview }));
    $('#template-dialog').close();
    toast('Template sent');
    await loadConversations();
    openChat(state.convs.find(c => c.wa_id === tplDlg.to.replace(/\D/g, ''))?.wa_id || tplDlg.to.replace(/\D/g, ''));
  } catch (err) { showError($('#tpl-send-error'), err); }
});
$('#template-btn').addEventListener('click', () => openTemplateDialog(state.current));
$('#closed-template').addEventListener('click', () => openTemplateDialog(state.current));
$('#tpl-goto-settings').addEventListener('click', e => { e.preventDefault(); $('#template-dialog').close(); Settings.open('templates'); });

// ================= New chat & rename =================
$('#new-chat-btn').addEventListener('click', () => {
  $('#newchat-phone').value = '';
  showError($('#newchat-error'), null);
  $('#newchat-dialog').showModal();
});
$('#newchat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const num = $('#newchat-phone').value.replace(/\D/g, '');
  if (num.length < 6 || num.length > 15) return showError($('#newchat-error'), new Error('Enter the full number with country code, e.g. 919876543210.'));
  $('#newchat-dialog').close();
  const existing = state.convs.find(c => c.wa_id === num);
  if (existing?.window_open) return openChat(num);
  openTemplateDialog(num);
});

$('#t-name-btn').addEventListener('click', () => {
  const c = state.contact;
  $('#rename-input').value = c.custom_name || '';
  $('#rename-input').placeholder = c.name || prettyPhone(c.wa_id);
  $('#rename-hint').textContent = `Leave empty to use their WhatsApp name${c.name ? ` (${c.name})` : ''}.`;
  showError($('#rename-error'), null);
  $('#rename-dialog').showModal();
});
$('#rename-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('PUT', `/api/contacts/${encodeURIComponent(state.current)}`, { name: $('#rename-input').value });
    $('#rename-dialog').close();
    await refresh();
  } catch (err) { showError($('#rename-error'), err); }
});

// ================= Live updates =================
let refreshTimer;
function refresh() {
  clearTimeout(refreshTimer);
  return new Promise(res => {
    refreshTimer = setTimeout(async () => {
      if ($('#inbox').hidden) return res();
      try { await loadConversations(); if (state.current) await openChat(state.current, { keepScroll: true }); } catch { /* shown by api() */ }
      res();
    }, 60);
  });
}

let pushActive = false;
/** In-page notification when push is off on this device. Uses the chat-list preview (live events carry no text). */
function notify(waId) {
  if (pushActive || !('Notification' in window) || Notification.permission !== 'granted') return; // push already shows it
  if (!document.hidden && state.current === waId) return;
  const c = state.convs.find(x => x.wa_id === waId);
  if (!c || c.last_direction !== 'in') return;
  const body = Settings.data?.preferences?.pushPreview === false ? 'New message' : c.last_body || 'New message';
  const n = new Notification(displayName(c), { body, tag: waId });
  n.onclick = () => { window.focus(); showInbox().then(() => openChat(waId)); n.close(); };
}

/** One change from another device or from Meta: { kind, waId } (local stream events have more, unused here). */
async function onLiveEvent(d) {
  const waId = d.waId || d.wa_id || d.contact?.wa_id;
  if (d.kind === 'seen') { // read on another device
    const c = state.convs.find(x => x.wa_id === waId);
    if (c) { c.unread = 0; renderChatList(); updateTitle(); }
    closeNotifications(waId);
  }
  await refresh();
  if (d.kind === 'message') notify(waId);
}

// Three ways to hear about changes: Supabase Realtime (online), a local event stream (own computer), or polling.
const live = { stop: null };
function connectEvents() {
  if (live.stop) return;
  const mode = state.live.mode;
  if (mode === 'supabase') live.stop = connectSupabase(state.live);
  else if (mode === 'sse') live.stop = connectSse();
  else {
    const t = setInterval(() => { if (!document.hidden) refresh(); }, 30e3);
    live.stop = () => clearInterval(t);
  }
}
function closeEvents() { live.stop?.(); live.stop = null; }
// Catch up after the phone was asleep or the app was in the background
document.addEventListener('visibilitychange', () => { if (!document.hidden && live.stop) refresh(); });

function connectSse() {
  const es = new EventSource('/api/events');
  let dropped = false;
  es.onmessage = e => onLiveEvent(JSON.parse(e.data));
  es.onopen = () => { if (dropped) refresh(); dropped = false; };
  es.onerror = () => {
    dropped = true;
    if (es.readyState === EventSource.CLOSED) { // e.g. logged out elsewhere; try again later
      live.stop = null;
      setTimeout(() => api('GET', '/api/session').then(s => (s.loggedIn ? connectEvents() : showAuth('login'))).catch(() => {}), 5000);
    }
  };
  return () => es.close();
}

/** Supabase Realtime broadcast channel over its WebSocket (Phoenix protocol). Reconnects by itself. */
function connectSupabase({ url, key, topic }) {
  let ws, beat, retry, ref = 0, stopped = false, wait = 1000;
  const send = (t, event, payload) => ws.send(JSON.stringify({ topic: t, event, payload, ref: String(++ref), join_ref: t === 'phoenix' ? undefined : '1' }));
  const open = () => {
    ws = new WebSocket(`${url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`);
    ws.onopen = () => {
      send(`realtime:${topic}`, 'phx_join', { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false }, access_token: key });
      beat = setInterval(() => send('phoenix', 'heartbeat', {}), 25e3);
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.event === 'phx_reply' && m.topic === `realtime:${topic}` && m.payload?.status === 'ok' && wait > 1000) refresh(); // rejoined: catch up
      if (m.event === 'phx_reply' && m.payload?.status === 'ok') wait = 1000;
      if (m.event === 'broadcast' && m.payload?.event === 'change') onLiveEvent(m.payload.payload || {});
    };
    ws.onclose = () => {
      clearInterval(beat);
      if (stopped) return;
      wait = Math.min(wait * 2, 30e3);
      retry = setTimeout(open, wait);
    };
  };
  open();
  return () => { stopped = true; clearTimeout(retry); clearInterval(beat); ws?.close(); };
}

// ================= Settings navigation =================
$('#open-settings').addEventListener('click', () => Settings.open(Settings.tab || 'connection'));
$('#settings-back').addEventListener('click', () => (history.state?.view === 'settings' ? history.back() : showInbox()));
$('#setup-done').addEventListener('click', () => { Settings.firstRun = false; showInbox(); });
$('#logout-btn').addEventListener('click', async () => {
  await Push.turnOff(); // this device stops getting notifications
  pushActive = false;
  await api('POST', '/api/logout').catch(() => {});
  state.current = null;
  showAuth('login');
});

// keep the "Xh Ym left" label fresh
setInterval(() => { if (state.contact && !$('#thread').hidden) renderThreadHead(); }, 60e3);

// Service worker: push notifications only, it caches nothing
if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('Service worker:', e.message));
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'openChat' && e.data.waId && $('#auth').hidden) showInbox().then(() => openChat(e.data.waId));
  });
  Push.subscription().then(sub => { pushActive = !!sub; }).catch(() => {});
}

boot();
