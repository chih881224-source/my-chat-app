// sw.js - 背景推播與通知處理器
self.addEventListener('push', function(event) {
  let data = { title: '您有新的通知', body: '您有新的通知' };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || '您有新的通知',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    vibrate: [200, 100, 200],
    requireInteraction: true, // 保持通知直到使用者點擊（適合來電/重要通知）
    data: { url: self.location.origin }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '您有新的通知', options)
  );
});

// 點擊通知自動切換/喚醒網頁
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