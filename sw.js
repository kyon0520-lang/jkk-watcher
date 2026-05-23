const CACHE_NAME = 'jkk-watcher-v1';
const urlsToCache = [];

// インストール時
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('キャッシュをオープン');
        return cache.addAll(urlsToCache);
      })
  );
});

// フェッチ時（オフライン対応）
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // キャッシュがあればそれを返す
        if (response) {
          return response;
        }
        return fetch(event.request);
      }
    )
  );
});

// プッシュ通知受信時
self.addEventListener('push', event => {
  const options = {
    body: event.data ? event.data.text() : '新着物件があります',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'jkk-notification',
    requireInteraction: true
  };

  event.waitUntil(
    self.registration.showNotification('🏠 JKK新着物件', options)
  );
});

// 通知クリック時
self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  event.waitUntil(
    clients.openWindow('/')
  );
});

// Service Worker更新時
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
