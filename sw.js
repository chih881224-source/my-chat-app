// sw.js - 背景推播與通知處理器

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// 背景訊息推播 (修復問題1：當APP關閉或在背景時觸發系統推播)
self.addEventListener('push', function(event) {
  let data = { title: '新訊息通知', body: '您收到了一則新訊息' };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || '您有新的通知',
    icon: 'https://api.dicebear.com/7.x/bottts/svg?seed=appicon',
    badge: 'https://api.dicebear.com/7.x/bottts/svg?seed=appicon',
    vibrate: [200, 100, 200],
    requireInteraction: true,
    data: { url: self.location.origin }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '您有新的通知', options)
  );
});

// 點擊通知開啓或喚醒 APP
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});