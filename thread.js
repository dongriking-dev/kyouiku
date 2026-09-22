// ============================================================
// thread.js — スレッド詳細ページ専用
// ============================================================
import {
  db, auth, provider, COL, getSubjectInfo, subjectBadgeHtml,
  roleFromEmail, escapeHtml, showBanner, fileToBase64Image, formatSize,
  buildFileHtml, renderRichContent, stripRichHtml, formatContent,
  createRichEditor, getEditorHtml, getEditorText, clearEditor,
  tokenizeQuery, matchesAllTokens,
  loadBadgeVisibility, loadReadThreads, saveReadThreads, emailToKey
} from './common.js';

import {
  collection, doc, addDoc, setDoc, getDoc, getDocs, deleteDoc, updateDoc,
  onSnapshot, query, orderBy, limit, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ---------------- グローバル状態 ----------------
let currentUser = null;
let userRole = null;
let threadId = null;
let threadData = null;
let allPostsCache = [];
let postNumberMap = new Map();
let postLikesCache = {};
let threadLikesCache = {};
let nicknamesCache = {};
let customBadgesCache = {};
let officialUsersCache = {};
let bannedUsersCache = {};
let myBadgePublic = true;
let activeReplyParentId = null;
let activeEditPostId = null;
let inThreadSearchQuery = '';
let readThreads = {};

let postsUnsubscribe = null;
let postLikesUnsubscribe = null;
let threadLikesUnsubscribe = null;
let nicknamesUnsubscribe = null;
let badgesUnsubscribe = null;
let officialUnsubscribe = null;
let bannedUsersUnsubscribe = null;
let threadDocUnsubscribe = null;

let intentionalSignOut = false;
let initialAuthCheckDone = false;

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const loginView = $('loginView');
const mainView = $('mainView');
const postsContainer = $('postsContainer');
const connDot = $('connDot');
const connText = $('connText');
const bootOverlay = $('bootOverlay');
const threadLikeBtn = $('threadLikeBtn');
const inThreadSearchInput = $('inThreadSearchInput');
const inThreadSearchClear = $('inThreadSearchClear');
const inThreadSearchInfo = $('inThreadSearchInfo');

// ---------------- URL から threadId ----------------
const params = new URLSearchParams(location.search);
threadId = params.get('id');
if (!threadId) {
  alert('スレッドIDが指定されていません。一覧に戻ります。');
  location.href = 'index.html';
}

// ---------------- 権限 ----------------
function canDelete() { return userRole === 'admin' || userRole === 'owner' || userRole === 'vip'; }
function canViewEmail() { return userRole === 'admin' || userRole === 'owner'; }

// ---------------- 接続 ----------------
function setConnection(online) {
  if (online) {
    connDot.className = 'inline-block w-2 h-2 rounded-full bg-green-500';
    connText.textContent = 'オンライン（リアルタイム同期中）';
  } else {
    connDot.className = 'inline-block w-2 h-2 rounded-full bg-red-500';
    connText.textContent = 'オフライン';
  }
}
window.addEventListener('online', () => setConnection(true));
window.addEventListener('offline', () => setConnection(false));

// ---------------- ログイン ----------------
$('googleLoginBtn').addEventListener('click', async () => {
  try { await signInWithPopup(auth, provider); }
  catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') alert("ログインに失敗しました: " + (err.message || ''));
  }
});
$('logoutBtn').addEventListener('click', async () => {
  intentionalSignOut = true;
  cleanupAll();
  try { await signOut(auth); } catch (e) {}
  location.href = 'index.html';
});

function showMainView() { loginView.classList.add('hidden'); mainView.classList.remove('hidden'); }
function showLoginView() { loginView.classList.remove('hidden'); mainView.classList.add('hidden'); }
function hideBootOverlay() { bootOverlay.classList.add('hidden'); }

async function trySilentSignIn() {
  try {
    const { GoogleAuthProvider } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js");
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'none' });
    await signInWithPopup(auth, p);
  } catch (err) {
    hideBootOverlay(); showLoginView();
  } finally { initialAuthCheckDone = true; }
}

// ---------------- 認証 ----------------
onAuthStateChanged(auth, async (user) => {
  if (intentionalSignOut) { currentUser = null; return; }
  currentUser = user;
  if (!user) {
    userRole = null;
    if (!initialAuthCheckDone) { trySilentSignIn(); return; }
    hideBootOverlay(); showLoginView();
    return;
  }
  userRole = roleFromEmail(user.email);
  myBadgePublic = loadBadgeVisibility(user.email);
  readThreads = loadReadThreads(user.uid);

  await loadThreadMeta();
  initThreadDocListener();
  initPostsListener();
  initPostLikesListener();
  initThreadLikesListener();
  initNicknamesListener();
  initBadgesListener();
  initOfficialListener();
  initBannedUsersListener();

  createRichEditor($('postEditorWrap'), 'コメントを入力してください。URLは自動でリンク化されます。');
  setupInThreadSearch();
  setupPostForm();
  setupFileInput();
  setupLikeButton();
  setupDeleteThreadBtn();

  renderRoleBadge(userRole);
  hideBootOverlay();
  showMainView();
  setConnection(navigator.onLine);
});

function renderRoleBadge(role) {
  const c = $('roleBadgeContainer');
  c.innerHTML = '';
  if (role === 'admin') c.innerHTML = '<span class="admin-badge">管理者</span>';
  else if (role === 'owner') c.innerHTML = '<span class="owner-badge">主</span>';
  else if (role === 'vip') c.innerHTML = '<span class="vip-badge">VIP</span>';
}

// ---------------- スレッド本体 ----------------
async function loadThreadMeta() {
  const snap = await getDoc(doc(db, COL.threads, threadId));
  if (!snap.exists()) {
    alert('このスレッドは削除されました。');
    location.href = 'index.html';
    return;
  }
  threadData = snap.data();
  document.title = threadData.title + ' - どんぐり学びの広場';
  $('currentThreadTitle').innerText = threadData.title;
  $('currentThreadSubjectWrap').innerHTML = subjectBadgeHtml(threadData.subject);
  $('currentThreadDate').innerText = '作成日時: ' + (threadData.createdAt ? new Date(threadData.createdAt).toLocaleString('ja-JP') : '不明');
  threadLikeBtn.dataset.threadId = threadId;
  markThreadAsRead();
}
function initThreadDocListener() {
  if (threadDocUnsubscribe) threadDocUnsubscribe();
  threadDocUnsubscribe = onSnapshot(doc(db, COL.threads, threadId), (snap) => {
    if (snap.exists()) {
      threadData = snap.data();
      $('currentThreadTitle').innerText = threadData.title;
    }
  });
}
function markThreadAsRead() {
  if (!currentUser || !threadId) return;
  readThreads[threadId] = Date.now();
  saveReadThreads(currentUser.uid, readThreads);
}

// ---------------- 監視 ----------------
function initPostsListener() {
  if (postsUnsubscribe) postsUnsubscribe();
  const q = query(collection(db, COL.threads, threadId, 'posts'), orderBy('createdAt', 'asc'), limit(300));
  postsUnsubscribe = onSnapshot(q, (snap) => {
    setConnection(true);
    const posts = [];
    snap.forEach(d => posts.push({ id: d.id, ...d.data() }));
    allPostsCache = posts;
    postNumberMap = new Map();
    posts.forEach((p, i) => postNumberMap.set(p.id, i + 1));
    renderPostsFromCache();
    markThreadAsRead();
  }, (err) => {
    console.error('レス監視エラー:', err);
    setConnection(false);
    postsContainer.innerHTML = '<p class="text-red-500 text-sm">読み込みに失敗しました。</p>';
  });
}
function initPostLikesListener() {
  if (postLikesUnsubscribe) postLikesUnsubscribe();
  postLikesUnsubscribe = onSnapshot(collection(db, COL.threads, threadId, 'postLikes'), (snap) => {
    postLikesCache = {};
    snap.forEach(d => { postLikesCache[d.id] = d.data() || {}; });
    renderPostsFromCache();
  }, (err) => console.error('レスいいね監視エラー:', err));
}
function initThreadLikesListener() {
  if (threadLikesUnsubscribe) threadLikesUnsubscribe();
  threadLikesUnsubscribe = onSnapshot(collection(db, COL.threadLikes), (snap) => {
    threadLikesCache = {};
    snap.forEach(d => { threadLikesCache[d.id] = d.data() || {}; });
    updateThreadLikeButton();
  }, (err) => console.error('スレッドいいね監視エラー:', err));
}
function initNicknamesListener() {
  if (nicknamesUnsubscribe) nicknamesUnsubscribe();
  nicknamesUnsubscribe = onSnapshot(collection(db, COL.nicknames), (snap) => {
    nicknamesCache = {};
    snap.forEach(d => { nicknamesCache[d.id] = d.data(); });
    renderPostsFromCache();
  }, (err) => console.error('ニックネーム監視エラー:', err));
}
function initBadgesListener() {
  if (badgesUnsubscribe) badgesUnsubscribe();
  badgesUnsubscribe = onSnapshot(collection(db, COL.customBadges), (snap) => {
    customBadgesCache = {};
    snap.forEach(d => { customBadgesCache[d.id] = d.data().badges || {}; });
    renderPostsFromCache();
  }, (err) => console.error('バッジ監視エラー:', err));
}
function initOfficialListener() {
  if (officialUnsubscribe) officialUnsubscribe();
  officialUnsubscribe = onSnapshot(collection(db, COL.officialUsers), (snap) => {
    officialUsersCache = {};
    snap.forEach(d => { officialUsersCache[d.id] = d.data(); });
    renderPostsFromCache();
  }, (err) => console.error('公式監視エラー:', err));
}
function initBannedUsersListener() {
  if (bannedUsersUnsubscribe) bannedUsersUnsubscribe();
  bannedUsersUnsubscribe = onSnapshot(collection(db, COL.bannedUsers), (snap) => {
    bannedUsersCache = {};
    snap.forEach(d => { bannedUsersCache[d.id] = d.data(); });
    renderPostsFromCache();
  }, (err) => console.error('BAN監視エラー:', err));
}

// ---------------- スレッド内検索 ----------------
function setupInThreadSearch() {
  let debounce = null;
  inThreadSearchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      inThreadSearchQuery = inThreadSearchInput.value;
      inThreadSearchClear.classList.toggle('show', !!inThreadSearchInput.value.trim());
      renderPostsFromCache();
    }, 150);
  });
  inThreadSearchClear.addEventListener('click', () => {
    inThreadSearchInput.value = ''; inThreadSearchQuery = '';
    inThreadSearchClear.classList.remove('show');
    renderPostsFromCache();
  });
}

// ---------------- レス描画 ----------------
function isPostBanned(post) {
  if (!post) return false;
  if (post.authorUid && bannedUsersCache[post.authorUid]) return true;
  if (post.authorEmail) {
    const ek = emailToKey(post.authorEmail);
    if (ek && bannedUsersCache[ek]) return true;
  }
  return false;
}
function buildPostRoleBadge(post) {
  if (!post || post.badgeVisible === false) return '';
  const r = post.authorRole;
  if (r === 'admin') return `<span class="role-post-badge admin">管理者</span>`;
  if (r === 'owner') return `<span class="role-post-badge owner">主</span>`;
  if (r === 'vip') return `<span class="role-post-badge vip">VIP</span>`;
  return '';
}
function buildPostCustomBadge(post) {
  if (!post || post.badgeVisible === false) return '';
  const uid = post.authorUid;
  if (!uid) return '';
  const badges = customBadgesCache[uid];
  if (!badges) return '';
  let html = '';
  Object.values(badges).forEach(b => {
    if (b?.label && b?.color) html += `<span class="custom-badge" style="background:${escapeHtml(b.color)};">${escapeHtml(b.label)}</span>`;
  });
  return html;
}
function buildOfficialBadge(post) {
  if (!post?.authorUid) return '';
  const info = officialUsersCache[post.authorUid];
  if (!info?.official) return '';
  const note = info.note ? ` title="${escapeHtml(info.note)}"` : ' title="公式アカウント"';
  return `<span class="official-badge"${note}>✓</span>`;
}
function resolveDisplayName(post) {
  if (!post) return '名無しさん';
  if (post.authorUid && nicknamesCache[post.authorUid]?.nickname) {
    return nicknamesCache[post.authorUid].nickname;
  }
  return post.author || '名無しさん';
}

function renderPostsFromCache() {
  postsContainer.innerHTML = '';
  if (allPostsCache.length === 0) {
    postsContainer.innerHTML = '<p class="text-gray-500 text-sm">まだ書き込みがありません。</p>';
    inThreadSearchInfo.classList.remove('show');
    return;
  }

  const inThreadTokens = tokenizeQuery(inThreadSearchQuery);
  const hasSearch = inThreadTokens.length > 0;

  let visibleIds = null;
  if (hasSearch) {
    const matched = new Set();
    allPostsCache.forEach(p => {
      const text = p.contentText || stripRichHtml(p.content || '');
      if (matchesAllTokens(text, inThreadTokens)) matched.add(p.id);
    });
    visibleIds = new Set();
    const byId = new Map(allPostsCache.map(p => [p.id, p]));
    matched.forEach(id => {
      let cur = byId.get(id);
      while (cur) {
        visibleIds.add(cur.id);
        if (!cur.parentId) break;
        cur = byId.get(cur.parentId);
      }
    });
    inThreadSearchInfo.classList.add('show');
    inThreadSearchInfo.innerHTML = `「${escapeHtml(inThreadSearchQuery)}」 の検索結果: <strong>${matched.size}</strong> 件のレスがヒット`;
  } else {
    inThreadSearchInfo.classList.remove('show');
  }

  const childrenMap = new Map();
  const rootPosts = [];
  const keySet = new Set(allPostsCache.map(p => p.id));
  allPostsCache.forEach(p => {
    let pid = p.parentId || null;
    if (pid && !keySet.has(pid)) pid = null;
    if (pid === null) rootPosts.push(p);
    else {
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid).push(p);
    }
  });

  const frag = document.createDocumentFragment();
  const rootsToRender = visibleIds ? rootPosts.filter(p => visibleIds.has(p.id)) : rootPosts;
  const childMapToUse = visibleIds
    ? new Map([...childrenMap].map(([pid, ch]) => [pid, ch.filter(c => visibleIds.has(c.id))]).filter(([, ch]) => ch.length))
    : childrenMap;

  rootsToRender.forEach(p => frag.appendChild(renderPostTree(p, childMapToUse)));
  postsContainer.appendChild(frag);

  if (activeEditPostId && keySet.has(activeEditPostId)) openEditBox(activeEditPostId);
  else activeEditPostId = null;
  if (activeReplyParentId && keySet.has(activeReplyParentId)) openReplyBox(activeReplyParentId);
  else activeReplyParentId = null;
}

function renderPostTree(post, childrenMap) {
  const wrap = document.createElement('div');
  wrap.className = 'post-tree';
  wrap.dataset.postKey = post.id;
  const number = postNumberMap.get(post.id) || '?';
  let date = '送信中...';
  if (post.createdAt) { try { date = new Date(post.createdAt).toLocaleString('ja-JP'); } catch (e) {} }

  let editedMark = '';
  if (post.editedAt) {
    const ed = (() => { try { return new Date(post.editedAt).toLocaleString('ja-JP'); } catch (e) { return '不明'; } })();
    editedMark = `<span class="edited-mark" title="編集日時: ${escapeHtml(ed)}">✏️ 編集済み</span>`;
  }
  const roleBadgeHtml = buildPostRoleBadge(post);
  const customBadgeHtml = buildPostCustomBadge(post);
  const officialBadgeHtml = buildOfficialBadge(post);
  const isBannedPost = isPostBanned(post);
  const bannedMark = isBannedPost ? `<span class="banned-mark">BAN中</span>` : '';
  const displayName = resolveDisplayName(post);
  const adminInfo = canViewEmail() ? `<span class="admin-email">${escapeHtml(post.authorEmail || 'メール不明')}</span>` : '';

  let replyLabel = '';
  if (post.parentId && postNumberMap.has(post.parentId)) {
    replyLabel = `<span class="reply-target-label">↩ >>${postNumberMap.get(post.parentId)}</span>`;
  }
  const fileHtml = post.file ? buildFileHtml(post.file) : '';

  let contentHtml = '';
  if (post.content) {
    if (/<span|<br|<a\s/i.test(post.content)) contentHtml = renderRichContent(post.content);
    else contentHtml = formatContent(post.content);
  }

  const likes = postLikesCache[post.id] || {};
  const likeCount = Object.keys(likes).length;
  const liked = !!(currentUser && likes[currentUser.uid]);
  const likeBtnHtml = `
    <button class="like-btn ${liked ? 'liked' : ''}" data-like-post-id="${post.id}">
      <span class="like-heart">${liked ? '❤' : '🤍'}</span> <span class="like-count">${likeCount}</span>
    </button>`;

  const isMyPost = !!(currentUser && post.authorUid === currentUser.uid);
  const editBtnHtml = isMyPost ? `<button class="edit-btn" data-edit-post-id="${post.id}">編集</button>` : '';

  const postDiv = document.createElement('div');
  postDiv.className = 'post-card' + (isBannedPost ? ' banned-post' : '');
  postDiv.innerHTML = `
    <div class="font-bold text-gray-700 mb-1 flex flex-wrap items-baseline gap-x-1 items-center">
      <span class="post-number">${number}</span><span>：</span>
      <span class="post-author">${escapeHtml(displayName)}</span>
      ${officialBadgeHtml}${roleBadgeHtml}${customBadgeHtml}${bannedMark}<span>：</span>
      <span class="text-gray-500 text-xs font-normal">${date}</span>
      ${editedMark}
      ${adminInfo}
      <span class="ml-auto flex gap-1 items-center flex-wrap">
        ${likeBtnHtml}
        ${editBtnHtml}
        <button class="reply-btn" data-reply-key="${post.id}">返信</button>
        ${canDelete() ? `<button class="delete-btn" data-post-key="${post.id}">削除</button>` : ''}
      </span>
    </div>
    ${post.content ? `<div class="text-gray-900 rich-content mb-1">${contentHtml}</div>` : ''}
    ${fileHtml}
    ${replyLabel ? `<div class="mt-1">${replyLabel}</div>` : ''}
  `;

  const rbtn = postDiv.querySelector('.reply-btn');
  if (rbtn) rbtn.addEventListener('click', () => onReplyClick(post.id));
  if (canDelete()) {
    const dbtn = postDiv.querySelector('.delete-btn');
    if (dbtn) dbtn.addEventListener('click', () => deletePost(post.id, postNumberMap.get(post.id)));
  }
  const likeBtn = postDiv.querySelector('.like-btn');
  if (likeBtn) {
    likeBtn.addEventListener('click', async () => {
      if (!currentUser) { alert('ログインが必要です。'); return; }
      if (likeBtn.disabled) return;
      likeBtn.disabled = true;
      try { await togglePostLike(post.id); }
      catch (err) { showBanner('いいねに失敗: ' + (err.code || err.message), true); }
      finally { likeBtn.disabled = false; }
    });
  }
  const editBtn = postDiv.querySelector('.edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => onEditClick(post.id));

  wrap.appendChild(postDiv);
  const children = childrenMap.get(post.id) || [];
  if (children.length > 0) {
    const childWrap = document.createElement('div');
    childWrap.className = 'post-children';
    children.forEach(c => childWrap.appendChild(renderPostTree(c, childrenMap)));
    wrap.appendChild(childWrap);
  }
  return wrap;
}

// ---------------- いいね ----------------
async function togglePostLike(postId) {
  if (!currentUser) throw new Error('ログインが必要です');
  const likesRef = doc(db, COL.threads, threadId, 'postLikes', postId);
  const snap = await getDoc(likesRef);
  const data = snap.exists() ? (snap.data() || {}) : {};
  if (data[currentUser.uid]) {
    delete data[currentUser.uid];
    if (Object.keys(data).length === 0) await deleteDoc(likesRef);
    else await setDoc(likesRef, data);
    showBanner('いいねを取り消しました', false);
  } else {
    data[currentUser.uid] = Date.now();
    await setDoc(likesRef, data);
    showBanner('いいねしました', false);
  }
}
function updateThreadLikeButton() {
  if (!threadId || !threadLikeBtn) return;
  const likes = threadLikesCache[threadId] || {};
  const count = Object.keys(likes).length;
  const liked = !!(currentUser && likes[currentUser.uid]);
  threadLikeBtn.classList.toggle('liked', liked);
  threadLikeBtn.innerHTML = `<span class="like-heart">${liked ? '❤' : '🤍'}</span><span class="like-count">${count}</span>`;
}
function setupLikeButton() {
  threadLikeBtn.addEventListener('click', async () => {
    if (!currentUser) { alert('ログインが必要です。'); return; }
    if (threadLikeBtn.disabled) return;
    threadLikeBtn.disabled = true;
    try {
      const likesRef = doc(db, COL.threadLikes, threadId);
      const snap = await getDoc(likesRef);
      const data = snap.exists() ? (snap.data() || {}) : {};
      if (data[currentUser.uid]) {
        delete data[currentUser.uid];
        if (Object.keys(data).length === 0) await deleteDoc(likesRef);
        else await setDoc(likesRef, data);
        showBanner('いいねを取り消しました', false);
      } else {
        data[currentUser.uid] = Date.now();
        await setDoc(likesRef, data);
        showBanner('いいねしました', false);
      }
    } catch (err) { showBanner('いいね失敗', true); }
    finally { threadLikeBtn.disabled = false; }
  });
}

// ---------------- レス投稿 ----------------
function setupFileInput() {
  $('fileInput').addEventListener('change', async () => {
    const file = $('fileInput').files[0];
    const box = $('postPreviewBox');
    const img = $('postPreviewImg');
    const info = $('postPreviewInfo');
    if (!file) { box.classList.remove('show'); return; }
    try {
      const r = await fileToBase64Image(file);
      img.src = r.dataUrl;
      info.textContent = `${file.name}（${r.width}×${r.height}, ${formatSize(r.size)}）`;
      box.classList.add('show');
    } catch (err) { alert(err.message); $('fileInput').value = ''; box.classList.remove('show'); }
  });
}
function setupPostForm() {
  $('postForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) { alert('ログインが必要です。'); return; }
    const contentHtml = getEditorHtml($('postEditorWrap'));
    const contentText = getEditorText($('postEditorWrap'));
    const file = $('fileInput').files[0];
    const submitBtn = $('submitBtn');
    if (!contentText && !file) { alert('コメントまたは画像を指定してください。'); return; }
    submitBtn.disabled = true; submitBtn.innerText = file ? '画像処理中...' : '送信中...';
    try {
      let fileData = null;
      if (file) fileData = await fileToBase64Image(file);
      const now = Date.now();
      await addDoc(collection(db, COL.threads, threadId, 'posts'), {
        author: '名無しさん', content: contentHtml || '', contentText: contentText || '',
        createdAt: now, authorEmail: currentUser.email, authorUid: currentUser.uid,
        authorRole: userRole || null, badgeVisible: myBadgePublic,
        parentId: null, file: fileData, editedAt: null
      });
      const threadRef = doc(db, COL.threads, threadId);
      const snap = await getDoc(threadRef);
      if (snap.exists()) {
        await updateDoc(threadRef, { lastPostAt: now, postCount: (snap.data().postCount || 0) + 1 });
      }
      $('postForm').reset();
      $('postPreviewBox').classList.remove('show');
      clearEditor($('postEditorWrap'));
      markThreadAsRead();
      showBanner('書き込みました', false);
    } catch (err) {
      console.error(err);
      showBanner('保存失敗: ' + (err.code || err.message), true);
    } finally {
      submitBtn.disabled = false; submitBtn.innerText = '書き込む';
    }
  });
}

// ---------------- 返信 ----------------
function onReplyClick(parentId) {
  if (!currentUser) { alert('ログインが必要です。'); return; }
  if (activeReplyParentId === parentId) { closeReplyBox(); return; }
  closeEditBox();
  activeReplyParentId = parentId;
  openReplyBox(parentId);
}
function openReplyBox(parentId) {
  document.querySelectorAll('.inline-reply-box').forEach(el => el.remove());
  const targetWrap = postsContainer.querySelector(`.post-tree[data-post-key="${parentId}"]`);
  if (!targetWrap) return;
  const targetCard = targetWrap.querySelector('.post-card');
  if (!targetCard) return;
  const parentNum = postNumberMap.get(parentId) || '?';
  const box = document.createElement('div');
  box.className = 'inline-reply-box';
  box.innerHTML = `
    <div class="reply-target-label">>>${parentNum} への返信</div>
    <div class="reply-editor-wrap"></div>
    <div class="mt-2">
      <label class="block text-xs text-gray-600 mb-1">画像を添付（任意）:</label>
      <input type="file" class="reply-file text-xs text-gray-600 w-full" accept="image/*">
      <div class="preview-box reply-preview">
        <img class="reply-preview-img" alt="プレビュー">
        <div class="preview-info reply-preview-info"></div>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-2">
      <button class="reply-cancel-btn">キャンセル</button>
      <button class="reply-send-btn bg-blue-800 hover:bg-blue-900 text-white text-xs py-1.5 px-4 rounded">返信する</button>
    </div>`;
  targetCard.insertAdjacentElement('afterend', box);
  const replyEditorWrap = box.querySelector('.reply-editor-wrap');
  createRichEditor(replyEditorWrap, '返信を入力');
  const fileInp = box.querySelector('.reply-file');
  const cancelBtn = box.querySelector('.reply-cancel-btn');
  const sendBtn = box.querySelector('.reply-send-btn');
  const previewBox = box.querySelector('.reply-preview');
  const previewImg = box.querySelector('.reply-preview-img');
  const previewInfo = box.querySelector('.reply-preview-info');

  fileInp.addEventListener('change', async () => {
    const f = fileInp.files[0];
    if (!f) { previewBox.classList.remove('show'); return; }
    try {
      const r = await fileToBase64Image(f);
      previewImg.src = r.dataUrl;
      previewInfo.textContent = `${f.name}（${r.width}×${r.height}, ${formatSize(r.size)}）`;
      previewBox.classList.add('show');
    } catch (err) { alert(err.message); fileInp.value = ''; previewBox.classList.remove('show'); }
  });
  cancelBtn.addEventListener('click', () => { activeReplyParentId = null; box.remove(); });
  sendBtn.addEventListener('click', async () => {
    const contentHtml = getEditorHtml(replyEditorWrap);
    const contentText = getEditorText(replyEditorWrap);
    const file = fileInp.files[0];
    if (!contentText && !file) { alert('返信内容または画像を指定してください。'); return; }
    sendBtn.disabled = true; sendBtn.textContent = '送信中...';
    try {
      let fileData = null;
      if (file) fileData = await fileToBase64Image(file);
      const now = Date.now();
      await addDoc(collection(db, COL.threads, threadId, 'posts'), {
        author: '名無しさん', content: contentHtml || '', contentText: contentText || '',
        createdAt: now, authorEmail: currentUser.email, authorUid: currentUser.uid,
        authorRole: userRole || null, badgeVisible: myBadgePublic,
        parentId, file: fileData, editedAt: null
      });
      const threadRef = doc(db, COL.threads, threadId);
      const snap = await getDoc(threadRef);
      if (snap.exists()) {
        await updateDoc(threadRef, { lastPostAt: now, postCount: (snap.data().postCount || 0) + 1 });
      }
      activeReplyParentId = null;
      box.remove();
      showBanner('返信しました', false);
    } catch (err) {
      console.error(err);
      sendBtn.disabled = false; sendBtn.textContent = '返信する';
    }
  });
}
function closeReplyBox() {
  activeReplyParentId = null;
  document.querySelectorAll('.inline-reply-box').forEach(el => el.remove());
}

// ---------------- 編集 ----------------
function onEditClick(postId) {
  if (!currentUser) { alert('ログインが必要です。'); return; }
  const post = allPostsCache.find(p => p.id === postId);
  if (!post) return;
  if (!post.authorUid || post.authorUid !== currentUser.uid) { alert('自分の投稿のみ編集できます。'); return; }
  if (activeEditPostId === postId) { closeEditBox(); return; }
  closeReplyBox();
  activeEditPostId = postId;
  openEditBox(postId);
}
function openEditBox(postId) {
  document.querySelectorAll('.inline-edit-box').forEach(el => el.remove());
  const post = allPostsCache.find(p => p.id === postId);
  if (!post) return;
  const targetWrap = postsContainer.querySelector(`.post-tree[data-post-key="${postId}"]`);
  if (!targetWrap) return;
  const targetCard = targetWrap.querySelector('.post-card');
  if (!targetCard) return;
  const box = document.createElement('div');
  box.className = 'inline-edit-box';
  box.innerHTML = `
    <div class="reply-target-label">レス #${postNumberMap.get(postId) || '?'} を編集中</div>
    <div class="edit-editor-wrap"></div>
    <div class="edit-actions">
      <button class="reply-cancel-btn edit-cancel-btn">キャンセル</button>
      <button class="edit-save-btn">上書き保存</button>
    </div>`;
  targetCard.insertAdjacentElement('afterend', box);
  const editEditorWrap = box.querySelector('.edit-editor-wrap');
  createRichEditor(editEditorWrap, '編集内容を入力', post.content || '');
  const cancelBtn = box.querySelector('.edit-cancel-btn');
  const saveBtn = box.querySelector('.edit-save-btn');
  cancelBtn.addEventListener('click', () => { activeEditPostId = null; box.remove(); });
  saveBtn.addEventListener('click', async () => {
    if (!currentUser) return;
    const newHtml = getEditorHtml(editEditorWrap);
    const newText = getEditorText(editEditorWrap);
    saveBtn.disabled = true; saveBtn.textContent = '保存中...';
    try {
      await updateDoc(doc(db, COL.threads, threadId, 'posts', postId), {
        content: newHtml || '', contentText: newText || '',
        editedAt: Date.now(), editedBy: currentUser.email
      });
      showBanner('編集しました', false);
      activeEditPostId = null;
      box.remove();
    } catch (err) {
      showBanner('編集失敗: ' + (err.code || err.message), true);
      saveBtn.disabled = false; saveBtn.textContent = '上書き保存';
    }
  });
}
function closeEditBox() {
  activeEditPostId = null;
  document.querySelectorAll('.inline-edit-box').forEach(el => el.remove());
}

// ---------------- 削除 ----------------
async function deletePost(postId, index) {
  if (!canDelete()) { alert('削除権限がありません。'); return; }
  const hasChildren = allPostsCache.some(p => p.parentId === postId);
  const msg = hasChildren
    ? `レス #${index} を削除しますか？\n※ このレスへの返信もすべて削除されます。`
    : `レス #${index} を削除しますか？`;
  if (!confirm(msg)) return;
  try {
    const toDelete = [postId, ...collectDescendants(postId)];
    const batch = writeBatch(db);
    toDelete.forEach(id => {
      batch.delete(doc(db, COL.threads, threadId, 'posts', id));
      batch.delete(doc(db, COL.threads, threadId, 'postLikes', id));
    });
    await batch.commit();
    const threadRef = doc(db, COL.threads, threadId);
    const snap = await getDoc(threadRef);
    if (snap.exists()) {
      const newCount = Math.max(0, (snap.data().postCount || 0) - toDelete.length);
      await updateDoc(threadRef, { postCount: newCount });
    }
    showBanner('削除しました', false);
  } catch (err) {
    showBanner('削除失敗: ' + (err.code || err.message), true);
  }
}
function collectDescendants(parentKey) {
  const result = [];
  const stack = [parentKey];
  while (stack.length) {
    const cur = stack.pop();
    allPostsCache.forEach(p => {
      if (p.parentId === cur) { result.push(p.id); stack.push(p.id); }
    });
  }
  return result;
}

// ---------------- スレッド削除 ----------------
function setupDeleteThreadBtn() {
  const btn = $('deleteThreadBtn');
  if (canDelete()) btn.classList.remove('hidden');
  btn.addEventListener('click', async () => {
    if (!canDelete()) { alert('削除権限がありません。'); return; }
    if (!confirm('このスレッドをすべてのレスごと削除しますか？\nこの操作は取り消せません。')) return;
    try {
      const postsSnap = await getDocs(collection(db, COL.threads, threadId, 'posts'));
      const batch = writeBatch(db);
      postsSnap.forEach(d => batch.delete(d.ref));
      const plSnap = await getDocs(collection(db, COL.threads, threadId, 'postLikes'));
      plSnap.forEach(d => batch.delete(d.ref));
      batch.delete(doc(db, COL.threadLikes, threadId));
      batch.delete(doc(db, COL.threads, threadId));
      await batch.commit();
      delete readThreads[threadId];
      if (currentUser) saveReadThreads(currentUser.uid, readThreads);
      showBanner('スレッドを削除しました', false);
      setTimeout(() => location.href = 'index.html', 800);
    } catch (err) {
      showBanner('削除失敗: ' + (err.code || err.message), true);
    }
  });
}

// ---------------- クリーンアップ ----------------
function cleanupAll() {
  [postsUnsubscribe, postLikesUnsubscribe, threadLikesUnsubscribe,
   nicknamesUnsubscribe, badgesUnsubscribe, officialUnsubscribe,
   bannedUsersUnsubscribe, threadDocUnsubscribe]
   .forEach(un => { if (un) un(); });
}
window.addEventListener('beforeunload', cleanupAll);
