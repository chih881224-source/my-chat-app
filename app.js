const SUPABASE_URL = 'https://svvdhrqhkryhityqfrwc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2dmRocnFoa3J5aGl0eXFmcndjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MTI5MDUsImV4cCI6MjEwNDI4ODkwNX0.vnBB3wXbgmVQr_bH6SfvRA5Dg5_4_M58bofBWcnVU5A';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let activeChat = null; // { type: 'user' | 'group', targetId: 'uuid' }
let peer = null;
let activeCall = null;
let dataConnection = null; // 用於 PeerJS 通話掛斷信號監聽
let groupMembers = [];
let replyToMessage = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
if ('Notification' in window && Notification.permission !== 'granted') Notification.requestPermission();

// 檢查登入狀態
window.addEventListener('DOMContentLoaded', () => {
  const savedUser = localStorage.getItem('app_user_session');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    document.getElementById('auth-screen').classList.add('hidden');
    initApp();
  }
});

// 1. 驗證與登入
async function handleAuth(type) {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value.trim();
  if (!username || !password) return alert('請填寫帳號與密碼');

  if (type === 'register') {
    const { data: existingUser } = await supabaseClient.from('profiles').select('id').eq('username', username).maybeSingle();
    if (existingUser) return alert('此帳號名稱已存在！');

    const { error } = await supabaseClient.from('profiles').insert([{ username, password }]);
    if (error) return alert('註冊失敗：' + error.message);
    alert('註冊成功！請點擊登入');
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

// 2. 初始化 PeerJS 與監聽
function initApp() {
  document.getElementById('my-username').innerText = currentUser.username;
  document.getElementById('my-avatar').src = currentUser.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';
  document.getElementById('settings-avatar-preview').src = currentUser.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default';

  peer = new Peer(currentUser.id);
  
  // 監聽媒體通話 (視訊/語音)
  peer.on('call', async (call) => {
    if (confirm('收到來電！是否接聽？')) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      call.answer(stream);
      showVideoScreen(stream, call);
    }
  });

  // 監聽數據連線 (掛斷信號同步 - 解決問題一)
  peer.on('connection', (conn) => {
    dataConnection = conn;
    conn.on('data', (data) => {
      if (data === 'END_CALL') {
        closeCallUI();
      }
    });
  });

  loadFriendsAndRequests();
  loadChatsList();
  loadBlockedUsers();
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
  if (tab === 'settings') loadBlockedUsers();
}

// 3. 好友模組
async function loadFriendsAndRequests() {
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
      <button onclick="closeModal(); openChat('user', '${friendId}', '${username}')" class="bg-indigo-600 py-2.5 rounded text-sm font-bold">💬 直接開啟對話聊天室</button>
      <button onclick="closeModal(); triggerDirectCall('${friendId}', false)" class="bg-green-600 py-2 rounded text-sm font-bold">📞 語音通話</button>
      <button onclick="closeModal(); triggerDirectCall('${friendId}', true)" class="bg-blue-600 py-2 rounded text-sm font-bold">📹 視訊通話</button>
      <button onclick="closeModal(); blockUser('${friendId}')" class="bg-slate-700 hover:bg-red-600 py-2 rounded text-sm">封鎖使用者</button>
      <button onclick="closeModal(); deleteFriend('${friendshipId}')" class="bg-slate-700 hover:bg-red-800 py-2 rounded text-sm text-red-400">刪除好友</button>
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

// 解決問題二：修復刪除好友與封鎖邏輯
async function deleteFriend(friendshipId) {
  if (!confirm('確定要刪除好友嗎？')) return;
  await supabaseClient.from('friendships').delete().eq('id', friendshipId);
  alert('已刪除好友');
  loadFriendsAndRequests();
  loadChatsList();
}

async function blockUser(targetUserId) {
  if (!confirm('確定要封鎖此使用者嗎？')) return;
  await supabaseClient.from('friendships').upsert([
    { user_id: currentUser.id, friend_id: targetUserId, status: 'blocked' }
  ]);
  alert('已封鎖該使用者');
  loadFriendsAndRequests();
  loadChatsList();
}

// 解決問題二：基本設定的解除封鎖功能
async function loadBlockedUsers() {
  const container = document.getElementById('blocked-users-container');
  const { data: blocked } = await supabaseClient.from('friendships')
    .select('id, friend_id, profiles!friendships_friend_id_fkey(username, avatar_url)')
    .eq('user_id', currentUser.id).eq('status', 'blocked');

  container.innerHTML = blocked?.length ? '' : '<div class="text-slate-500">目前無封鎖任何使用者</div>';
  blocked?.forEach(b => {
    container.innerHTML += `
      <div class="flex justify-between items-center bg-slate-700 p-2 rounded">
        <span>${b.profiles.username}</span>
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

// 4. 開啟與載入聊天室
async function loadChatsList() {
  const container = document.getElementById('chats-container');
  container.innerHTML = '';

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
        <span class="text-xs text-indigo-400">點擊對話</span>
      </div>`;
  });

  const { data: groups } = await supabaseClient.from('group_members').select('groups(id, name)').eq('user_id', currentUser.id);
  groups?.forEach(g => {
    container.innerHTML += `
      <div onclick="openChat('group', '${g.groups.id}', '${g.groups.name}')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 text-indigo-300 font-bold flex justify-between items-center">
        <span>📢 ${g.groups.name}</span>
        <span class="text-xs text-slate-500">群組</span>
      </div>`;
  });
}

function openChat(type, targetId, title) {
  activeChat = { type, targetId };
  
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');
  document.getElementById('chat-title').innerText = title;

  const win = document.getElementById('chat-window');
  win.classList.add('chat-slide-open');
  win.classList.remove('translate-x-full');

  if (type === 'group') {
    supabaseClient.from('group_members').select('profiles(id, username)').eq('group_id', targetId)
      .then(({ data }) => { groupMembers = data?.map(d => d.profiles) || []; });
  }

  loadMessages();
}

function closeChatWindow() {
  const win = document.getElementById('chat-window');
  win.classList.remove('chat-slide-open');
  win.classList.add('translate-x-full');
}

// 5. 解決問題三：訊息發送與載入修復
async function loadMessages() {
  if (!activeChat) return;
  let query = supabaseClient.from('messages').select('*, profiles(username, avatar_url)');
  
  if (activeChat.type === 'user') {
    query = query.or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${activeChat.targetId}),and(sender_id.eq.${activeChat.targetId},receiver_id.eq.${currentUser.id})`);
  } else {
    query = query.eq('group_id', activeChat.targetId);
  }

  const { data: msgs, error } = await query.order('created_at', { ascending: true });
  if (error) console.error(error);

  const box = document.getElementById('messages-box');
  box.innerHTML = '';

  msgs?.forEach(m => {
    const isMe = m.sender_id === currentUser.id;
    let contentHTML = m.content || '';

    if (m.file_url) {
      if (m.file_type?.startsWith('image/')) {
        contentHTML = `<img src="${m.file_url}" class="max-w-xs rounded my-1 border border-slate-600">`;
      } else if (m.file_type?.startsWith('audio/')) {
        contentHTML = `<audio controls src="${m.file_url}" class="w-48 my-1"></audio>`;
      } else {
        contentHTML = `<a href="${m.file_url}" target="_blank" class="underline text-blue-300">📁 下載檔案</a>`;
      }
    }

    box.innerHTML += `
      <div class="flex gap-2 ${isMe ? 'flex-row-reverse' : ''}">
        <img src="${m.profiles?.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=default'}" class="w-8 h-8 rounded-full object-cover">
        <div class="max-w-xs p-3 rounded-lg ${isMe ? 'bg-indigo-600' : 'bg-slate-700'} relative group cursor-pointer" onclick="handleMessageOptions('${m.id}', '${m.content || ''}', ${isMe})">
          <div class="text-[10px] text-slate-300 mb-1">${m.profiles?.username || '使用者'}</div>
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
    content: replyToMessage ? `[回覆: ${replyToMessage}] ${content}` : content,
    file_url: fileUrl,
    file_type: fileType
  };

  if (activeChat.type === 'user') payload.receiver_id = activeChat.targetId;
  else payload.group_id = activeChat.targetId;

  const { error } = await supabaseClient.from('messages').insert([payload]);
  if (error) return alert('訊息發送失敗: ' + error.message);

  input.value = '';
  cancelReply();
  document.getElementById('mention-menu').classList.add('hidden');
  
  // 發送完立即更新介面
  loadMessages();
}

// 解決問題四：獨立設定視窗
function openChatCustomSettings() {
  if (!activeChat) return;
  const container = document.getElementById('modal-content');
  container.innerHTML = `
    <h3 class="text-sm font-bold mb-3">聊天室獨立設定</h3>
    <div class="flex flex-col gap-3 w-full text-left">
      <label class="flex items-center justify-between text-xs">
        <span>開啟訊息靜音</span>
        <input type="checkbox" id="chat-mute-toggle" class="toggle">
      </label>
      <label class="flex items-center justify-between text-xs">
        <span>聊天背景顏色</span>
        <input type="color" id="chat-bg-color" value="#0f172a" onchange="document.getElementById('messages-box').style.backgroundColor = this.value">
      </label>
      <button onclick="closeModal()" class="bg-indigo-600 py-2 rounded text-xs font-bold mt-2 text-center">完成設定</button>
    </div>`;
  document.getElementById('modal').classList.remove('hidden');
}

// 訊息選項（回收/編輯/回覆）
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

// 語音錄製發送
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

// 解決問題三：修正 Realtime 廣播
function subscribeRealtime() {
  supabaseClient.channel('public:messages')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (payload) => {
      if (activeChat) loadMessages();
      
      // 跳出瀏覽器通知
      if (payload.new && payload.new.sender_id !== currentUser.id && Notification.permission === 'granted') {
        new Notification('新訊息通知', { body: payload.new.content || '[收到檔案/媒體]' });
      }
    }).subscribe();

  supabaseClient.channel('public:friendships')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
      loadFriendsAndRequests();
      loadChatsList();
    }).subscribe();
}

// 解決問題一：通話發起與掛斷連動
function triggerDirectCall(targetUserId, isVideo) {
  openChat('user', targetUserId, '通話中');
  startCall(isVideo);
}

async function startCall(isVideo) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
  const call = peer.call(activeChat.targetId, stream);
  
  // 建立數據通道，發送掛斷訊號
  dataConnection = peer.connect(activeChat.targetId);
  
  showVideoScreen(stream, call);
}

function showVideoScreen(localStream, call) {
  activeCall = call;
  document.getElementById('video-container').classList.remove('hidden');
  document.getElementById('local-video').srcObject = localStream;
  call.on('stream', (remoteStream) => {
    document.getElementById('remote-video').srcObject = remoteStream;
  });
  call.on('close', () => {
    closeCallUI();
  });
}

// 解決問題一：主動通知對方關閉通話畫面
function endCall() {
  if (dataConnection) {
    dataConnection.send('END_CALL');
  }
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

// 檔案與頭像上傳
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

function handleInputTyping(input) {
  handleInputMention(input);
}

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