// 1. 初始化 Supabase
const SUPABASE_URL = 'https://svvdhrqhkryhityqfrwc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2dmRocnFoa3J5aGl0eXFmcndjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3MTI5MDUsImV4cCI6MjEwNDI4ODkwNX0.vnBB3wXbgmVQr_bH6SfvRA5Dg5_4_M58bofBWcnVU5A';
const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let activeChat = null; // { type: 'user' | 'group', targetId: 'uuid' }
let peer = null;
let activeCall = null;

// PWA Service Worker 註冊
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

// 請求推播通知權限
if ('Notification' in window && Notification.permission !== 'granted') {
  Notification.requestPermission();
}

// 2. 註冊 / 登入邏輯
async function handleAuth(type) {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value.trim();
  if (!username || !password) return alert('請填寫帳號與密碼');

  if (type === 'register') {
    const { data, error } = await supabase.from('profiles').insert([{ username, password }]).select();
    if (error) return alert('註冊失敗，帳號可能已被使用：' + error.message);
    alert('註冊成功！請登入');
  } else {
    const { data, error } = await supabase.from('profiles').select('*').eq('username', username).eq('password', password).single();
    if (error || !data) return alert('帳號或密碼錯誤');
    currentUser = data;
    document.getElementById('auth-screen').classList.add('hidden');
    initApp();
  }
}

// 3. 登入後初始化應用
function initApp() {
  document.getElementById('my-username').innerText = currentUser.username;
  document.getElementById('my-avatar').src = currentUser.avatar_url;

  // 初始化 WebRTC PeerJS
  peer = new Peer(currentUser.id);
  peer.on('call', async (call) => {
    if (confirm('收到來電！是否接聽？')) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      call.answer(stream);
      showVideoScreen(stream, call);
    }
  });

  loadFriendsAndGroups();
  subscribeRealtimeMessages();
}

// 4. 載入好友與群組清單
async function loadFriendsAndGroups() {
  // 載入好友
  const { data: friends } = await supabase.from('friendships')
    .select('friend_id, status, profiles!friendships_friend_id_fkey(id, username, avatar_url)')
    .eq('user_id', currentUser.id).eq('status', 'accepted');

  const friendsContainer = document.getElementById('friends-container');
  friendsContainer.innerHTML = '';
  friends?.forEach(f => {
    const u = f.profiles;
    friendsContainer.innerHTML += `
      <div onclick="openChat('user', '${u.id}', '${u.username}')" class="p-3 border-b border-slate-800 flex items-center justify-between cursor-pointer hover:bg-slate-800">
        <div class="flex items-center gap-2">
          <img src="${u.avatar_url}" class="w-8 h-8 rounded-full">
          <span>${u.username}</span>
        </div>
        <button onclick="blockUser('${u.id}', event)" class="text-xs text-red-400">封鎖</button>
      </div>`;
  });

  // 載入群組
  const { data: groups } = await supabase.from('group_members')
    .select('groups(id, name)').eq('user_id', currentUser.id);

  const groupsContainer = document.getElementById('groups-container');
  groupsContainer.innerHTML = '';
  groups?.forEach(g => {
    groupsContainer.innerHTML += `
      <div onclick="openChat('group', '${g.groups.id}', '${g.groups.name}')" class="p-3 border-b border-slate-800 cursor-pointer hover:bg-slate-800 text-indigo-300 font-bold">
        📢 ${g.groups.name}
      </div>`;
  });
}

// 5. 開啟聊天室與載入訊息
async function openChat(type, targetId, title) {
  activeChat = { type, targetId };
  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');
  document.getElementById('chat-title').innerText = title;
  
  loadMessages();
}

async function loadMessages() {
  if (!activeChat) return;
  let query = supabase.from('messages').select('*, profiles(username, avatar_url)');
  
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
      contentHTML = m.file_type.startsWith('image/') 
        ? `<img src="${m.file_url}" class="max-w-xs rounded">` 
        : `<a href="${m.file_url}" target="_blank" class="underline text-blue-300">下載檔案</a>`;
    }

    box.innerHTML += `
      <div class="flex gap-2 ${isMe ? 'flex-row-reverse' : ''}">
        <img src="${m.profiles.avatar_url}" class="w-8 h-8 rounded-full">
        <div class="max-w-xs p-3 rounded-lg ${isMe ? 'bg-indigo-600' : 'bg-slate-700'}">
          <div class="text-xs text-slate-300 mb-1">${m.profiles.username}</div>
          <div>${contentHTML}</div>
        </div>
      </div>`;
  });
  box.scrollTop = box.scrollHeight;
}

// 6. 發送訊息與檔上傳
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

  await supabase.from('messages').insert([payload]);
  input.value = '';
}

async function uploadFile(element) {
  const file = element.files[0];
  if (!file) return;

  const filePath = `chat-files/${Date.now()}_${file.name}`;
  const { data, error } = await supabase.storage.from('chat-attachments').upload(filePath, file);
  if (error) return alert('檔案上傳失敗：' + error.message);

  const { data: { publicUrl } } = supabase.storage.from('chat-attachments').getPublicUrl(filePath);
  sendMessage(publicUrl, file.type);
}

// 7. Supabase Realtime 即時接收訊息與系統推播
function subscribeRealtimeMessages() {
  supabase.channel('public:messages')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const newMsg = payload.new;
      if (activeChat && ((activeChat.type === 'user' && newMsg.sender_id === activeChat.targetId) || 
          (activeChat.type === 'group' && newMsg.group_id === activeChat.targetId) || 
          newMsg.sender_id === currentUser.id)) {
        loadMessages();
      } else {
        // 發送瀏覽器推播通知
        if (Notification.permission === 'granted') {
          new Notification('收到新訊息', { body: newMsg.content || '[收到檔案]' });
        }
      }
    }).subscribe();
}

// 8. 產生 / 掃描 QR Code 加好友
function showQRCode() {
  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3>我的好友 QR Code</h3><canvas id="qrcode" class="mx-auto my-4"></canvas>';
  QRCode.toCanvas(document.getElementById('qrcode'), currentUser.id);
  document.getElementById('modal').classList.remove('hidden');
}

function startQRScan() {
  const container = document.getElementById('modal-content');
  container.innerHTML = '<h3>請將鏡頭對準好友的 QR Code</h3><div id="reader" class="w-full mt-4"></div>';
  document.getElementById('modal').classList.remove('hidden');

  const html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, async (friendId) => {
    html5QrCode.stop();
    closeModal();
    // 建立雙向好友關係
    await supabase.from('friendships').insert([
      { user_id: currentUser.id, friend_id: friendId, status: 'accepted' },
      { user_id: friendId, friend_id: currentUser.id, status: 'accepted' }
    ]);
    alert('已成功新增好友！');
    loadFriendsAndGroups();
  });
}

function closeModal() { document.getElementById('modal').classList.add('hidden'); }

// 9. 建群組 & WebRTC 語音/視訊通話
async function createGroupPrompt() {
  const groupName = prompt('請輸入群組名稱：');
  if (!groupName) return;
  const { data: grp } = await supabase.from('groups').insert([{ name: groupName, created_by: currentUser.id }]).select().single();
  await supabase.from('group_members').insert([{ group_id: grp.id, user_id: currentUser.id }]);
  alert('群組建立完成！');
  loadFriendsAndGroups();
}

async function startCall(isVideo) {
  if (activeChat.type !== 'user') return alert('通話功能僅支援一對一聊天');
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

// 10. 個人個人資料設定
function openProfileSettings() {
  const newAvatar = prompt('請輸入新頭像圖片網址：', currentUser.avatar_url);
  if (newAvatar) {
    supabase.from('profiles').update({ avatar_url: newAvatar }).eq('id', currentUser.id)
      .then(() => {
        currentUser.avatar_url = newAvatar;
        document.getElementById('my-avatar').src = newAvatar;
      });
  }
}