// DigiSmart ERP — Service Worker
// Enables offline support and PWA installation

const CACHE_NAME = 'digismart-erp-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/config.js',
  '/js/sidebar.js',
  '/manifest.json',
  '/parent/index.html',
  '/parent/dashboard.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// Install — cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate — remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', event => {
  // Skip non-GET and Supabase API calls (always need network for live data)
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('supabase.co')) return;
  if (event.request.url.includes('anthropic.com')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => {
        // Network failed — return from cache
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // Offline fallback page
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
      })
  );
});

// Push notifications — parent alerts from /api/push
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'DigiSmart ERP';
  const options = {
    body: data.body || 'New notification from school',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/badge-96.png',
    vibrate: [200, 100, 200],
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/parent/index.html' },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'close', title: 'Dismiss' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'open' || !event.action) {
    const url = event.notification.data?.url || '/parent/index.html';
    // If the parent app is already open, bring it to the front instead of a new window
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const open = list.find(c => c.url.includes('/parent/'));
        if (open) return open.focus();
        return clients.openWindow(url);
      })
    );
  }
});
