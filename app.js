const SUPABASE_URL = 'https://svvdhrqhkryhityqfrwc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2dmRocnFoa3J5aGl0eXFmcndjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MTI5MDUsImV4cCI6MjEwNDI4ODkwNX0.vnBB3wXbgmVQr_bH6SfvRA5Dg5_4_M58bofBWcnVU5A';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let activeChat = null; // { type: 'user' | 'group', targetId: 'uuid', name: 'string', avatar: 'string' }
let peer = null;
let activeCall = null;
let incomingCallObj = null;
let dataConnection = null;
let groupMembers = [];
let replyToMessage = null;
let mediaRecorder = null;
let audioChunks = [];
let recordedAudioBlob = null;
let recordedAudioUrl = null;
let callTimerInterval = null;
let callSeconds = 0;

let messageRealtimeChannel = null;
let customChatSounds = JSON.parse(localStorage.getItem('custom_chat_sounds') || '{}');

// Service Worker 註冊
let swRegistration = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    swRegistration = reg;
  }).catch(err => console.log('Service Worker 註冊失敗:', err));
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  requestNotificationPermission();
  const savedUser = localStorage.getItem('app_user_session');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    document.getElementById('auth-screen').classList.add('hidden');
    initApp();
  }
});

async function handleAuth(type) {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value.trim();
  if (!username || !password) return alert('請填寫帳號與密碼');

  if (type === 'register') {
    const { data: existingUser } = await supabaseClient.from('profiles').select('id').eq('username', username).maybeSingle();
    if (existingUser) return alert('帳號已被註冊');

    const { error } = await supabaseClient.from('profiles').insert([{ username, password }]);
    if (error) return alert('註冊失敗：' + error.message);
    alert('註冊成功！');
  } else {
    const { data, error } = await supabaseClient.from('profiles').select('*').eq('username', username).eq('password', password).maybeSingle();
    if (error || !data) return alert('帳號或密碼錯誤');
    currentUser = data;
    localStorage.setItem('app_user_session', JSON.stringify(data));
    document.getElementById('auth-screen').classList.add('hidden');
    initApp();
  }
}

function logout() {
  localStorage.removeItem('app_user_session');
  location.reload();
}

function initApp() {
  document.getElementById('my-username').innerText = currentUser.username;
  document.getElementById('my-avatar').src = currentUser.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';
  document.getElementById('settings-avatar-preview').src = currentUser.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';

  peer = new Peer(currentUser.id);

  // 監聽來電
  peer.on('call', async (call) => {
    incomingCallObj = call;
    playNotificationSound('call', call.peer);
    triggerSystemNotification('系統通知', '您有新的來電邀請');

    // 取得對方資料
    const { data: callerProfile } = await supabaseClient.from('profiles').select('username, avatar_url').eq('id', call.peer).single();
    showIncomingCallModal(call.peer, callerProfile?.username || '未知使用者', callerProfile?.avatar_url);
  });

  peer.on('connection', (conn) => {
    dataConnection = conn;
    conn.on('data', (data) => {
      if (data === 'END_CALL') closeCallUI();
    });
  });

  loadFriendsAndRequests();
  loadChatsList();
  loadBlockedUsers();
  subscribeRealtime();
}

function triggerSystemNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    if (swRegistration && swRegistration.active) {
      swRegistration.showNotification(title, { body: body, icon: '/favicon.ico', requireInteraction: true });
    } else {
      const notif = new Notification(title, { body: body, icon: '/favicon.ico', requireInteraction: true });
      notif.onclick = () => window.focus();
    }
  }
}

// 接收來電彈窗
function showIncomingCallModal(peerId, callerName, callerAvatar) {
  const avatar = callerAvatar || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';
  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <div class="flex flex-col items-center py-4">
      <img src="${avatar}" class="w-16 h-16 rounded-full object-cover mb-2 border-2 border-indigo-500 animate-pulse">
      <h3 class="text-base font-bold mb-1">${callerName}</h3>
      <p class="text-xs text-slate-400 mb-6">邀請您進行通話...</p>
      <div class="flex gap-4 w-full">
        <button onclick="rejectIncomingCall('${peerId}')" class="flex-1 bg-red-600 py-2.5 rounded-lg text-sm font-bold hover:bg-red-700">📵 拒絕</button>
        <button onclick="acceptIncomingCall('${callerName}', '${avatar}')" class="flex-1 bg-green-600 py-2.5 rounded-lg text-sm font-bold hover:bg-green-700">📞 接聽</button>
      </div>
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

async function acceptIncomingCall(targetName, targetAvatar) {
  closeModal();
  if (!incomingCallObj) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    incomingCallObj.answer(stream);
    setupCallUI(targetName, targetAvatar);
    bindCallStream(incomingCallObj, stream);
  } catch (err) {
    alert('無法取得麥克風權限：' + err.message);
  }
}

function rejectIncomingCall(peerId) {
  closeModal();
  if (incomingCallObj) {
    recordCallMessage('📵 未接來電', peerId);
    incomingCallObj.close();
    incomingCallObj = null;
  }
}

function switchTab(tab) {
  ['friends', 'chats', 'settings'].forEach(t => {
    document.getElementById(`page-${t}`).classList.add('hidden');
    document.getElementById(`tab-${t}`).className = "flex-1 py-3 text-center text-xs font-bold text-slate-400";
  });
  document.getElementById(`page-${tab}`).classList.remove('hidden');
  document.getElementById(`tab-${tab}`).className = "flex-1 py-3 text-center text-xs font-bold border-b-2 border-indigo-500 text-indigo-400";
  if (tab === 'settings') loadBlockedUsers();
}

function toggleMoreMenu() {
  document.getElementById('chat-more-menu').classList.toggle('hidden');
}

async function loadFriendsAndRequests() {
  const { data: requests } = await supabaseClient.from('friendships')
    .select('id, user_id, profiles!friendships_user_id_fkey(username, avatar_url)')
    .eq('friend_id', currentUser.id).eq('status', 'pending');

  const reqContainer = document.getElementById('friend-requests-container');
  reqContainer.innerHTML = requests?.length ? '' : '<div class="text-xs text-slate-500">無待處理邀請</div>';
  requests?.forEach(r => {
    reqContainer.innerHTML += `
      <div class="p-2 bg-slate-800 rounded flex justify-between items-center mb-1 text-xs">
        <span>${r.profiles.username} 請求加好友</span>
        <div class="flex gap-1">
          <button onclick="respondFriendRequest('${r.id}', '${r.user_id}', 'accepted')" class="bg-green-600 px-2 py-0.5 rounded">接受</button>
          <button onclick="respondFriendRequest('${r.id}', '${r.user_id}', 'rejected')" class="bg-red-600 px-2 py-0.5 rounded">拒絕</button>
        </div>
      </div>`;
  });

  const { data: friends } = await supabaseClient.from('friendships')
    .select('id, friend_id, profiles!friendships_friend_id_fkey(id, username, avatar_url)')
    .eq('user_id', currentUser.id).eq('status', 'accepted');

  const friendsContainer = document.getElementById('friends-container');
  friendsContainer.innerHTML = friends?.length ? '' : '<div class="text-xs text-slate-500">尚無好友</div>';
  friends?.forEach(f => {
    const u = f.profiles;
    friendsContainer.innerHTML += `
      <div class="p-3 border-b border-slate-800 flex items-center justify-between hover:bg-slate-800 cursor-pointer" onclick="openFriendMenu('${u.id}', '${u.username}', '${u.avatar_url || ''}', '${f.id}')">
        <div class="flex items-center gap-2">
          <img src="${u.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
          <span class="text-sm font-bold">${u.username}</span>
        </div>
        <span class="text-xs text-indigo-400 font-bold">操作 ▸</span>
      </div>`;
  });
}

function openFriendMenu(friendId, username, avatarUrl, friendshipId) {
  const avatar = avatarUrl || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';
  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-base font-bold mb-4">${username}</h3>
    <div class="flex flex-col gap-2 w-full">
      <button onclick="closeModal(); openChat('user', '${friendId}', '${username}', '${avatar}')" class="bg-indigo-600 py-2.5 rounded text-sm font-bold">💬 開啟對話框</button>
      <button onclick="closeModal(); triggerDirectCall('${friendId}', '${username}', '${avatar}', false)" class="bg-green-600 py-2 rounded text-sm font-bold">📞 語音通話</button>
      <button onclick="closeModal(); triggerDirectCall('${friendId}', '${username}', '${avatar}', true)" class="bg-blue-600 py-2 rounded text-sm font-bold">📹 視訊通話</button>
      <button onclick="closeModal(); blockUser('${friendId}')" class="bg-slate-700 hover:bg-red-600 py-2 rounded text-sm">封鎖使用者</button>
      <button onclick="closeModal(); deleteFriend('${friendshipId}', '${friendId}')" class="bg-slate-700 hover:bg-red-800 py-2 rounded text-sm text-red-400">刪除好友</button>
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

async function deleteFriend(friendshipId, targetUserId) {
  if (!confirm('確定要刪除好友嗎？')) return;
  await supabaseClient.from('friendships').delete().or(`and(user_id.eq.${currentUser.id},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${currentUser.id})`);
  alert('已刪除好友');
  loadFriendsAndRequests();
  loadChatsList();
}

async function blockUser(targetUserId) {
  if (!confirm('確定要封鎖此使用者嗎？')) return;
  await supabaseClient.from('friendships').delete().or(`and(user_id.eq.${currentUser.id},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${currentUser.id})`);
  await supabaseClient.from('friendships').insert([{ user_id: currentUser.id, friend_id: targetUserId, status: 'blocked' }]);
  alert('已封鎖該使用者！');
  loadFriendsAndRequests();
  loadChatsList();
}

async function loadBlockedUsers() {
  const container = document.getElementById('blocked-users-container');
  const { data: blocked } = await supabaseClient.from('friendships')
    .select('id, friend_id, profiles!friendships_friend_id_fkey(username, avatar_url)')
    .eq('user_id', currentUser.id).eq('status', 'blocked');

  container.innerHTML = blocked?.length ? '' : '<div class="text-slate-500">無封鎖使用者</div>';
  blocked?.forEach(b => {
    container.innerHTML += `
      <div class="flex justify-between items-center bg-slate-700 p-2 rounded">
        <span>${b.profiles?.username || '未知使用者'}</span>
        <button onclick="unblockUser('${b.id}')" class="bg-indigo-600 px-2 py-1 rounded text-xs">解除封鎖</button>
      </div>`;
  });
}

async function unblockUser(friendshipId) {
  await supabaseClient.from('friendships').delete().eq('id', friendshipId);
  alert('已解除封鎖！');
  loadBlockedUsers();
  loadFriendsAndRequests();
}

async function respondFriendRequest(requestId, senderId, status) {
  if (status === 'accepted') {
    await supabaseClient.from('friendships').update({ status: 'accepted' }).eq('id', requestId);
    await supabaseClient.from('friendships').upsert([{ user_id: currentUser.id, friend_id: senderId, status: 'accepted' }]);
  } else {
    await supabaseClient.from('friendships').delete().eq('id', requestId);
  }
  loadFriendsAndRequests();
  loadChatsList();
}

function filterChats(keyword) {
  const term = keyword.toLowerCase();
  const items = document.querySelectorAll('#chats-container > div');
  items.forEach(item => {
    item.classList.toggle('hidden', !item.innerText.toLowerCase().includes(term));
  });
}

function searchInChat(keyword) {
  const term = keyword.toLowerCase();
  const msgs = document.querySelectorAll('#messages-box > div');
  msgs.forEach(m => {
    m.classList.toggle('hidden', !m.innerText.toLowerCase().includes(term));
  });
}

async function loadChatsList() {
  const container = document.getElementById('chats-container');
  container.innerHTML = '';

  const { data: friends } = await supabaseClient.from('friendships')
    .select('friend_id, profiles!friendships_friend_id_fkey(id, username, avatar_url)')
    .eq('user_id', currentUser.id).eq('status', 'accepted');

  const uniqueFriendsMap = new Map();
  friends?.forEach(f => { if (f.profiles) uniqueFriendsMap.set(f.profiles.id, f.profiles); });

  uniqueFriendsMap.forEach(u => {
    const avatar = u.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';
    container.innerHTML += `
      <div onclick="openChat('user', '${u.id}', '${u.username}', '${avatar}')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 flex justify-between items-center">
        <div class="flex items-center gap-2">
          <img src="${avatar}" class="w-8 h-8 rounded-full object-cover">
          <span class="text-sm font-bold">${u.username}</span>
        </div>
        <span class="text-xs text-indigo-400">開啟對話</span>
      </div>`;
  });

  const { data: groups } = await supabaseClient.from('group_members').select('groups(id, name)').eq('user_id', currentUser.id);
  groups?.forEach(g => {
    if (g.groups) {
      container.innerHTML += `
        <div onclick="openChat('group', '${g.groups.id}', '${g.groups.name}', '')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 text-indigo-300 font-bold flex justify-between items-center">
          <span>📢 ${g.groups.name}</span>
          <span class="text-xs text-slate-500">群組</span>
        </div>`;
    }
  });
}

// 修正第六點：只有在使用者點開並正在查看該聊天室時才更新已讀
async function markMessagesAsRead(targetId, type) {
  if (type === 'user') {
    await supabaseClient.from('messages').update({ is_read: true }).eq('sender_id', targetId).eq('receiver_id', currentUser.id).eq('is_read', false);
  } else {
    const { data: unreadMsgs } = await supabaseClient.from('messages').select('id').eq('group_id', targetId);
    if (unreadMsgs) {
      for (const m of unreadMsgs) {
        await supabaseClient.from('message_reads').upsert([{ message_id: m.id, user_id: currentUser.id }]);
      }
    }
  }
}

async function openChat(type, targetId, title, avatar = '') {
  activeChat = { type, targetId, name: title, avatar };
  
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');
  document.getElementById('chat-title').innerText = title;

  const inviteBtn = document.getElementById('menu-invite-btn');
  const membersBtn = document.getElementById('menu-members-btn');
  if (type === 'group') {
    inviteBtn.classList.remove('hidden');
    membersBtn.classList.remove('hidden');
  } else {
    inviteBtn.classList.add('hidden');
    membersBtn.classList.add('hidden');
  }

  const win = document.getElementById('chat-window');
  win.classList.add('chat-slide-open');
  win.classList.remove('translate-x-full');

  if (type === 'group') {
    supabaseClient.from('group_members').select('profiles(id, username)').eq('group_id', targetId)
      .then(({ data }) => { groupMembers = data?.map(d => d.profiles) || []; });
  }

  await markMessagesAsRead(targetId, type);
  loadMessages();
}

function closeChatWindow() {
  activeChat = null;
  const win = document.getElementById('chat-window');
  win.classList.remove('chat-slide-open');
  win.classList.add('translate-x-full');
}

async function loadMessages() {
  if (!activeChat) return;

  let msgs = [];
  if (activeChat.type === 'user') {
    const { data } = await supabaseClient.from('messages')
      .select('*, profiles:sender_id(username, avatar_url)')
      .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeChat.targetId}),and(sender_id.eq.${activeChat.targetId},receiver_id.eq.${currentUser.id})`)
      .order('created_at', { ascending: true });
    msgs = data || [];
  } else {
    const { data } = await supabaseClient.from('messages')
      .select('*, profiles:sender_id(username, avatar_url), message_reads(user_id)')
      .eq('group_id', activeChat.targetId)
      .order('created_at', { ascending: true });
    msgs = data || [];
  }

  const box = document.getElementById('messages-box');
  box.innerHTML = '';

  msgs.forEach(m => {
    const isMe = m.sender_id === currentUser.id;
    let contentHTML = m.content || '';

    if (m.file_url) {
      if (m.file_type?.startsWith('image/')) {
        contentHTML = `<img src="${m.file_url}" onclick="openLightbox('${m.file_url}')" class="max-w-[200px] rounded my-1 border border-slate-600 block cursor-zoom-in hover:opacity-90">`;
      } else if (m.file_type?.startsWith('audio/')) {
        contentHTML = `<audio controls src="${m.file_url}" class="w-48 my-1"></audio>`;
      } else {
        contentHTML = `<a href="${m.file_url}" target="_blank" class="underline text-blue-300">📁 下載檔案</a>`;
      }
    }

    let readStatusText = '';
    if (isMe) {
      if (activeChat.type === 'user') {
        readStatusText = m.is_read ? '<span class="text-[9px] text-emerald-400 block text-right">已讀</span>' : '<span class="text-[9px] text-slate-400 block text-right">未讀</span>';
      } else {
        const readCount = m.message_reads ? m.message_reads.length : 0;
        readStatusText = `<span onclick="showReadDetails('${m.id}')" class="text-[9px] text-emerald-400 block text-right cursor-pointer">已讀 ${readCount}</span>`;
      }
    }

    box.innerHTML += `
      <div class="flex gap-2 ${isMe ? 'flex-row-reverse' : ''}">
        <img src="${m.profiles?.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
        <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'}">
          <div class="max-w-xs p-3 rounded-lg ${isMe ? 'bg-indigo-600' : 'bg-slate-700'} relative group cursor-pointer" onclick="handleMessageOptions('${m.id}', '${m.content || ''}', ${isMe})">
            <div class="text-[10px] text-slate-300 mb-1">${m.profiles?.username || '使用者'}</div>
            <div class="text-sm break-words">${contentHTML}</div>
          </div>
          ${readStatusText}
        </div>
      </div>`;
  });
  box.scrollTop = box.scrollHeight;
}

async function showReadDetails(msgId) {
  const { data: reads } = await supabaseClient.from('message_reads').select('profiles(username)').eq('message_id', msgId);
  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3 class="text-sm font-bold mb-3">已讀成員</h3><div id="read-users-list" class="flex flex-col gap-1 text-xs"></div>';
  const list = document.getElementById('read-users-list');
  reads?.forEach(r => {
    list.innerHTML += `<div class="bg-slate-700 p-2 rounded">${r.profiles?.username}</div>`;
  });
  document.getElementById('modal').classList.remove('hidden');
}

function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('image-lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('image-lightbox').classList.add('hidden');
}

async function sendMessage(fileUrl = null, fileType = null) {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content && !fileUrl) return;

  if (activeChat.type === 'user') {
    const { data: relation } = await supabaseClient.from('friendships')
      .select('status')
      .eq('user_id', activeChat.targetId)
      .eq('friend_id', currentUser.id)
      .maybeSingle();

    if (!relation || relation.status !== 'accepted') {
      alert('無法發送訊息（可能被移除或封鎖）。');
      return;
    }
  }

  const payload = {
    sender_id: currentUser.id,
    content: replyToMessage ? `[回覆: ${replyToMessage}] ${content}` : content,
    file_url: fileUrl,
    file_type: fileType,
    is_read: false
  };

  if (activeChat.type === 'user') payload.receiver_id = activeChat.targetId;
  else payload.group_id = activeChat.targetId;

  const { error } = await supabaseClient.from('messages').insert([payload]);
  if (error) return alert('訊息發送失敗: ' + error.message);

  input.value = '';
  cancelReply();
  document.getElementById('mention-menu').classList.add('hidden');
  loadMessages();
}

// 修正第三點：記事本支援編輯與刪除
async function openNotesBoard() {
  if (!activeChat) return;
  const targetId = activeChat.targetId;

  let { data: notes } = await supabaseClient.from('notes')
    .select('*, profiles:author_id(username)')
    .or(`target_id.eq.${targetId},author_id.eq.${targetId}`)
    .order('created_at', { ascending: false });

  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-sm font-bold mb-2">對話記事本</h3>
    <textarea id="new-note-text" placeholder="新增記事內容..." class="w-full p-2 bg-slate-700 rounded text-xs text-white mb-2"></textarea>
    <button onclick="addNote('${targetId}')" class="bg-indigo-600 w-full py-1.5 rounded text-xs font-bold mb-3">發佈記事</button>
    <div id="notes-list" class="flex flex-col gap-2 max-h-48 overflow-y-auto text-left"></div>`;

  const list = document.getElementById('notes-list');
  if (!notes || notes.length === 0) {
    list.innerHTML = '<div class="text-slate-400 text-xs text-center py-2">目前沒有記事紀錄</div>';
  } else {
    notes.forEach(n => {
      const isAuthor = n.author_id === currentUser.id;
      list.innerHTML += `
        <div class="bg-slate-700 p-2 rounded text-xs border border-slate-600 flex justify-between items-start">
          <div class="flex-1 pr-2">
            <div class="text-[10px] text-indigo-400 font-bold mb-1">${n.profiles?.username || '使用者'}</div>
            <div class="text-slate-200 break-words" id="note-content-${n.id}">${n.content}</div>
          </div>
          ${isAuthor ? `
            <div class="flex gap-1 text-[10px]">
              <button onclick="editNote('${n.id}', '${n.content}')" class="bg-slate-600 hover:bg-slate-500 px-1.5 py-0.5 rounded text-blue-300">編輯</button>
              <button onclick="deleteNote('${n.id}')" class="bg-slate-600 hover:bg-red-600 px-1.5 py-0.5 rounded text-red-300">刪除</button>
            </div>
          ` : ''}
        </div>`;
    });
  }
  document.getElementById('modal').classList.remove('hidden');
}

async function addNote(targetId) {
  const text = document.getElementById('new-note-text').value.trim();
  if (!text) return alert('請輸入記事內容');
  await supabaseClient.from('notes').insert([{ target_id: targetId, author_id: currentUser.id, content: text }]);
  openNotesBoard();
}

async function editNote(noteId, oldContent) {
  const newContent = prompt('修改記事內容：', oldContent);
  if (!newContent || newContent.trim() === oldContent) return;
  await supabaseClient.from('notes').update({ content: newContent.trim() }).eq('id', noteId);
  openNotesBoard();
}

async function deleteNote(noteId) {
  if (!confirm('確定刪除此記事？')) return;
  await supabaseClient.from('notes').delete().eq('id', noteId);
  openNotesBoard();
}

// 修正第四點：錄音完成後先試聽再發送
async function toggleVoiceRecord() {
  const btn = document.getElementById('voice-btn');
  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        recordedAudioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        recordedAudioUrl = URL.createObjectURL(recordedAudioBlob);
        showVoicePreviewModal();
      };
      mediaRecorder.start();
      isRecording = true;
      btn.innerText = '⏹️ 停止';
      btn.classList.add('bg-red-600');
    } catch (err) {
      alert('無法開啟麥克風：' + err.message);
    }
  } else {
    mediaRecorder.stop();
    isRecording = false;
    btn.innerText = '🎙️ 語音';
    btn.classList.remove('bg-red-600');
  }
}

function showVoicePreviewModal() {
  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-sm font-bold mb-3">🎙️ 語音訊息試聽</h3>
    <audio controls src="${recordedAudioUrl}" class="w-full mb-4"></audio>
    <div class="flex gap-2 w-full">
      <button onclick="cancelVoiceSend()" class="flex-1 bg-slate-700 py-2 rounded text-xs font-bold">重錄 / 放棄</button>
      <button onclick="confirmSendVoice()" class="flex-1 bg-indigo-600 py-2 rounded text-xs font-bold">確定發送</button>
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

function cancelVoiceSend() {
  recordedAudioBlob = null;
  recordedAudioUrl = null;
  closeModal();
}

async function confirmSendVoice() {
  if (!recordedAudioBlob) return;
  closeModal();
  const filePath = `voice/${Date.now()}.webm`;
  await supabaseClient.storage.from('chat-attachments').upload(filePath, recordedAudioBlob);
  const { data: { publicUrl } } = supabaseClient.storage.from('chat-attachments').getPublicUrl(filePath);
  sendMessage(publicUrl, 'audio/webm');
  recordedAudioBlob = null;
  recordedAudioUrl = null;
}

// 修正第二點與第五點：完整通話流程（撥打中、接通、雙向聲音綁定、計時器）
function triggerDirectCall(targetUserId, username, avatarUrl, isVideo) {
  openChat('user', targetUserId, username, avatarUrl);
  startCall(targetUserId, username, avatarUrl, isVideo);
}

async function startCall(targetUserId, targetName, targetAvatar, isVideo = false) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
    setupCallUI(targetName, targetAvatar, '撥打中...');
    
    const call = peer.call(targetUserId, stream);
    dataConnection = peer.connect(targetUserId);
    bindCallStream(call, stream);
  } catch (err) {
    alert('無法啟用音視訊設備：' + err.message);
  }
}

function setupCallUI(targetName, targetAvatar, initialStatus = '通話中') {
  const avatar = targetAvatar || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';
  document.getElementById('video-container').classList.remove('hidden');
  
  const container = document.getElementById('video-container');
  container.innerHTML = `
    <div class="flex flex-col items-center justify-center h-full bg-slate-900 text-white relative p-4">
      <img src="${avatar}" class="w-24 h-24 rounded-full object-cover border-4 border-indigo-500 mb-4 animate-pulse">
      <h2 class="text-xl font-bold mb-1">${targetName}</h2>
      <p id="call-status-text" class="text-sm text-indigo-400 mb-6 font-mono">${initialStatus}</p>
      
      <audio id="remote-audio" autoplay></audio>
      <video id="remote-video" autoplay class="hidden w-full max-h-64 rounded mb-4"></video>
      <video id="local-video" autoplay muted class="hidden w-24 h-24 rounded border border-slate-600 absolute top-4 right-4"></video>
      
      <button onclick="endCall()" class="bg-red-600 hover:bg-red-700 px-6 py-3 rounded-full text-sm font-bold flex items-center gap-2">📵 結束通話</button>
    </div>`;
}

// 修正第五點：修正雙向 Audio Stream 聲音串接
function bindCallStream(call, localStream) {
  activeCall = call;

  call.on('stream', (remoteStream) => {
    // 當對方接通後，開始計時
    startCallTimer();
    const remoteAudio = document.getElementById('remote-audio');
    if (remoteAudio) {
      remoteAudio.srcObject = remoteStream;
      remoteAudio.play().catch(e => console.log('Audio play err:', e));
    }
  });

  call.on('close', () => closeCallUI());
}

function startCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callSeconds = 0;
  const statusTxt = document.getElementById('call-status-text');
  
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const secs = String(callSeconds % 60).padStart(2, '0');
    if (statusTxt) statusTxt.innerText = `通話中 (${mins}:${secs})`;
  }, 1000);
}

function endCall() {
  if (callSeconds > 0) {
    recordCallMessage(`📞 通話結束 (時間: ${callSeconds} 秒)`, activeChat?.targetId);
  } else {
    recordCallMessage('📵 未接來電', activeChat?.targetId);
  }

  if (dataConnection) dataConnection.send('END_CALL');
  if (activeCall) activeCall.close();
  closeCallUI();
}

function closeCallUI() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
  callSeconds = 0;

  const videoContainer = document.getElementById('video-container');
  if (videoContainer) videoContainer.classList.add('hidden');

  const remoteAudio = document.getElementById('remote-audio');
  if (remoteAudio?.srcObject) remoteAudio.srcObject.getTracks().forEach(t => t.stop());
}

// 即時監聽：點開聊天室才會顯示已讀
async function subscribeRealtime() {
  if (!currentUser) return;

  if (messageRealtimeChannel) {
    supabaseClient.removeChannel(messageRealtimeChannel);
    messageRealtimeChannel = null;
  }

  const { data: myGroups } = await supabaseClient.from('group_members').select('group_id').eq('user_id', currentUser.id);
  const groupIds = myGroups?.map(g => g.group_id) || [];

  messageRealtimeChannel = supabaseClient.channel('chat_realtime_channel')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
      const msg = payload.new;
      if (!msg) return;

      const isForMe = (msg.receiver_id === currentUser.id) || (msg.group_id && groupIds.includes(msg.group_id));
      if (!isForMe && msg.sender_id !== currentUser.id) return;

      // 只有在開啟該聊天室的情況下才顯示與更新
      if (activeChat && (activeChat.targetId === msg.sender_id || activeChat.targetId === msg.group_id)) {
        if (msg.sender_id !== currentUser.id) {
          await markMessagesAsRead(activeChat.targetId, activeChat.type);
        }
        loadMessages();
      }

      if (isForMe && msg.sender_id !== currentUser.id) {
        playNotificationSound('msg', msg.sender_id);
        triggerSystemNotification('系統通知', '您有新的通知');
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => {
      if (activeChat) loadMessages();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reads' }, () => {
      if (activeChat) loadMessages();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
      loadFriendsAndRequests();
      loadChatsList();
    })
    .subscribe();
}

async function recordCallMessage(text, targetUserId) {
  if (!targetUserId) return;
  await supabaseClient.from('messages').insert([{
    sender_id: currentUser.id,
    receiver_id: targetUserId,
    content: text
  }]);
  if (activeChat) loadMessages();
}

function handleMessageOptions(msgId, content, isMe) {
  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-sm font-bold mb-3">訊息操作</h3>
    <div class="flex flex-col gap-2 w-full">
      <button onclick="closeModal(); setReply('${content}')" class="bg-indigo-600 py-2 rounded text-xs font-bold">💬 指定回覆</button>
      ${isMe ? `<button onclick="closeModal(); deleteMessage('${msgId}')" class="bg-red-600 py-2 rounded text-xs font-bold">🗑️ 收回訊息</button>` : ''}
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

async function deleteMessage(msgId) {
  await supabaseClient.from('messages').delete().eq('id', msgId);
  loadMessages();
}

function setReply(text) {
  replyToMessage = text;
  document.getElementById('reply-text').innerText = `回覆: ${text}`;
  document.getElementById('reply-preview').classList.remove('hidden');
}

function cancelReply() {
  replyToMessage = null;
  document.getElementById('reply-preview').classList.add('hidden');
}

async function uploadFile(element) {
  const file = element.files[0];
  if (!file) return;

  const ext = file.name.substring(file.name.lastIndexOf('.')) || '';
  const safeFileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
  const filePath = `chat/${safeFileName}`;

  const { error } = await supabaseClient.storage.from('chat-attachments').upload(filePath, file);
  if (error) return alert('檔案上傳失敗：' + error.message);

  const { data: { publicUrl } } = supabaseClient.storage.from('chat-attachments').getPublicUrl(filePath);
  sendMessage(publicUrl, file.type);
}

async function uploadAvatar(element) {
  const file = element.files[0];
  if (!file) return;

  const ext = file.name.substring(file.name.lastIndexOf('.')) || '';
  const filePath = `avatars/${currentUser.id}_${Date.now()}${ext}`;

  await supabaseClient.storage.from('chat-attachments').upload(filePath, file);
  const { data: { publicUrl } } = supabaseClient.storage.from('chat-attachments').getPublicUrl(filePath);
  await supabaseClient.from('profiles').update({ avatar_url: publicUrl }).eq('id', currentUser.id);
  currentUser.avatar_url = publicUrl;
  localStorage.setItem('app_user_session', JSON.stringify(currentUser));
  document.getElementById('my-avatar').src = publicUrl;
  document.getElementById('settings-avatar-preview').src = publicUrl;
  alert('頭像已更新！');
}

function handleInputTyping(input) { handleInputMention(input); }

function handleInputMention(input) {
  const val = input.value;
  const menu = document.getElementById('mention-menu');
  if (activeChat?.type === 'group' && val.endsWith('@')) {
    menu.innerHTML = '<div onclick="addMention(\'所有人\')" class="p-2 hover:bg-slate-700 cursor-pointer text-xs font-bold text-indigo-400">@所有人</div>';
    groupMembers.forEach(m => {
      menu.innerHTML += `<div onclick="addMention('${m.username}')" class="p-2 hover:bg-slate-700 cursor-pointer text-xs">${m.username}</div>`;
    });
    menu.classList.remove('hidden');
  } else if (!val.includes('@')) {
    menu.classList.add('hidden');
  }
}

function addMention(name) {
  const input = document.getElementById('msg-input');
  input.value += `${name} `;
  document.getElementById('mention-menu').classList.add('hidden');
  input.focus();
}

function showQRCode() {
  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3>我的 QR Code</h3><canvas id="qrcode" class="mx-auto my-4"></canvas>';
  QRCode.toCanvas(document.getElementById('qrcode'), currentUser.id);
  document.getElementById('modal').classList.remove('hidden');
}

function startQRScan() {
  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3>掃描好友 QR Code</h3><div id="reader" class="w-full mt-4"></div>';
  document.getElementById('modal').classList.remove('hidden');
  const html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, async (friendId) => {
    html5QrCode.stop();
    closeModal();
    if (friendId === currentUser.id) return alert('不能新增自己！');
    await supabaseClient.from('friendships').insert([{ user_id: currentUser.id, friend_id: friendId, status: 'pending' }]);
    alert('邀請已發送！');
  });
}

function closeModal() { document.getElementById('modal').classList.add('hidden'); }

async function createGroupPrompt() {
  const groupName = prompt('請輸入群組名稱：');
  if (!groupName) return;
  const { data: grp } = await supabaseClient.from('groups').insert([{ name: groupName, created_by: currentUser.id }]).select().single();
  await supabaseClient.from('group_members').insert([{ group_id: grp.id, user_id: currentUser.id }]);
  alert('群組建立完成！');
  loadChatsList();
}

async function leaveOrDeleteChat() {
  if (!activeChat) return;
  if (confirm('確定要刪除對話/退出？')) {
    if (activeChat.type === 'group') {
      await supabaseClient.from('group_members').delete().eq('group_id', activeChat.targetId).eq('user_id', currentUser.id);
    } else {
      await supabaseClient.from('messages').delete().or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeChat.targetId}),and(sender_id.eq.${activeChat.targetId},receiver_id.eq.${currentUser.id})`);
    }
    closeChatWindow();
    loadChatsList();
  }
}