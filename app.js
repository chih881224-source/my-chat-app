const SUPABASE_URL = 'https://svvdhrqhkryhityqfrwc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2dmRocnFoa3J5aGl0eXFmcndjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MTI5MDUsImV4cCI6MjEwNDI4ODkwNX0.vnBB3wXbgmVQr_bH6SfvRA5Dg5_4_M58bofBWcnVU5A';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let activeChat = null;
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
let isRecording = false;
let messageRealtimeChannel = null;
let swRegistration = null;

// 註冊 Service Worker 並請求 Web Push 權限 (修復問題1)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      swRegistration = reg;
      console.log('Service Worker 註冊成功:', reg);
    }).catch(err => console.log('Service Worker 註冊失敗:', err));
  });
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted' && swRegistration) {
        subscribeUserToPush();
      }
    });
  }
}

async function subscribeUserToPush() {
  if (!swRegistration || !currentUser) return;
  try {
    const subscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: null
    }).catch(() => null);

    if (subscription) {
      await supabaseClient.from('push_subscriptions').upsert([{
        user_id: currentUser.id,
        subscription: subscription.toJSON()
      }]);
    }
  } catch (e) {
    console.error('Push subscription error:', e);
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

  if (peer) peer.destroy();
  peer = new Peer(currentUser.id);

  // 修復問題4：加強過濾，確保真的有通話 stream 請求時才彈出接聽視窗
  peer.on('call', async (call) => {
    if (!call || !call.peer) return;
    
    incomingCallObj = call;
    playNotificationSound('call');
    triggerSystemNotification('來電通知', '您有新的通話請求');

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
      swRegistration.showNotification(title, {
        body: body,
        icon: 'https://api.dicebear.com/7.x/bottts/svg?seed=appicon',
        requireInteraction: true
      });
    } else {
      const notif = new Notification(title, { body: body, icon: 'https://api.dicebear.com/7.x/bottts/svg?seed=appicon' });
      notif.onclick = () => window.focus();
    }
  }
}

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

// 修復問題2：正確捕捉 Stream 與啟動通話介面
async function acceptIncomingCall(targetName, targetAvatar) {
  closeModal();
  if (!incomingCallObj) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => {
      return navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    });
    
    incomingCallObj.answer(stream);
    setupCallUI(targetName, targetAvatar, '通話中...');
    bindCallStream(incomingCallObj, stream);
  } catch (err) {
    alert('無法取得麥克風/鏡頭權限：' + err.message);
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
        <span>${r.profiles?.username || '使用者'} 請求加好友</span>
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
    if (u) {
      friendsContainer.innerHTML += `
        <div class="p-3 border-b border-slate-800 flex items-center justify-between hover:bg-slate-800 cursor-pointer" onclick="openFriendMenu('${u.id}', '${u.username}', '${u.avatar_url || ''}', '${f.id}')">
          <div class="flex items-center gap-2">
            <img src="${u.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
            <span class="text-sm font-bold">${u.username}</span>
          </div>
          <span class="text-xs text-indigo-400 font-bold">操作 ▸</span>
        </div>`;
    }
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

async function blockUser(targetId) {
  await supabaseClient.from('friendships').delete().or(`and(user_id.eq.${currentUser.id},friend_id.eq.${targetId}),and(user_id.eq.${targetId},friend_id.eq.${currentUser.id})`);
  await supabaseClient.from('blocks').upsert([{ user_id: currentUser.id, blocked_id: targetId }]);
  alert('已封鎖該使用者');
  loadFriendsAndRequests();
  loadChatsList();
}

async function deleteFriend(friendshipId, friendId) {
  if (!confirm('確定要刪除好友嗎？')) return;
  await supabaseClient.from('friendships').delete().or(`and(user_id.eq.${currentUser.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${currentUser.id})`);
  alert('已刪除好友');
  loadFriendsAndRequests();
  loadChatsList();
}

async function loadBlockedUsers() {
  const { data: blocks } = await supabaseClient.from('blocks').select('id, blocked_id, profiles!blocks_blocked_id_fkey(username)').eq('user_id', currentUser.id);
  const container = document.getElementById('blocked-users-container');
  container.innerHTML = blocks?.length ? '' : '<div class="text-slate-500">尚無封鎖名單</div>';
  blocks?.forEach(b => {
    container.innerHTML += `
      <div class="flex justify-between items-center bg-slate-700 p-2 rounded">
        <span>${b.profiles?.username || '使用者'}</span>
        <button onclick="unblockUser('${b.id}')" class="bg-slate-600 px-2 py-1 rounded text-[10px]">解除封鎖</button>
      </div>`;
  });
}

async function unblockUser(blockId) {
  await supabaseClient.from('blocks').delete().eq('id', blockId);
  loadBlockedUsers();
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

  const { data: groups } = await supabaseClient.from('group_members')
    .select('group_id, groups(id, name, avatar_url)')
    .eq('user_id', currentUser.id);

  groups?.forEach(g => {
    if (g.groups) {
      const avatar = g.groups.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=group';
      container.innerHTML += `
        <div onclick="openChat('group', '${g.groups.id}', '${g.groups.name}', '${avatar}')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 flex justify-between items-center">
          <div class="flex items-center gap-2">
            <img src="${avatar}" class="w-8 h-8 rounded-full object-cover">
            <span class="text-sm font-bold">[群組] ${g.groups.name}</span>
          </div>
          <span class="text-xs text-indigo-400">開啟對話</span>
        </div>`;
    }
  });
}

// 修復問題3：只在明確打開對應聊天室時將訊息標記為已讀
async function markMessagesAsRead(targetId, type) {
  if (!activeChat || activeChat.targetId !== targetId) return;

  if (type === 'user') {
    await supabaseClient.from('messages')
      .update({ is_read: true })
      .eq('sender_id', targetId)
      .eq('receiver_id', currentUser.id)
      .eq('is_read', false);
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

  if (type === 'group') {
    document.getElementById('menu-invite-btn').classList.remove('hidden');
    document.getElementById('menu-members-btn').classList.remove('hidden');
    loadGroupMembers(targetId);
  } else {
    document.getElementById('menu-invite-btn').classList.add('hidden');
    document.getElementById('menu-members-btn').classList.add('hidden');
  }

  const win = document.getElementById('chat-window');
  win.classList.add('chat-slide-open');
  win.classList.remove('translate-x-full');

  // 進入對話框時才進行已讀註記
  await markMessagesAsRead(targetId, type);
  loadMessages();
}

function closeChatWindow() {
  activeChat = null;
  const win = document.getElementById('chat-window');
  win.classList.remove('chat-slide-open');
  win.classList.add('translate-x-full');
}

async function loadGroupMembers(groupId) {
  const { data } = await supabaseClient.from('group_members')
    .select('profiles(id, username, avatar_url)')
    .eq('group_id', groupId);
  groupMembers = data?.map(d => d.profiles) || [];
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
      .select('*, profiles:sender_id(username, avatar_url)')
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
      readStatusText = m.is_read ? '<span class="text-[9px] text-emerald-400 block text-right">已讀</span>' : '<span class="text-[9px] text-slate-400 block text-right">未讀</span>';
    }

    box.innerHTML += `
      <div class="flex gap-2 ${isMe ? 'flex-row-reverse' : ''}">
        <img src="${m.profiles?.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
        <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'}">
          <div class="max-w-xs p-3 rounded-lg ${isMe ? 'bg-indigo-600' : 'bg-slate-700'} relative group">
            <div class="text-[10px] text-slate-300 mb-1">${m.profiles?.username || '使用者'}</div>
            <div class="text-sm break-words">${contentHTML}</div>
            <button onclick="setReply('${m.profiles?.username || ''}', '${m.content || '檔案'}')" class="text-[10px] text-slate-400 mt-1 hover:underline block">↩ 回覆</button>
          </div>
          ${readStatusText}
        </div>
      </div>`;
  });
  box.scrollTop = box.scrollHeight;
}

function setReply(username, content) {
  replyToMessage = content;
  document.getElementById('reply-text').innerText = `回覆 ${username}: ${content.substring(0, 15)}...`;
  document.getElementById('reply-preview').classList.remove('hidden');
}

function cancelReply() {
  replyToMessage = null;
  document.getElementById('reply-preview').classList.add('hidden');
}

function handleInputTyping(input) {
  const val = input.value;
  const mentionMenu = document.getElementById('mention-menu');
  if (activeChat?.type === 'group' && val.includes('@')) {
    const term = val.split('@').pop().toLowerCase();
    const matched = groupMembers.filter(m => m.username.toLowerCase().includes(term));
    if (matched.length) {
      mentionMenu.innerHTML = matched.map(m => `
        <div onclick="selectMention('${m.username}')" class="p-2 hover:bg-slate-700 cursor-pointer text-xs flex items-center gap-2">
          <img src="${m.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-4 h-4 rounded-full">
          <span>${m.username}</span>
        </div>`).join('');
      mentionMenu.classList.remove('hidden');
    } else mentionMenu.classList.add('hidden');
  } else mentionMenu.classList.add('hidden');
}

function selectMention(username) {
  const input = document.getElementById('msg-input');
  const parts = input.value.split('@');
  parts.pop();
  input.value = parts.join('@') + `@${username} `;
  document.getElementById('mention-menu').classList.add('hidden');
  input.focus();
}

async function sendMessage(fileUrl = null, fileType = null) {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content && !fileUrl) return;

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
  loadMessages();
}

async function uploadFile(input) {
  const file = input.files[0];
  if (!file) return;
  const filePath = `chat_files/${Date.now()}_${file.name}`;
  const { data, error } = await supabaseClient.storage.from('chat_bucket').upload(filePath, file);
  if (error) return alert('檔案上傳失敗: ' + error.message);
  
  const { data: publicUrlData } = supabaseClient.storage.from('chat_bucket').getPublicUrl(filePath);
  sendMessage(publicUrlData.publicUrl, file.type);
}

async function toggleVoiceRecord() {
  const btn = document.getElementById('voice-btn');
  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = async () => {
        recordedAudioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const filePath = `voice/${Date.now()}.webm`;
        await supabaseClient.storage.from('chat_bucket').upload(filePath, recordedAudioBlob);
        const { data } = supabaseClient.storage.from('chat_bucket').getPublicUrl(filePath);
        sendMessage(data.publicUrl, 'audio/webm');
      };
      mediaRecorder.start();
      isRecording = true;
      btn.innerText = '🛑 停止';
      btn.classList.add('bg-red-600');
    } catch (e) {
      alert('無法取得麥克風權限');
    }
  } else {
    mediaRecorder.stop();
    isRecording = false;
    btn.innerText = '🎙️ 語音';
    btn.classList.remove('bg-red-600');
  }
}

// 修復問題2：通話綁定與 MediaStream
function triggerDirectCall(targetUserId, username, avatarUrl, isVideo) {
  openChat('user', targetUserId, username, avatarUrl);
  startCall(isVideo);
}

async function startCall(isVideo = false) {
  if (!activeChat) return alert('請先選擇通話對象');
  const targetUserId = activeChat.targetId;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
    setupCallUI(activeChat.name, activeChat.avatar, '撥打中...');
    
    const call = peer.call(targetUserId, stream);
    dataConnection = peer.connect(targetUserId);
    bindCallStream(call, stream);
  } catch (err) {
    alert('無法啟用音視訊設備：' + err.message);
  }
}

function setupCallUI(targetName, targetAvatar, initialStatus = '撥打中...') {
  const avatar = targetAvatar || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';
  const container = document.getElementById('video-container');
  if (!container) return;

  container.classList.remove('hidden');
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

function bindCallStream(call, localStream) {
  activeCall = call;

  call.on('stream', (remoteStream) => {
    startCallTimer();
    const remoteAudio = document.getElementById('remote-audio');
    if (remoteAudio) {
      remoteAudio.srcObject = remoteStream;
      remoteAudio.play().catch(e => console.log('Audio play error:', e));
    }
  });

  call.on('close', () => closeCallUI());
  call.on('error', (err) => {
    alert('通話連線發生錯誤');
    closeCallUI();
  });
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
  if (videoContainer) {
    videoContainer.innerHTML = '';
    videoContainer.classList.add('hidden');
  }

  const remoteAudio = document.getElementById('remote-audio');
  if (remoteAudio?.srcObject) {
    remoteAudio.srcObject.getTracks().forEach(t => t.stop());
  }
}

// 修復問題1與問題3：Realtime 訊息狀態與背景推播
async function subscribeRealtime() {
  if (!currentUser) return;

  if (messageRealtimeChannel) {
    supabaseClient.removeChannel(messageRealtimeChannel);
  }

  messageRealtimeChannel = supabaseClient.channel('chat_realtime_channel')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
      const msg = payload.new;
      if (!msg) return;

      const isForMe = (msg.receiver_id === currentUser.id);
      
      // 修復問題3：只在打開當前聊天室時，才將訊息自動更新為已讀
      if (activeChat && activeChat.targetId === msg.sender_id) {
        await markMessagesAsRead(activeChat.targetId, activeChat.type);
        loadMessages();
      }

      // 修復問題1：當背景收到新訊息時觸發推播
      if (isForMe && msg.sender_id !== currentUser.id) {
        playNotificationSound('msg');
        triggerSystemNotification('新訊息通知', msg.content || '您收到了一個檔案');
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => {
      if (activeChat) loadMessages();
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

async function uploadAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  const filePath = `avatars/${currentUser.id}_${Date.now()}.png`;
  await supabaseClient.storage.from('chat_bucket').upload(filePath, file);
  const { data } = supabaseClient.storage.from('chat_bucket').getPublicUrl(filePath);
  
  await supabaseClient.from('profiles').update({ avatar_url: data.publicUrl }).eq('id', currentUser.id);
  currentUser.avatar_url = data.publicUrl;
  localStorage.setItem('app_user_session', JSON.stringify(currentUser));
  document.getElementById('my-avatar').src = data.publicUrl;
  document.getElementById('settings-avatar-preview').src = data.publicUrl;
  alert('頭像更新成功！');
}

function playNotificationSound(type) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  if (type === 'msg') {
    osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
    osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.1); // A5
  } else {
    osc.frequency.setValueAtTime(440, audioCtx.currentTime); // A4
    osc.frequency.setValueAtTime(554.37, audioCtx.currentTime + 0.2); // C#5
  }
  osc.start();
  osc.stop(audioCtx.currentTime + 0.3);
}

function playPreviewSound(val, type) { playNotificationSound(type); }

async function createGroupPrompt() {
  const name = prompt('請輸入群組名稱：');
  if (!name) return;
  const { data: group, error } = await supabaseClient.from('groups').insert([{ name, created_by: currentUser.id }]).select().single();
  if (error) return alert('建立群組失敗');
  
  await supabaseClient.from('group_members').insert([{ group_id: group.id, user_id: currentUser.id }]);
  alert('群組建立成功！');
  loadChatsList();
}

async function openNotesBoard() {
  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-base font-bold mb-2">📝 記事本</h3>
    <textarea id="note-input" class="w-full p-2 bg-slate-700 rounded text-xs text-white mb-2" placeholder="新增筆記..."></textarea>
    <button onclick="saveNote()" class="bg-indigo-600 px-4 py-1.5 rounded text-xs font-bold mb-4">發布筆記</button>
    <div id="notes-list" class="text-left max-h-40 overflow-y-auto flex flex-col gap-2"></div>`;
  document.getElementById('modal').classList.remove('hidden');
  loadNotes();
}

async function loadNotes() {
  if (!activeChat) return;
  const query = activeChat.type === 'user' ? 
    supabaseClient.from('notes').select('*').or(`and(user_id.eq.${currentUser.id},target_user_id.eq.${activeChat.targetId}),and(user_id.eq.${activeChat.targetId},target_user_id.eq.${currentUser.id})`) :
    supabaseClient.from('notes').select('*').eq('group_id', activeChat.targetId);

  const { data } = await query;
  const list = document.getElementById('notes-list');
  if (list) {
    list.innerHTML = data?.length ? '' : '<div class="text-xs text-slate-500">尚無記事本紀錄</div>';
    data?.forEach(n => {
      list.innerHTML += `<div class="bg-slate-700 p-2 rounded text-xs">${n.content}</div>`;
    });
  }
}

async function saveNote() {
  const input = document.getElementById('note-input');
  if (!input.value.trim()) return;
  const payload = { user_id: currentUser.id, content: input.value.trim() };
  if (activeChat.type === 'user') payload.target_user_id = activeChat.targetId;
  else payload.group_id = activeChat.targetId;

  await supabaseClient.from('notes').insert([payload]);
  input.value = '';
  loadNotes();
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

function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('image-lightbox').classList.remove('hidden');
}

function closeLightbox() { document.getElementById('image-lightbox').classList.add('hidden'); }
function closeModal() { document.getElementById('modal').classList.add('hidden'); }