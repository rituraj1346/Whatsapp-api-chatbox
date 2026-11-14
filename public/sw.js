'use strict';
// Service worker: push notifications only. It caches NOTHING, so installed apps always load the latest version.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    try {
      if (d.unread > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(d.unread);
      else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
    } catch { /* badges are optional */ }
    await self.registration.showNotification(d.title || 'New message', {
      body: d.body || '', tag: d.tag || d.waId || 'msg', renotify: true,
      icon: '/icons/192.png', badge: '/icons/192.png', data: { waId: d.waId || null },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const waId = e.notification.data && e.notification.data.waId;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      await win.focus();
      if (waId) win.postMessage({ type: 'openChat', waId });
      return;
    }
    await self.clients.openWindow(waId ? `/#chat=${encodeURIComponent(waId)}` : '/');
  })());
});

self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const old = e.oldSubscription;
    const sub = e.newSubscription || await self.registration.pushManager.subscribe(old.options);
    const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (old) await post('/api/push/unsubscribe', { endpoint: old.endpoint });
    const ua = self.navigator.userAgent;
    const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
    await post('/api/push/subscribe', { subscription: sub.toJSON(), device });
  })());
});
