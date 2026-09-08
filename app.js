const SUPABASE_URL = 'https://svvdhrqhkryhityqfrwc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2dmRocnFoa3J5aGl0eXFmcndjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MTI5MDUsImV4cCI6MjEwNDI4ODkwNX0.vnBB3wXbgmVQr_bH6SfvRA5Dg5_4_M58bofBWcnVU5A';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let activeChat = null; // { type: 'user' | 'group', targetId: 'uuid' }
let peer = null;
let activeCall = null;
let dataConnection = null;
let groupMembers = [];
let replyToMessage = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let callStartTime = null;

let customChatSounds = JSON.parse(localStorage.getItem('custom_chat_sounds') || '{}');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    if ('Notification' in window && Notification.permission === 'granted') {
      reg.pushManager.getSubscription().then(sub => {
        if (sub && currentUser) {
          supabaseClient.from('push_subscriptions').upsert([{ user_id: currentUser.id, subscription_json: JSON.stringify(sub) }]);
        }
      });
    }
  });
}

if ('Notification' in window && Notification.permission !== 'granted') {
  Notification.requestPermission();
}

window.addEventListener('DOMContentLoaded', () => {
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

  peer.on('call', async (call) => {
    playNotificationSound('call', call.peer);
    if (confirm('收到通話邀請！是否接聽？')) {
      callStartTime = Date.now();
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      call.answer(stream);
      showVideoScreen(stream, call, false);
    } else {
      recordCallMessage('📵 未接來電', call.peer);
    }
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
  const menu = document.getElementById('chat-more-menu');
  menu.classList.toggle('hidden');
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
      <div class="p-3 border-b border-slate-800 flex items-center justify-between hover:bg-slate-800 cursor-pointer" onclick="openFriendMenu('${u.id}', '${u.username}', '${f.id}')">
        <div class="flex items-center gap-2">
          <img src="${u.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
          <span class="text-sm font-bold">${u.username}</span>
        </div>
        <span class="text-xs text-indigo-400 font-bold">操作 ▸</span>
      </div>`;
  });
}

function openFriendMenu(friendId, username, friendshipId) {
  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-base font-bold mb-4">${username}</h3>
    <div class="flex flex-col gap-2 w-full">
      <button onclick="closeModal(); openChat('user', '${friendId}', '${username}')" class="bg-indigo-600 py-2.5 rounded text-sm font-bold">💬 開啟對話框</button>
      <button onclick="closeModal(); triggerDirectCall('${friendId}', false)" class="bg-green-600 py-2 rounded text-sm font-bold">📞 語音通話</button>
      <button onclick="closeModal(); triggerDirectCall('${friendId}', true)" class="bg-blue-600 py-2 rounded text-sm font-bold">📹 視訊通話</button>
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
    const text = item.innerText.toLowerCase();
    item.classList.toggle('hidden', !text.includes(term));
  });
}

function searchInChat(keyword) {
  const term = keyword.toLowerCase();
  const msgs = document.querySelectorAll('#messages-box > div');
  msgs.forEach(m => {
    const text = m.innerText.toLowerCase();
    m.classList.toggle('hidden', !text.includes(term));
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
    container.innerHTML += `
      <div onclick="openChat('user', '${u.id}', '${u.username}')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 flex justify-between items-center">
        <div class="flex items-center gap-2">
          <img src="${u.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
          <span class="text-sm font-bold">${u.username}</span>
        </div>
        <span class="text-xs text-indigo-400">開啟對話</span>
      </div>`;
  });

  const { data: groups } = await supabaseClient.from('group_members').select('groups(id, name)').eq('user_id', currentUser.id);
  groups?.forEach(g => {
    if (g.groups) {
      container.innerHTML += `
        <div onclick="openChat('group', '${g.groups.id}', '${g.groups.name}')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 text-indigo-300 font-bold flex justify-between items-center">
          <span>📢 ${g.groups.name}</span>
          <span class="text-xs text-slate-500">群組</span>
        </div>`;
    }
  });
}

async function markMessagesAsRead(targetId, type) {
  if (type === 'user') {
    await supabaseClient.from('messages').update({ is_read: true }).eq('sender_id', targetId).eq('receiver_id', currentUser.id);
  } else {
    const { data: unreadMsgs } = await supabaseClient.from('messages').select('id').eq('group_id', targetId);
    if (unreadMsgs) {
      for (const m of unreadMsgs) {
        await supabaseClient.from('message_reads').upsert([{ message_id: m.id, user_id: currentUser.id }]);
      }
    }
  }
}

function openChat(type, targetId, title) {
  activeChat = { type, targetId };
  
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

  markMessagesAsRead(targetId, type);
  loadMessages();
}

function closeChatWindow() {
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

async function openGroupMembersModal() {
  if (activeChat?.type !== 'group') return;

  const { data: members } = await supabaseClient.from('group_members')
    .select('id, user_id, profiles(username, avatar_url)')
    .eq('group_id', activeChat.targetId);

  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3 class="text-sm font-bold mb-3">群組成員列表</h3><div id="group-member-list" class="flex flex-col gap-2 max-h-56 overflow-y-auto"></div>';

  const list = document.getElementById('group-member-list');
  members?.forEach(m => {
    const u = m.profiles;
    const isMe = u.username === currentUser.username;
    list.innerHTML += `
      <div class="flex justify-between items-center bg-slate-700 p-2 rounded text-xs">
        <div class="flex items-center gap-2">
          <img src="${u.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-6 h-6 rounded-full object-cover">
          <span>${u.username} ${isMe ? '(我)' : ''}</span>
        </div>
        ${!isMe ? `<button onclick="kickGroupMember('${m.id}')" class="bg-red-600 px-2 py-0.5 rounded text-[10px]">踢出</button>` : ''}
      </div>`;
  });
  document.getElementById('modal').classList.remove('hidden');
}

async function kickGroupMember(memberRecordId) {
  if (!confirm('確定要移出此成員？')) return;
  await supabaseClient.from('group_members').delete().eq('id', memberRecordId);
  alert('已移出成員！');
  openGroupMembersModal();
}

async function openInviteModal() {
  if (activeChat?.type !== 'group') return;
  const { data: friends } = await supabaseClient.from('friendships')
    .select('friend_id, profiles!friendships_friend_id_fkey(id, username)')
    .eq('user_id', currentUser.id).eq('status', 'accepted');

  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3 class="text-sm font-bold mb-3">邀請好友加入群組</h3><div id="invite-list" class="flex flex-col gap-2 max-h-48 overflow-y-auto"></div>';
  
  const list = document.getElementById('invite-list');
  friends?.forEach(f => {
    const u = f.profiles;
    list.innerHTML += `
      <div class="flex justify-between items-center bg-slate-700 p-2 rounded text-xs">
        <span>${u.username}</span>
        <button onclick="inviteToGroup('${u.id}')" class="bg-indigo-600 px-2 py-1 rounded">邀請</button>
      </div>`;
  });
  document.getElementById('modal').classList.remove('hidden');
}

async function inviteToGroup(targetUserId) {
  await supabaseClient.from('group_members').insert([{ group_id: activeChat.targetId, user_id: targetUserId }]);
  alert('已成功邀請！');
  closeModal();
}

async function openMediaGallery() {
  if (!activeChat) return;
  let query = supabaseClient.from('messages').select('file_url, file_type').not('file_url', 'is', null);
  
  if (activeChat.type === 'user') {
    query = query.or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeChat.targetId}),and(sender_id.eq.${activeChat.targetId},receiver_id.eq.${currentUser.id})`);
  } else {
    query = query.eq('group_id', activeChat.targetId);
  }

  const { data: mediaFiles } = await query;
  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3 class="text-sm font-bold mb-3">傳送過的媒體檔案 / 相簿</h3><div id="gallery-grid" class="grid grid-cols-3 gap-2 max-h-60 overflow-y-auto"></div>';
  
  const grid = document.getElementById('gallery-grid');
  mediaFiles?.forEach(m => {
    if (m.file_type?.startsWith('image/')) {
      grid.innerHTML += `<img src="${m.file_url}" onclick="openLightbox('${m.file_url}')" class="w-full h-16 object-cover rounded cursor-pointer border border-slate-600">`;
    }
  });
  document.getElementById('modal').classList.remove('hidden');
}

async function openNotesBoard() {
  if (!activeChat) return;
  const targetId = activeChat.targetId;

  const { data: notes } = await supabaseClient.from('notes').select('*, profiles(username)').eq('target_id', targetId).order('created_at', { ascending: false });

  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-sm font-bold mb-2">對話記事本</h3>
    <textarea id="new-note-text" placeholder="新增記事內容..." class="w-full p-2 bg-slate-700 rounded text-xs text-white mb-2"></textarea>
    <button onclick="addNote('${targetId}')" class="bg-indigo-600 w-full py-1.5 rounded text-xs font-bold mb-3">發佈記事</button>
    <div id="notes-list" class="flex flex-col gap-2 max-h-48 overflow-y-auto text-left"></div>`;

  const list = document.getElementById('notes-list');
  notes?.forEach(n => {
    list.innerHTML += `
      <div class="bg-slate-700 p-2 rounded text-xs border border-slate-600">
        <div class="text-[10px] text-indigo-400 font-bold mb-1">${n.profiles?.username || '使用者'}</div>
        <div>${n.content}</div>
      </div>`;
  });
  document.getElementById('modal').classList.remove('hidden');
}

async function addNote(targetId) {
  const text = document.getElementById('new-note-text').value.trim();
  if (!text) return;
  await supabaseClient.from('notes').insert([{ target_id: targetId, author_id: currentUser.id, content: text }]);
  openNotesBoard();
}

function openChatCustomSettings() {
  if (!activeChat) return;
  const targetId = activeChat.targetId;
  const currentSound = customChatSounds[targetId] || 'global';

  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-sm font-bold mb-3">聊天室獨立設定</h3>
    <div class="flex flex-col gap-3 w-full text-left">
      <div>
        <label class="block text-xs font-bold text-slate-400 mb-1">獨立專屬通知鈴聲 (選取即試聽)</label>
        <select id="chat-custom-sound" onchange="playAudioPreview(this.value)" class="w-full p-2 bg-slate-800 rounded border border-slate-700 text-xs">
          <option value="global" ${currentSound === 'global' ? 'selected' : ''}>套用全局設定</option>
          <option value="default" ${currentSound === 'default' ? 'selected' : ''}>預設清脆音</option>
          <option value="chime" ${currentSound === 'chime' ? 'selected' : ''}>和緩水滴聲</option>
          <option value="pop" ${currentSound === 'pop' ? 'selected' : ''}>輕快 POP 聲</option>
        </select>
      </div>
      <button onclick="saveChatCustomSound('${targetId}')" class="bg-indigo-600 py-2 rounded text-xs font-bold mt-2 text-center">儲存獨立設定</button>
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

function saveChatCustomSound(targetId) {
  const val = document.getElementById('chat-custom-sound').value;
  customChatSounds[targetId] = val;
  localStorage.setItem('custom_chat_sounds', JSON.stringify(customChatSounds));
  alert('獨立鈴聲已設定！');
  closeModal();
}

async function updateGlobalSound(field, value) {
  playAudioPreview(value);
  await supabaseClient.from('profiles').update({ [field]: value }).eq('id', currentUser.id);
}

function playAudioPreview(soundType) {
  if (soundType === 'global') return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  if (soundType === 'chime' || soundType === 'soft') osc.frequency.setValueAtTime(800, ctx.currentTime);
  else if (soundType === 'pop' || soundType === 'digital') osc.frequency.setValueAtTime(400, ctx.currentTime);
  else osc.frequency.setValueAtTime(600, ctx.currentTime);

  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.4);
  osc.stop(ctx.currentTime + 0.4);
}

function playNotificationSound(type, targetId = null) {
  let soundType = 'default';
  if (type === 'msg' && targetId && customChatSounds[targetId] && customChatSounds[targetId] !== 'global') {
    soundType = customChatSounds[targetId];
  } else {
    soundType = currentUser[type === 'msg' ? 'msg_sound' : 'call_sound'] || 'default';
  }
  playAudioPreview(soundType);
}

function subscribeRealtime() {
  supabaseClient.channel('public:messages')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (payload) => {
      const msg = payload.new;
      if (!msg) return;

      if (activeChat && (activeChat.targetId === msg.sender_id || activeChat.targetId === msg.group_id)) {
        loadMessages();
        if (msg.sender_id !== currentUser.id) markMessagesAsRead(activeChat.targetId, activeChat.type);
      }

      if (msg.sender_id !== currentUser.id) {
        playNotificationSound('msg', msg.sender_id);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('收到新訊息', { body: msg.content || '[媒體檔案]', icon: '/favicon.ico' });
        }
      }
    }).subscribe();

  supabaseClient.channel('public:message_reads')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reads' }, () => {
      if (activeChat) loadMessages();
    }).subscribe();

  supabaseClient.channel('public:friendships')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
      loadFriendsAndRequests();
      loadChatsList();
    }).subscribe();
}

async function recordCallMessage(text, targetUserId) {
  await supabaseClient.from('messages').insert([{
    sender_id: currentUser.id,
    receiver_id: targetUserId,
    content: text
  }]);
  if (activeChat) loadMessages();
}

function triggerDirectCall(targetUserId, isVideo) {
  openChat('user', targetUserId, '通話中');
  startCall(isVideo);
}

async function startCall(isVideo = false) {
  callStartTime = Date.now();
  const stream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
  const call = peer.call(activeChat.targetId, stream);
  dataConnection = peer.connect(activeChat.targetId);
  showVideoScreen(stream, call, isVideo);
}

function showVideoScreen(localStream, call, isVideo) {
  activeCall = call;
  document.getElementById('video-container').classList.remove('hidden');

  const remoteVideo = document.getElementById('remote-video');
  const localVideo = document.getElementById('local-video');
  const audioAvatar = document.getElementById('audio-call-avatar');

  if (isVideo) {
    remoteVideo.classList.remove('hidden');
    localVideo.classList.remove('hidden');
    audioAvatar.classList.add('hidden');
    localVideo.srcObject = localStream;
  } else {
    remoteVideo.classList.add('hidden');
    localVideo.classList.add('hidden');
    audioAvatar.classList.remove('hidden');
  }

  call.on('stream', (remoteStream) => {
    if (isVideo) remoteVideo.srcObject = remoteStream;
  });
  call.on('close', () => closeCallUI());
}

function endCall() {
  if (callStartTime) {
    const duration = Math.round((Date.now() - callStartTime) / 1000);
    recordCallMessage(`📞 通話結束 (通話時間: ${duration} 秒)`, activeChat.targetId);
    callStartTime = null;
  }
  if (dataConnection) dataConnection.send('END_CALL');
  if (activeCall) activeCall.close();
  closeCallUI();
}

function closeCallUI() {
  document.getElementById('video-container').classList.add('hidden');
  const remoteVideo = document.getElementById('remote-video');
  const localVideo = document.getElementById('local-video');
  if (remoteVideo.srcObject) remoteVideo.srcObject.getTracks().forEach(track => track.stop());
  if (localVideo.srcObject) localVideo.srcObject.getTracks().forEach(track => track.stop());
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

async function toggleVoiceRecord() {
  const btn = document.getElementById('voice-btn');
  if (!isRecording) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const filePath = `voice/${Date.now()}.webm`;
      await supabaseClient.storage.from('chat-attachments').upload(filePath, audioBlob);
      const { data: { publicUrl } } = supabaseClient.storage.from('chat-attachments').getPublicUrl(filePath);
      sendMessage(publicUrl, 'audio/webm');
    };
    mediaRecorder.start();
    isRecording = true;
    btn.innerText = '⏹️ 停止';
    btn.classList.add('bg-red-600');
  } else {
    mediaRecorder.stop();
    isRecording = false;
    btn.innerText = '🎙️ 語音';
    btn.classList.remove('bg-red-600');
  }
}

async function uploadFile(element) {
  const file = element.files[0];
  if (!file) return;
  const filePath = `${Date.now()}_${file.name}`;
  await supabaseClient.storage.from('chat-attachments').upload(filePath, file);
  const { data: { publicUrl } } = supabaseClient.storage.from('chat-attachments').getPublicUrl(filePath);
  sendMessage(publicUrl, file.type);
}

async function uploadAvatar(element) {
  const file = element.files[0];
  if (!file) return;
  const filePath = `avatars/${currentUser.id}_${Date.now()}`;
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