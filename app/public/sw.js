self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Content-less "tickle" push. The payload is intentionally empty (see
// server/push.php) — the server and the push service never learn what the
// agent said, only that *some* room had activity. We render one generic
// notification and let the tap open the channel list, where the live,
// end-to-end-decrypted messages already are.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // If a window is already open AND visible, the in-app live view is showing
    // the message — skip the redundant OS notification.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.some((c) => c.visibilityState === 'visible')) {
      return;
    }
    await self.registration.showNotification('hisohiso', {
      body: 'An agent needs you — tap to open.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'hisohiso-agent',
      renotify: true,
      data: { url: '/rooms' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/rooms';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) {
        await client.focus();
        // Nudge an already-open tab to the channel list if it's elsewhere.
        if ('navigate' in client && client.url && !client.url.endsWith(target)) {
          try {
            await client.navigate(target);
          } catch {
            /* navigate() can reject across history states — focus is enough */
          }
        }
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});
