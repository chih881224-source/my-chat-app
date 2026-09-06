const SUPABASE_URL = 'https://svvdhrqhkryhityqfrwc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2dmRocnFoa3J5aGl0eXFmcndjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MTI5MDUsImV4cCI6MjEwNDI4ODkwNX0.vnBB3wXbgmVQr_bH6SfvRA5Dg5_4_M58bofBWcnVU5A';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let activeChat = null; // { type: 'user' | 'group', targetId: 'uuid' }
let peer = null;
let activeCall = null;
let groupMembers = []; 
let chatCustomSettings = {}; 

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
if ('Notification' in window && Notification.permission !== 'granted') Notification.requestPermission();

// 自動檢查快取實現「記住登入狀態」(解決第三問題)
window.addEventListener('DOMContentLoaded', () => {
  const savedUser = localStorage.getItem('app_user_session');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    document.getElementById('auth-screen').classList.add('hidden');
    initApp();
  }
});

// 1. 註冊 / 登入
async function handleAuth(type) {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value.trim();
  if (!username || !password) return alert('請填寫帳號與密碼');

  if (type === 'register') {
    const { data: existingUser } = await supabaseClient.from('profiles').select('id').eq('username', username).maybeSingle();
    if (existingUser) return alert('此帳號名稱已存在！');

    const { error } = await supabaseClient.from('profiles').insert([{ username, password }]);
    if (error) return alert('註冊失敗：' + error.message);
    alert('註冊成功！請直接點擊登入');
  } else {
    const { data, error } = await supabaseClient.from('profiles').select('*').eq('username', username).eq('password', password).maybeSingle();
    if (error || !data) return alert('帳號或密碼錯誤');
    currentUser = data;
    localStorage.setItem('app_user_session', JSON.stringify(data)); // 記憶狀態
    document.getElementById('auth-screen').classList.add('hidden');
    initApp();
  }
}

// 2. 初始化應用
function initApp() {
  document.getElementById('my-username').innerText = currentUser.username;
  document.getElementById('my-avatar').src = currentUser.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';
  document.getElementById('settings-avatar-preview').src = currentUser.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';

  peer = new Peer(currentUser.id);
  peer.on('call', async (call) => {
    if (confirm('收到來電！是否接聽？')) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      call.answer(stream);
      showVideoScreen(stream, call);
    }
  });

  loadFriendsAndRequests();
  loadChatsList();
  subscribeRealtime();
}

// 頁籤切換
function switchTab(tab) {
  ['friends', 'chats', 'settings'].forEach(t => {
    document.getElementById(`page-${t}`).classList.add('hidden');
    document.getElementById(`tab-${t}`).className = "flex-1 py-3 text-center text-xs font-bold text-slate-400";
  });
  document.getElementById(`page-${tab}`).classList.remove('hidden');
  document.getElementById(`tab-${tab}`).className = "flex-1 py-3 text-center text-xs font-bold border-b-2 border-indigo-500 text-indigo-400";
}

// 3. 載入好友與邀請 (解決第一與第五問題)
async function loadFriendsAndRequests() {
  // 好友邀請列表
  const { data: requests } = await supabaseClient.from('friendships')
    .select('id, user_id, profiles!friendships_user_id_fkey(username, avatar_url)')
    .eq('friend_id', currentUser.id).eq('status', 'pending');

  const reqContainer = document.getElementById('friend-requests-container');
  reqContainer.innerHTML = requests?.length ? '' : '<div class="text-xs text-slate-500">無待處理邀請</div>';
  requests?.forEach(r => {
    reqContainer.innerHTML += `
      <div class="p-2 bg-slate-800 rounded flex justify-between items-center mb-1 text-xs">
        <span>${r.profiles.username} 想要加你為好友</span>
        <div class="flex gap-1">
          <button onclick="respondFriendRequest('${r.id}', '${r.user_id}', 'accepted')" class="bg-green-600 px-2 py-0.5 rounded">接受</button>
          <button onclick="respondFriendRequest('${r.id}', '${r.user_id}', 'rejected')" class="bg-red-600 px-2 py-0.5 rounded">拒絕</button>
        </div>
      </div>`;
  });

  // 已接受的好友列表
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
        <span class="text-xs text-slate-400">點擊操作 ▸</span>
      </div>`;
  });
}

// 點擊好友彈出選單 (對話、語音、視訊、刪除、封鎖 - 解決第一問題)
function openFriendMenu(friendId, username, friendshipId) {
  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-base font-bold mb-4">${username}</h3>
    <div class="flex flex-col gap-2 w-full">
      <button onclick="closeModal(); openChat('user', '${friendId}', '${username}')" class="bg-indigo-600 py-2 rounded text-sm font-bold">💬 發送訊息對話</button>
      <button onclick="closeModal(); triggerDirectCall('${friendId}', false)" class="bg-green-600 py-2 rounded text-sm font-bold">📞 語音通話</button>
      <button onclick="closeModal(); triggerDirectCall('${friendId}', true)" class="bg-blue-600 py-2 rounded text-sm font-bold">📹 視訊通話</button>
      <button onclick="closeModal(); blockUser('${friendId}')" class="bg-slate-700 hover:bg-red-600 py-2 rounded text-sm">封鎖使用者</button>
      <button onclick="closeModal(); deleteFriend('${friendshipId}')" class="bg-slate-700 hover:bg-red-800 py-2 rounded text-sm text-red-400">刪除好友</button>
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

// 好友邀請回應 (雙向自動新增 - 解決第五問題)
async function respondFriendRequest(requestId, senderId, status) {
  if (status === 'accepted') {
    await supabaseClient.from('friendships').update({ status: 'accepted' }).eq('id', requestId);
    // 反向寫入好友關係，確保雙方都有好友
    await supabaseClient.from('friendships').upsert([{ user_id: currentUser.id, friend_id: senderId, status: 'accepted' }]);
  } else {
    await supabaseClient.from('friendships').delete().eq('id', requestId);
  }
  loadFriendsAndRequests();
  loadChatsList();
}

async function deleteFriend(friendshipId) {
  if (!confirm('確定要刪除此好友？')) return;
  await supabaseClient.from('friendships').delete().eq('id', friendshipId);
  loadFriendsAndRequests();
}

async function blockUser(targetUserId) {
  if (!confirm('確定要封鎖此使用者？')) return;
  await supabaseClient.from('friendships').upsert([{ user_id: currentUser.id, friend_id: targetUserId, status: 'blocked' }]);
  loadFriendsAndRequests();
}

// 4. 載入與開啟聊天室 (解決第二問題)
async function loadChatsList() {
  const container = document.getElementById('chats-container');
  container.innerHTML = '';

  // 1. 載入個人好友對話列表
  const { data: friends } = await supabaseClient.from('friendships')
    .select('friend_id, profiles!friendships_friend_id_fkey(id, username, avatar_url)')
    .eq('user_id', currentUser.id).eq('status', 'accepted');

  friends?.forEach(f => {
    const u = f.profiles;
    container.innerHTML += `
      <div onclick="openChat('user', '${u.id}', '${u.username}')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 flex justify-between items-center">
        <div class="flex items-center gap-2">
          <img src="${u.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
          <span class="text-sm font-bold">${u.username}</span>
        </div>
        <span class="text-xs text-slate-500">私訊</span>
      </div>`;
  });

  // 2. 載入群組對話列表
  const { data: groups } = await supabaseClient.from('group_members').select('groups(id, name)').eq('user_id', currentUser.id);
  groups?.forEach(g => {
    container.innerHTML += `
      <div onclick="openChat('group', '${g.groups.id}', '${g.groups.name}')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 text-indigo-300 font-bold flex justify-between items-center">
        <span>📢 ${g.groups.name}</span>
        <span class="text-xs text-slate-500">群組</span>
      </div>`;
  });
}

// 開啟聊天室
async function openChat(type, targetId, title) {
  activeChat = { type, targetId };
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');
  document.getElementById('chat-title').innerText = title;

  document.getElementById('chat-window').classList.remove('translate-x-full');

  if (type === 'group') {
    const { data } = await supabaseClient.from('group_members').select('profiles(id, username)').eq('group_id', targetId);
    groupMembers = data?.map(d => d.profiles) || [];
  }

  loadMessages();
}

function closeChatWindow() {
  document.getElementById('chat-window').classList.add('translate-x-full');
}

// 5. 訊息載入與發送
async function loadMessages() {
  if (!activeChat) return;
  let query = supabaseClient.from('messages').select('*, profiles(username, avatar_url)');
  
  if (activeChat.type === 'user') {
    query = query.or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeChat.targetId}),and(sender_id.eq.${activeChat.targetId},receiver_id.eq.${currentUser.id})`);
  } else {
    query = query.eq('group_id', activeChat.targetId);
  }

  const { data: msgs } = await query.order('created_at', { ascending: true });
  const box = document.getElementById('messages-box');
  box.innerHTML = '';

  msgs?.forEach(m => {
    const isMe = m.sender_id === currentUser.id;
    let contentHTML = m.content || '';
    if (m.file_url) {
      contentHTML = m.file_type?.startsWith('image/') 
        ? `<img src="${m.file_url}" class="max-w-xs rounded my-1 border border-slate-600">` 
        : `<a href="${m.file_url}" target="_blank" class="underline text-blue-300">📁 下載檔案</a>`;
    }

    box.innerHTML += `
      <div class="flex gap-2 ${isMe ? 'flex-row-reverse' : ''}">
        <img src="${m.profiles?.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
        <div class="max-w-xs p-3 rounded-lg ${isMe ? 'bg-indigo-600' : 'bg-slate-700'}">
          <div class="text-xs text-slate-300 mb-1">${m.profiles?.username || '未知'}</div>
          <div class="text-sm break-words">${contentHTML}</div>
        </div>
      </div>`;
  });
  box.scrollTop = box.scrollHeight;
}

async function sendMessage(fileUrl = null, fileType = null) {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content && !fileUrl) return;

  const payload = {
    sender_id: currentUser.id,
    content: content,
    file_url: fileUrl,
    file_type: fileType
  };

  if (activeChat.type === 'user') payload.receiver_id = activeChat.targetId;
  else payload.group_id = activeChat.targetId;

  await supabaseClient.from('messages').insert([payload]);
  input.value = '';
  document.getElementById('mention-menu').classList.add('hidden');
}

// 6. 即時訂閱 Supabase Realtime (訊息 + 好友邀請即時通知 - 解決第四問題)
function subscribeRealtime() {
  // 監聽訊息
  supabaseClient.channel('public:messages')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const newMsg = payload.new;
      if (activeChat && ((activeChat.type === 'user' && newMsg.sender_id === activeChat.targetId) || 
          (activeChat.type === 'group' && newMsg.group_id === activeChat.targetId) || 
          newMsg.sender_id === currentUser.id)) {
        loadMessages();
      } else {
        if (Notification.permission === 'granted') {
          new Notification('收到新訊息', { body: newMsg.content || '[圖片/檔案]' });
        }
      }
    }).subscribe();

  // 監聽好友邀請 / 狀態變更即時重新載入
  supabaseClient.channel('public:friendships')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, (payload) => {
      loadFriendsAndRequests();
      loadChatsList();
      if (payload.eventType === 'INSERT' && payload.new.friend_id === currentUser.id) {
        alert('🔔 收到新的好友邀請！');
      }
    }).subscribe();
}

// 圖片上傳與設定
async function uploadFile(element) {
  const file = element.files[0];
  if (!file) return;

  const filePath = `${Date.now()}_${file.name}`;
  const { data, error } = await supabaseClient.storage.from('chat-attachments').upload(filePath, file);
  if (error) return alert('圖片上傳失敗：' + error.message);

  const { data: { publicUrl } } = supabaseClient.storage.from('chat-attachments').getPublicUrl(filePath);
  sendMessage(publicUrl, file.type);
}

async function uploadAvatar(element) {
  const file = element.files[0];
  if (!file) return;

  const filePath = `avatars/${currentUser.id}_${Date.now()}`;
  const { data, error } = await supabaseClient.storage.from('chat-attachments').upload(filePath, file);
  if (error) return alert('頭像上傳失敗：' + error.message);

  const { data: { publicUrl } } = supabaseClient.storage.from('chat-attachments').getPublicUrl(filePath);
  await supabaseClient.from('profiles').update({ avatar_url: publicUrl }).eq('id', currentUser.id);

  currentUser.avatar_url = publicUrl;
  localStorage.setItem('app_user_session', JSON.stringify(currentUser));
  document.getElementById('my-avatar').src = publicUrl;
  document.getElementById('settings-avatar-preview').src = publicUrl;
  alert('頭像更新成功！');
}

// 輔助功能：@ 標記 / 通話
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

function triggerDirectCall(targetUserId, isVideo) {
  openChat('user', targetUserId, '通話中');
  startCall(isVideo);
}

async function startCall(isVideo) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
  const call = peer.call(activeChat.targetId, stream);
  showVideoScreen(stream, call);
}

function showVideoScreen(localStream, call) {
  activeCall = call;
  document.getElementById('video-container').classList.remove('hidden');
  document.getElementById('local-video').srcObject = localStream;
  call.on('stream', (remoteStream) => {
    document.getElementById('remote-video').srcObject = remoteStream;
  });
}

function endCall() {
  if (activeCall) activeCall.close();
  document.getElementById('video-container').classList.add('hidden');
}

// 發送 QR 好友邀請
function startQRScan() {
  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3>掃描好友 QR Code 發送邀請</h3><div id="reader" class="w-full mt-4"></div>';
  document.getElementById('modal').classList.remove('hidden');

  const html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, async (friendId) => {
    html5QrCode.stop();
    closeModal();
    if (friendId === currentUser.id) return alert('不能新增自己為好友！');

    await supabaseClient.from('friendships').insert([{ user_id: currentUser.id, friend_id: friendId, status: 'pending' }]);
    alert('好友邀請已發送！');
  });
}

function showQRCode() {
  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3>我的好友 QR Code</h3><canvas id="qrcode" class="mx-auto my-4"></canvas>';
  QRCode.toCanvas(document.getElementById('qrcode'), currentUser.id);
  document.getElementById('modal').classList.remove('hidden');
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
  if (activeChat.type === 'group') {
    if (!confirm('確定要退出這個群組嗎？')) return;
    await supabaseClient.from('group_members').delete().eq('group_id', activeChat.targetId).eq('user_id', currentUser.id);
  } else {
    if (!confirm('確定要刪除對話紀錄？')) return;
    await supabaseClient.from('messages').delete().or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeChat.targetId}),and(sender_id.eq.${activeChat.targetId},receiver_id.eq.${currentUser.id})`);
  }
  closeChatWindow();
  loadChatsList();
}

function openChatCustomSettings() {
  const isMuted = chatCustomSettings[activeChat.targetId] === 'muted';
  chatCustomSettings[activeChat.targetId] = isMuted ? 'normal' : 'muted';
  alert(isMuted ? '已開啟通知' : '已將此對話靜音');
}