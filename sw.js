// sw.js - 背景推播與通知處理器
self.addEventListener('push', function(event) {
  let data = { title: '您有新的通知', body: '您有新的通知', type: 'msg' };
  
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
    vibrate: data.type === 'call' ? [1000, 500, 1000, 500, 1000] : [200, 100, 200],
    tag: data.type === 'call' ? 'incoming-call' : 'message-notif',
    renotify: true,
    requireInteraction: data.type === 'call', // 來電持續顯示
    data: { url: self.location.origin, callData: data }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '極速 Chat 通知', options)
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