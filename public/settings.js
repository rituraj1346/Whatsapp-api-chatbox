'use strict';
/* global $, $$, h, api, showError, toast, busy, copyText, showScreen, errText, brand, applyBranding, installHelp, promptInstall, isIOS, isStandalone, isNarrow, deviceName, urlB64ToBytes */

const LANGUAGES = [
  ['en', 'English'], ['en_US', 'English (US)'], ['en_GB', 'English (UK)'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['gu', 'Gujarati'],
  ['kn', 'Kannada'], ['ml', 'Malayalam'], ['mr', 'Marathi'], ['pa', 'Punjabi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ur', 'Urdu'],
  ['ar', 'Arabic'], ['zh_CN', 'Chinese (Simplified)'], ['nl', 'Dutch'], ['fil', 'Filipino'], ['fr', 'French'], ['de', 'German'],
  ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ms', 'Malay'], ['fa', 'Persian'],
  ['pt_BR', 'Portuguese (Brazil)'], ['pt_PT', 'Portuguese (Portugal)'], ['ru', 'Russian'], ['es', 'Spanish'], ['es_MX', 'Spanish (Mexico)'],
  ['sw', 'Swahili'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['vi', 'Vietnamese'],
];
const STATUS_BADGE = { APPROVED: ['Approved', 'ok'], PENDING: ['Waiting for approval', 'warn'], REJECTED: ['Rejected', 'bad'] };

const Settings = {
  data: null,
  tab: 'connection',
  firstRun: false,
  pollTimer: null,
  lockTimer: null,

  async open(tab = 'connection', { firstRun = false } = {}) {
    this.firstRun = firstRun;
    const wasOpen = !$('#settings').hidden;
    showScreen('settings');
    $('#tabs [data-tab="branding"]').hidden = !window.me?.owner; // the site's name and colour belong to its owner
    await this.load();
    // Android Back button leaves Settings (only once there is an inbox to go back to)
    if (!wasOpen && this.data.configured && isNarrow() && history.state?.view !== 'settings') history.pushState({ view: 'settings' }, '');
    this.select(tab);
  },

  async load() {
    this.data = await api('GET', '/api/settings');
    if (!this.data.configured) this.firstRun = true;
    this.renderChrome();
    this.renderConnection();
    this.renderReceive();
  },

  renderChrome() {
    const c = this.data.configured;
    $('#settings-back').hidden = !c;
    for (const b of $$('#tabs [data-needs-connection]')) {
      b.classList.toggle('dim', !c);
      b.setAttribute('aria-disabled', String(!c));
    }
    const step = $('#setup-step');
    step.hidden = !this.firstRun;
    if (this.firstRun) {
      const onReceive = c && this.tab === 'receive';
      $('#setup-step-text').textContent = c
        ? (onReceive ? 'Step 2 of 2: check that messages can reach you.' : '✓ Your number is connected. Next: Receive messages.')
        : 'Step 1 of 2: connect your WhatsApp number.';
      $('#setup-done').hidden = !c;
    }
  },

  select(tab) {
    const btn = $(`#tabs [data-tab="${tab}"]`);
    if (btn.hasAttribute('data-needs-connection') && !this.data.configured) {
      toast('Connect your WhatsApp number first.'); tab = 'connection';
    }
    if (this.tab === 'branding' && tab !== 'branding') this.revertBranding(); // unsaved preview
    this.tab = tab;
    for (const b of $$('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== tab;
    $(`#tabs [data-tab="${tab}"]`).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.renderChrome();
    const loaders = { profile: 'loadProfile', templates: 'loadTemplates', quick: 'loadQuick', auto: 'loadAuto', security: 'renderSecurity', receive: 'renderReceive', branding: 'loadBranding' };
    if (loaders[tab]) Promise.resolve().then(() => this[loaders[tab]]()).catch(e => toast(errText(e), true));
  },

  // ---------- Connection ----------
  renderConnection() {
    const d = this.data, f = $('#cred-form'), c = d.connection;
    const editing = !d.configured || !d.locked;
    const info = d.info || {};
    $('#conn-status').hidden = !d.configured;
    if (d.configured) {
      $('#conn-status').replaceChildren(h('span', { class: 'dot' }, '● '), 'Connected ',
        h('b', {}, info.verifiedName || ''), ` · ${info.displayPhoneNumber || ''}${info.qualityRating ? ` · quality ${info.qualityRating}` : ''}`);
    }
    $('#conn-intro').hidden = d.configured && d.locked;
    const badge = $('#lock-badge');
    badge.hidden = !d.configured;
    clearInterval(this.lockTimer);
    if (d.configured) {
      const paint = () => {
        const mins = Math.max(0, Math.ceil((d.unlockedUntil - Date.now()) / 60e3));
        if (!d.locked && mins === 0) return this.load(); // the server has locked it again
        badge.textContent = d.locked ? '🔒 Locked' : `🔓 Editing · locks in ${mins} min`;
        badge.className = d.locked ? 'badge' : 'badge warn';
      };
      paint();
      if (!d.locked) this.lockTimer = setInterval(paint, 15e3);
    }
    for (const k of ['phoneNumberId', 'wabaId', 'appId', 'verifyToken', 'graphVersion']) f.elements[k].value = c?.[k] || '';
    for (const k of ['token', 'appSecret']) {
      const el = f.elements[k];
      el.type = editing ? 'password' : 'text';
      el.value = editing ? '' : c?.[k] || '';
      el.placeholder = editing && c?.[k] ? `Saved (${c[k]}). Leave empty to keep it` : '';
    }
    for (const el of f.elements) if (el.name) el.disabled = !editing;
    $('#cred-edit').hidden = editing;
    $('#cred-cancel').hidden = !(d.configured && editing);
    $('#cred-save').hidden = !editing;
    showError($('#cred-error'), null);
    $('#register-form').hidden = !d.configured;
  },

  async saveCredentials(e) {
    e.preventDefault();
    const f = e.target, body = Object.fromEntries(new FormData(f));
    showError($('#cred-error'), null);
    try {
      await busy($('#cred-save'), 'Checking with WhatsApp…', async () => {
        this.data = await api('PUT', '/api/settings/credentials', body);
      });
    } catch (err) { return showError($('#cred-error'), err); }
    toast('Connected and saved');
    window.onConfigured?.(this.data.info);
    this.renderConnection(); this.renderReceive();
    if (this.firstRun) this.select('receive'); else this.renderChrome();
  },

  unlock() {
    const dlg = $('#unlock-dialog');
    $('#unlock-pw').value = '';
    showError($('#unlock-error'), null);
    dlg.showModal();
  },

  // ---------- Receive messages ----------
  renderReceive() {
    const d = this.data;
    if (!d) return;
    $('#app-origin').textContent = d.origin;
    const s = d.webhookSync;
    $('#wh-badge').hidden = s.state !== 'ok';
    const msg = $('#wh-message');
    msg.className = s.state === 'error' ? 'error' : 'muted';
    msg.textContent = s.message || 'Not connected yet. Click "Connect webhook now".';
    $('#cb-url').textContent = d.callbackUrl;
    $('#vt').textContent = d.connection?.verifyToken || '—';
  },

  async connectWebhook(btn) {
    try {
      await busy(btn, 'Connecting…', async () => { this.data = await api('POST', '/api/settings/webhook/connect'); });
      this.renderReceive();
    } catch (e) { toast(errText(e), true); }
  },

  async checkWebhook(btn) {
    const ul = $('#wh-status');
    try {
      const s = await busy(btn, 'Asking Meta…', () => api('GET', '/api/settings/webhook/status'));
      const yes = v => (v ? '✅ yes' : '❌ no');
      const matches = !!this.data.callbackUrl && s.callbackUrl === this.data.callbackUrl;
      ul.replaceChildren(
        h('li', {}, `Callback URL at Meta: ${s.callbackUrl || '(none)'}`),
        h('li', {}, `Points to this app's address: ${yes(matches)}`),
        h('li', {}, `Subscription active: ${yes(s.active)}`),
        h('li', {}, `"messages" field subscribed: ${yes(s.messagesField)}`),
        h('li', {}, `Your WhatsApp account is linked to the app: ${yes(s.wabaSubscribed)}`),
      );
      ul.hidden = false;
    } catch (e) { toast(errText(e), true); }
  },

  // ---------- Business profile ----------
  async loadProfile() {
    const { profile, verticals } = await api('GET', '/api/settings/business-profile');
    this.fillProfile(profile, verticals);
  },
  fillProfile(p, verticals) {
    const f = $('#bp-form');
    f.elements.vertical.replaceChildren(...verticals.map(([v, label]) => h('option', { value: v }, label)));
    f.elements.about.value = p.about || '';
    f.elements.description.value = p.description || '';
    f.elements.address.value = p.address || '';
    f.elements.email.value = p.email || '';
    f.elements.website1.value = p.websites?.[0] || '';
    f.elements.website2.value = p.websites?.[1] || '';
    f.elements.vertical.value = p.vertical && verticals.some(([v]) => v === p.vertical) ? p.vertical : '';
    $('#about-count').textContent = f.elements.about.value.length;
    const pic = $('#bp-pic');
    pic.hidden = !p.profile_picture_url;
    if (p.profile_picture_url) pic.src = p.profile_picture_url;
    showError($('#bp-error'), null);
  },
  async saveProfile(e) {
    e.preventDefault();
    const f = e.target, v = Object.fromEntries(new FormData(f));
    showError($('#bp-error'), null);
    try {
      const r = await busy(f.querySelector('.primary'), 'Saving…', () => api('PUT', '/api/settings/business-profile', {
        about: v.about, description: v.description, address: v.address, email: v.email, vertical: v.vertical,
        websites: [v.website1, v.website2].filter(Boolean),
      }));
      this.fillProfile(r.profile, r.verticals);
      toast('Business profile saved');
    } catch (err) { showError($('#bp-error'), err); }
  },

  // ---------- Templates ----------
  async loadTemplates() {
    const ul = $('#tpl-list');
    ul.replaceChildren(h('li', { class: 'muted' }, 'Loading…'));
    try {
      const { templates } = await api('GET', '/api/settings/templates');
      if (!templates.length) return ul.replaceChildren(h('li', { class: 'muted' }, 'No templates yet. Create your first one below.'));
      ul.replaceChildren(...templates.map(t => {
        const [label, cls] = STATUS_BADGE[t.status] || [t.status, ''];
        const body = t.components?.find(c => c.type === 'BODY')?.text || '';
        return h('li', {},
          h('div', { class: 'grow' },
            h('b', {}, t.name), ' ', h('small', {}, `${t.language} · ${String(t.category || '').toLowerCase()}`),
            h('p', {}, body),
            t.status === 'REJECTED' && t.rejected_reason && t.rejected_reason !== 'NONE' ? h('p', { class: 'error' }, `Reason: ${t.rejected_reason}`) : null),
          h('span', { class: `badge ${cls}` }, label),
          h('button', { type: 'button', class: 'btn small danger', onclick: () => this.deleteTemplate(t.name) }, 'Delete'));
      }));
    } catch (e) { ul.replaceChildren(h('li', { class: 'error' }, errText(e))); }
  },
  templateVars() {
    return [...new Set([...$('#tpl-form').elements.body.value.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  },
  renderExamples() {
    const box = $('#tpl-examples');
    const old = Object.fromEntries($$('input', box).map(i => [i.dataset.n, i.value]));
    box.replaceChildren(...this.templateVars().map(n => h('label', {}, `Example for {{${n}}}`,
      h('input', { 'data-n': n, value: old[n] || '', required: true, placeholder: n === 1 ? 'e.g. Asha' : 'example' }))));
  },
  addVariable() {
    const ta = $('#tpl-form').elements.body;
    const next = Math.max(0, ...this.templateVars()) + 1;
    const pos = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, pos) + `{{${next}}}` + ta.value.slice(ta.selectionEnd ?? pos);
    ta.focus();
    this.renderExamples();
  },
  async createTemplate(e) {
    e.preventDefault();
    const f = e.target, v = Object.fromEntries(new FormData(f));
    const examples = this.templateVars().map(n => $(`#tpl-examples input[data-n="${n}"]`)?.value || '');
    showError($('#tpl-error'), null);
    try {
      await busy(f.querySelector('.primary'), 'Sending to Meta…', () => api('POST', '/api/settings/templates', { ...v, examples }));
      toast('Template sent to Meta for approval');
      f.reset(); f.elements.language.value = 'en'; this.renderExamples();
      this.loadTemplates();
    } catch (err) { showError($('#tpl-error'), err); }
  },
  async deleteTemplate(name) {
    if (!confirm(`Delete the template "${name}" in all languages? This cannot be undone.`)) return;
    try { await api('DELETE', `/api/settings/templates/${encodeURIComponent(name)}`); toast('Template deleted'); this.loadTemplates(); }
    catch (e) { toast(errText(e), true); }
  },

  // ---------- Quick replies ----------
  async loadQuick() {
    const items = await api('GET', '/api/quick-replies');
    const ul = $('#qr-items');
    if (!items.length) return ul.replaceChildren(h('li', { class: 'muted' }, 'No quick replies yet.'));
    ul.replaceChildren(...items.map(q => h('li', {},
      h('div', { class: 'grow' }, h('b', {}, '/' + q.title), h('p', {}, q.body)),
      h('button', { type: 'button', class: 'btn small', onclick: () => this.editQuick(q) }, 'Edit'),
      h('button', { type: 'button', class: 'btn small danger', onclick: () => this.deleteQuick(q) }, 'Delete'))));
  },
  editQuick(q) {
    const f = $('#qr-form');
    f.elements.id.value = q?.id || ''; f.elements.title.value = q?.title || ''; f.elements.body.value = q?.body || '';
    $('#qr-form-title').textContent = q ? 'Edit quick reply' : 'Add a quick reply';
    $('#qr-cancel').hidden = !q;
    showError($('#qr-error'), null);
    if (q) f.elements.title.focus();
  },
  async saveQuick(e) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    try {
      await api(v.id ? 'PUT' : 'POST', v.id ? `/api/quick-replies/${v.id}` : '/api/quick-replies', { title: v.title, body: v.body });
      toast('Quick reply saved');
      this.editQuick(null);
      this.loadQuick();
    } catch (err) { showError($('#qr-error'), err); }
  },
  async deleteQuick(q) {
    if (!confirm(`Delete the quick reply "/${q.title}"?`)) return;
    await api('DELETE', `/api/quick-replies/${q.id}`);
    this.loadQuick();
  },

  // ---------- Auto-replies ----------
  async loadAuto() {
    const a = await api('GET', '/api/settings/auto-replies');
    const f = $('#ar-form');
    f.elements.welcomeEnabled.checked = a.welcome.enabled; f.elements.welcomeText.value = a.welcome.text;
    f.elements.awayEnabled.checked = a.away.enabled; f.elements.awayText.value = a.away.text;
    for (const c of f.elements.days) c.checked = a.away.days.includes(Number(c.value));
    f.elements.start.value = a.away.start; f.elements.end.value = a.away.end; f.elements.timezone.value = a.away.timezone;
    const dl = $('#tz-list');
    if (!dl.children.length && Intl.supportedValuesOf) dl.append(...Intl.supportedValuesOf('timeZone').map(z => h('option', { value: z })));
    showError($('#ar-error'), null);
  },
  async saveAuto(e) {
    e.preventDefault();
    const f = e.target;
    try {
      await api('PUT', '/api/settings/auto-replies', {
        welcome: { enabled: f.elements.welcomeEnabled.checked, text: f.elements.welcomeText.value },
        away: {
          enabled: f.elements.awayEnabled.checked, text: f.elements.awayText.value, timezone: f.elements.timezone.value.trim(),
          days: [...f.elements.days].filter(c => c.checked).map(c => Number(c.value)), start: f.elements.start.value, end: f.elements.end.value,
        },
      });
      showError($('#ar-error'), null);
      toast('Auto-replies saved');
    } catch (err) { showError($('#ar-error'), err); }
  },

  // ---------- Chats & security ----------
  async renderSecurity() {
    $('#pref-read').checked = !!this.data.preferences?.sendReadReceipts;
    $('#pref-preview').checked = this.data.preferences?.pushPreview !== false;
    this.renderInstall();
    const state = await Push.state();
    const text = {
      'ios-install': 'On iPhone and iPad, notifications work in the installed app (iOS 16.4 or newer). First add this app to your Home Screen: tap Share, then "Add to Home Screen". Open it from the Home Screen and come back here.',
      insecure: 'Notifications need a secure https address. Open the app through your public https address (Settings → Receive messages), not an http:// address.',
      unsupported: "This browser can't show notifications. Try Chrome, Edge, Firefox or Safari.",
      on: '🔔 Notifications are on for this device.',
      denied: 'Notifications are blocked for this app. Allow them in your browser or phone settings (site settings → Notifications), then reload.',
      off: 'Get a notification for every new message, even when the app is closed.',
    }[state];
    $('#push-state').textContent = text;
    $('#push-on').hidden = state !== 'off';
    $('#push-test').hidden = $('#push-off').hidden = state !== 'on';
    this.loadDevices();
    this.loadUsers();
  },
  async loadUsers() {
    const ul = $('#users-list');
    try {
      const { me, owner, list } = await api('GET', '/api/users');
      $('#users-help').textContent = owner
        ? `You are logged in as ${me}. You own this site, so you see every account here. Each account only sees its own WhatsApp number and chats.`
        : `You are logged in as ${me}. Your WhatsApp connection and chats are only visible to you.`;
      ul.hidden = !owner;
      ul.replaceChildren(...list.map(u => h('li', {},
        h('div', { class: 'grow' }, h('b', {}, u.username), h('p', {}, u.owner ? 'Owner of this site' : `Signed up ${new Date(u.created_at).toLocaleDateString()}`)),
        u.owner ? null : h('button', { type: 'button', class: 'btn small danger', onclick: () => this.removeUser(u.username) }, 'Delete'))));
    } catch (e) { ul.replaceChildren(h('li', { class: 'error' }, errText(e))); }
  },
  async removeUser(username) {
    if (!confirm(`Delete the account "${username}" with all its chats and settings? This can't be undone.`)) return;
    await api('DELETE', `/api/users/${encodeURIComponent(username)}`).catch(e => toast(errText(e), true));
    this.loadUsers();
  },
  async loadDevices() {
    const ul = $('#push-devices');
    try {
      const { list } = await api('GET', '/api/push');
      if (!list.length) return ul.replaceChildren(h('li', { class: 'muted' }, 'No devices yet.'));
      ul.replaceChildren(...list.map(d => h('li', {},
        h('div', { class: 'grow' }, h('b', {}, d.device || 'Device'), h('p', {}, `Since ${new Date(d.since).toLocaleDateString()}`)),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => this.removeDevice(d) }, 'Remove'))));
    } catch (e) { ul.replaceChildren(h('li', { class: 'error' }, errText(e))); }
  },
  async removeDevice(d) {
    if (!confirm(`Stop notifications to "${d.device}"? Use this for a lost or old phone.`)) return;
    await api('POST', '/api/push/remove', { id: d.id }).catch(e => toast(errText(e), true));
    this.renderSecurity();
  },
  renderInstall() {
    const i = installHelp();
    $('#install-help').textContent = i.text;
    $('#install-btn').hidden = !i.button;
  },

  // ---------- Branding ----------
  async loadBranding() {
    Object.assign(brand, await api('GET', '/api/branding'));
    const f = $('#brand-form');
    f.elements.appName.value = brand.appName;
    f.elements.accent.value = brand.accent;
    showError($('#brand-error'), null);
    this.previewBranding();
  },
  formBranding() {
    const f = $('#brand-form');
    return { appName: f.elements.appName.value.trim() || brand.appName, accent: f.elements.accent.value.toLowerCase() };
  },
  previewBranding() {
    const b = this.formBranding();
    applyBranding(b);
    $('#brand-name-preview').textContent = b.appName;
    for (const s of $$('#swatches [data-color]')) s.setAttribute('aria-pressed', String(s.dataset.color === b.accent));
  },
  revertBranding() { applyBranding(brand); },
  async saveBranding(e) {
    e.preventDefault();
    const f = e.target;
    try {
      Object.assign(brand, await api('PUT', '/api/branding', { appName: f.elements.appName.value, accent: f.elements.accent.value }));
      applyBranding(brand);
      showError($('#brand-error'), null);
      toast('Branding saved');
    } catch (err) { showError($('#brand-error'), err); }
  },
  async changePassword(e) {
    e.preventDefault();
    const f = e.target, v = Object.fromEntries(new FormData(f));
    if (v.next !== v.next2) return showError($('#pw-error'), new Error('The two new passwords are not the same.'));
    try {
      await api('POST', '/api/settings/password', { current: v.current, next: v.next });
      f.reset(); showError($('#pw-error'), null);
      toast('Password changed. Your other devices were logged out.');
    } catch (err) { showError($('#pw-error'), err); }
  },
};

// ---------- Wiring ----------
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) Settings.select(b.dataset.tab); });
$('#cred-form').addEventListener('submit', e => Settings.saveCredentials(e));
$('#cred-edit').addEventListener('click', () => Settings.unlock());
$('#cred-cancel').addEventListener('click', async () => { Settings.data = await api('POST', '/api/settings/lock'); Settings.renderConnection(); });
$('#unlock-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    Settings.data = await api('POST', '/api/settings/unlock', { password: $('#unlock-pw').value });
    $('#unlock-dialog').close();
    Settings.renderConnection();
    $('#cred-form').elements.token.focus();
  } catch (err) { showError($('#unlock-error'), err); }
});
$('#register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  showError($('#register-error'), null);
  try {
    await busy(f.querySelector('button'), 'Registering…', () => api('POST', '/api/settings/register', { pin: f.elements.pin.value.trim() }));
    f.reset(); toast('Phone number registered');
  } catch (err) { showError($('#register-error'), err); }
});
$('#wh-connect').addEventListener('click', e => Settings.connectWebhook(e.currentTarget));
$('#wh-check').addEventListener('click', e => Settings.checkWebhook(e.currentTarget));
for (const b of $$('[data-copy]')) b.addEventListener('click', () => copyText($('#' + b.dataset.copy).textContent));
$('#bp-form').addEventListener('submit', e => Settings.saveProfile(e));
$('#bp-form').elements.about.addEventListener('input', e => { $('#about-count').textContent = e.target.value.length; });
$('#tpl-language').append(...LANGUAGES.map(([v, l]) => h('option', { value: v }, `${l} (${v})`)));
$('#tpl-form').elements.body.addEventListener('input', () => Settings.renderExamples());
$('#tpl-addvar').addEventListener('click', () => Settings.addVariable());
$('#tpl-form').addEventListener('submit', e => Settings.createTemplate(e));
$('#tpl-refresh').addEventListener('click', () => Settings.loadTemplates());
$('#qr-form').addEventListener('submit', e => Settings.saveQuick(e));
$('#qr-cancel').addEventListener('click', () => Settings.editQuick(null));
$('#ar-form').addEventListener('submit', e => Settings.saveAuto(e));
$('#pref-read').addEventListener('change', async e => {
  try { Settings.data.preferences = await api('PUT', '/api/settings/preferences', { sendReadReceipts: e.target.checked }); toast('Saved'); }
  catch (err) { toast(errText(err), true); }
});
$('#pref-preview').addEventListener('change', async e => {
  try { Settings.data.preferences = await api('PUT', '/api/settings/preferences', { pushPreview: e.target.checked }); toast('Saved'); }
  catch (err) { toast(errText(err), true); }
});
$('#push-on').addEventListener('click', async e => {
  try { await Push.turnOn(); toast('Notifications are on for this device'); }
  catch (err) { toast(errText(err), true); }
  Settings.renderSecurity();
  e.target.blur();
});
$('#push-test').addEventListener('click', async e => {
  try { const r = await busy(e.currentTarget, 'Sending…', () => api('POST', '/api/push/test')); toast(`Test sent to ${r.sent} device(s)`); }
  catch (err) { toast(errText(err), true); }
  Settings.loadDevices();
});
$('#push-off').addEventListener('click', async () => { await Push.turnOff(); toast('Notifications are off for this device'); Settings.renderSecurity(); });
$('#install-btn').addEventListener('click', promptInstall);

// Branding
const SWATCHES = ['#2563eb', '#0d9488', '#16a34a', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#334155'];
$('#swatches').prepend(...SWATCHES.map(c => {
  const b = h('button', { type: 'button', class: 'swatch', 'data-color': c, title: c, 'aria-label': `Colour ${c}`, 'aria-pressed': 'false',
    onclick: () => { $('#brand-form').elements.accent.value = c; Settings.previewBranding(); } });
  b.style.background = c;
  return b;
}));
$('#brand-form').addEventListener('input', () => Settings.previewBranding());
$('#brand-form').addEventListener('submit', e => Settings.saveBranding(e));
$('#brand-reset').addEventListener('click', () => Settings.loadBranding());

/** Web Push for this device. */
const Push = {
  supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  async subscription() {
    if (!this.supported() || !isSecureContext) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  },
  async state() {
    if (isIOS() && !isStandalone()) return 'ios-install';
    if (!isSecureContext) return 'insecure';
    if (!this.supported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission === 'granted' && await this.subscription()) return 'on';
    if (!this.key) api('GET', '/api/push').then(r => { this.key = r.publicKey; }).catch(() => {}); // ready before the tap
    return 'off';
  },
  async turnOn() {
    // Ask first, directly inside the tap: iOS only allows the prompt from a user gesture
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed.');
    if (!this.key) this.key = (await api('GET', '/api/push')).publicKey;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(this.key) });
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), device: deviceName() });
  },
  async turnOff() {
    const sub = await this.subscription().catch(() => null);
    if (!sub) return;
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  },
};
$('#pw-form').addEventListener('submit', e => Settings.changePassword(e));
