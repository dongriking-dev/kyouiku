// ============================================================
// list.js — スレッド一覧ページ専用
// ============================================================
import {
  db, auth, provider, COL, SUBJECTS, getSubjectInfo, subjectBadgeHtml,
  roleFromEmail, escapeHtml, showBanner, fileToBase64Image, formatSize,
  createRichEditor, getEditorHtml, getEditorText, clearEditor,
  tokenizeQuery, matchesAllTokens,
  loadBadgeVisibility, loadSubjectFilter, saveSubjectFilter,
  loadNewMarkSetting, loadReadThreads, saveReadThreads
} from './common.js';

import {
  collection, doc, addDoc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ---------------- グローバル状態 ----------------
let currentUser = null;
let userRole = null;
let allThreadsCache = [];
let threadLikesCache = {};
let announcementsCache = [];
let currentSubjectFilter = 'all';
let currentSearchQuery = '';
let selectedSubjectForNewThread = '';
let newMarkEnabled = true;
let readThreads = {};
let customBadgesCache = {};
let officialUsersCache = {};
let nicknamesCache = {};
let myBadgePublic = true;

let threadsUnsubscribe = null;
let threadLikesUnsubscribe = null;
let announcementsUnsubscribe = null;
let badgesUnsubscribe = null;
let officialUnsubscribe = null;
let nicknamesUnsubscribe = null;

let intentionalSignOut = false;
let initialAuthCheckDone = false;

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const loginView = $('loginView');
const mainView = $('mainView');
const threadsContainer = $('threadsContainer');
const connDot = $('connDot');
const connText = $('connText');
const bootOverlay = $('bootOverlay');
const searchInput = $('searchInput');
const searchClearBtn = $('searchClearBtn');
const searchResultInfo = $('searchResultInfo');

// ---------------- 権限 ----------------
function canAnnounce() { return userRole === 'admin' || userRole === 'owner'; }
function canViewUserList() { return userRole === 'admin' || userRole === 'owner'; }

// ---------------- 接続表示 ----------------
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

// ---------------- ルール折りたたみ ----------------
(function initSiteRules() {
  const rulesEl = $('siteRules');
  const toggleBtn = $('rulesToggleBtn');
  const iconEl = $('rulesToggleIcon');
  if (!rulesEl || !toggleBtn) return;
  rulesEl.classList.add('collapsed');
  if (iconEl) iconEl.textContent = '▶';
  toggleBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    const nowCollapsed = rulesEl.classList.toggle('collapsed');
    if (iconEl) iconEl.textContent = nowCollapsed ? '▶' : '▼';
  });
})();

// ---------------- エディタ ----------------
createRichEditor($('firstPostEditorWrap'), '最初の書き込み内容（質問内容など・任意）');

// ---------------- ログイン ----------------
$('googleLoginBtn').addEventListener('click', async () => {
  try { await signInWithPopup(auth, provider); }
  catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') alert("ログインに失敗しました: " + (err.message || ''));
  }
});

$('logoutBtn').addEventListener('click', async () => {
  intentionalSignOut = true;
  [threadsUnsubscribe, threadLikesUnsubscribe, announcementsUnsubscribe,
   badgesUnsubscribe, officialUnsubscribe, nicknamesUnsubscribe]
   .forEach(un => { if (un) un(); });
  try { await signOut(auth); } catch (e) {}
  showLoginView(); hideBootOverlay();
  setTimeout(() => { intentionalSignOut = false; initialAuthCheckDone = false; }, 500);
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
  if (intentionalSignOut) { currentUser = null; userRole = null; return; }
  currentUser = user;
  if (!user) {
    userRole = null;
    if (!initialAuthCheckDone) { trySilentSignIn(); return; }
    hideBootOverlay(); showLoginView();
    return;
  }
  userRole = roleFromEmail(user.email);
  myBadgePublic = loadBadgeVisibility(user.email);
  newMarkEnabled = loadNewMarkSetting(user.uid);
  readThreads = loadReadThreads(user.uid);

  initThreadsListener();
  initThreadLikesListener();
  initAnnouncementsListener();
  initBadgesListener();
  initOfficialListener();
  initNicknamesListener();

  await registerMyFingerprint();
  renderRoleBadge(userRole);
  updateAdminControlsVisibility();
  updateMyNicknameBtn();
  updateMyOfficialBadge();

  hideBootOverlay();
  showMainView();
  setConnection(navigator.onLine);
  currentSubjectFilter = loadSubjectFilter();
  setupSubjectTabs();
  setupSubjectSelectUI();
  setupSearchEvents();
  setupNicknameBtn();
  setupLogoutBtn();
  setupAnnouncementBtn();
  setupUserListBtn();
  setupCreateThreadForm();
  setupFileInput();
});

function registerMyFingerprint() {
  if (!currentUser) return;
  const now = Date.now();
  const ref = doc(db, COL.knownUsers, currentUser.uid);
  return getDoc(ref).then(snap => {
    const ex = snap.exists() ? snap.data() : null;
    return setDoc(ref, {
      email: currentUser.email || '',
      displayName: currentUser.displayName || '',
      lastSeen: now,
      firstSeen: ex?.firstSeen || now,
      role: userRole || null
    }, { merge: true });
  }).catch(e => console.warn('knownUsers 登録スキップ:', e.message));
}

function renderRoleBadge(role) {
  const c = $('roleBadgeContainer');
  c.innerHTML = '';
  if (role === 'admin') c.innerHTML = '<span class="admin-badge">管理者</span>';
  else if (role === 'owner') c.innerHTML = '<span class="owner-badge">主</span>';
  else if (role === 'vip') c.innerHTML = '<span class="vip-badge">VIP</span>';
}
function updateMyOfficialBadge() {
  const el = $('officialMeBadge');
  if (!el) return;
  if (currentUser && officialUsersCache[currentUser.uid]?.official) {
    const note = officialUsersCache[currentUser.uid].note || '';
    el.innerHTML = `<span class="official-badge" title="${escapeHtml(note || '公式アカウント')}">✓</span>`;
  } else el.innerHTML = '';
}
function updateMyNicknameBtn() {
  const btn = $('myNicknameBtn');
  if (!btn) return;
  if (!currentUser) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  const n = nicknamesCache[currentUser.uid];
  const nickname = n?.nickname || '';
  if (nickname) {
    btn.textContent = `🏷️ ${nickname}`;
    btn.classList.remove('unset');
    btn.title = `現在のニックネーム: ${nickname}（クリックで変更）`;
  } else {
    btn.textContent = '🏷️ ニックネーム未設定';
    btn.classList.add('unset');
    btn.title = 'クリックしてニックネームを設定';
  }
}
function updateAdminControlsVisibility() {
  const showAnnounce = canAnnounce();
  const showUserList = canViewUserList();
  const ann = $('announcementBtn');
  const ul = $('userListBtn');
  if (ann) ann.classList.toggle('hidden', !showAnnounce);
  if (ul) ul.classList.toggle('hidden', !showUserList);
  const any = showAnnounce || showUserList;
  $('adminControls').classList.toggle('hidden', !any);
}

// ---------------- 監視 ----------------
function initThreadsListener() {
  if (threadsUnsubscribe) threadsUnsubscribe();
  const q = query(collection(db, COL.threads), orderBy('createdAt', 'desc'), limit(100));
  threadsUnsubscribe = onSnapshot(q, (snapshot) => {
    setConnection(true);
    const threads = [];
    snapshot.forEach(d => threads.push({ id: d.id, ...d.data() }));
    allThreadsCache = threads;
    cleanupReadThreads();
    renderThreadList();
  }, (error) => {
    console.error("スレッド一覧エラー:", error);
    setConnection(false);
    threadsContainer.innerHTML = '<p class="text-red-500 text-sm">読み込みに失敗しました。</p>';
    showBanner('読み込み失敗: ' + (error.code || error.message), true);
  });
}
function cleanupReadThreads() {
  if (!currentUser) return;
  const activeIds = new Set(allThreadsCache.map(t => t.id));
  let cleaned = 0;
  Object.keys(readThreads).forEach(tid => {
    if (!activeIds.has(tid)) { delete readThreads[tid]; cleaned++; }
  });
  if (cleaned > 0) saveReadThreads(currentUser.uid, readThreads);
}
function isThreadNew(thread) {
  if (!newMarkEnabled) return false;
  if (!thread || !thread.id) return false;
  const lastRead = readThreads[thread.id] || 0;
  if (!lastRead) return true;
  if ((thread.createdAt || 0) > lastRead) return true;
  if ((thread.lastPostAt || 0) > lastRead) return true;
  return false;
}
function initThreadLikesListener() {
  if (threadLikesUnsubscribe) threadLikesUnsubscribe();
  threadLikesUnsubscribe = onSnapshot(collection(db, COL.threadLikes), (snap) => {
    threadLikesCache = {};
    snap.forEach(d => { threadLikesCache[d.id] = d.data() || {}; });
    renderThreadList();
  }, (err) => console.error('スレッドいいね監視エラー:', err));
}
function initAnnouncementsListener() {
  if (announcementsUnsubscribe) announcementsUnsubscribe();
  const q = query(collection(db, COL.announcements), orderBy('createdAt', 'desc'), limit(20));
  announcementsUnsubscribe = onSnapshot(q, (snap) => {
    announcementsCache = [];
    snap.forEach(d => announcementsCache.push({ id: d.id, ...d.data() }));
    renderAnnouncements();
  }, (err) => console.error('アナウンス監視エラー:', err));
}
function initBadgesListener() {
  if (badgesUnsubscribe) badgesUnsubscribe();
  badgesUnsubscribe = onSnapshot(collection(db, COL.customBadges), (snap) => {
    customBadgesCache = {};
    snap.forEach(d => { customBadgesCache[d.id] = d.data().badges || {}; });
    renderThreadList();
  }, (err) => console.error('バッジ監視エラー:', err));
}
function initOfficialListener() {
  if (officialUnsubscribe) officialUnsubscribe();
  officialUnsubscribe = onSnapshot(collection(db, COL.officialUsers), (snap) => {
    officialUsersCache = {};
    snap.forEach(d => { officialUsersCache[d.id] = d.data(); });
    updateMyOfficialBadge();
    renderThreadList();
  }, (err) => console.error('公式監視エラー:', err));
}
function initNicknamesListener() {
  if (nicknamesUnsubscribe) nicknamesUnsubscribe();
  nicknamesUnsubscribe = onSnapshot(collection(db, COL.nicknames), (snap) => {
    nicknamesCache = {};
    snap.forEach(d => { nicknamesCache[d.id] = d.data(); });
    updateMyNicknameBtn();
    renderThreadList();
  }, (err) => console.error('ニックネーム監視エラー:', err));
}

// ---------------- アナウンス描画 ----------------
function renderAnnouncements() {
  const area = $('announcementArea');
  if (!area) return;
  if (!announcementsCache || announcementsCache.length === 0) {
    area.classList.add('hidden'); area.innerHTML = ''; return;
  }
  area.classList.remove('hidden');
  const sorted = [...announcementsCache].sort((a, b) => {
    const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  let html = '<div class="space-y-2">';
  sorted.forEach(a => {
    const lvl = ['info', 'warning', 'danger'].includes(a.level) ? a.level : 'info';
    const labels = { info: 'お知らせ', warning: '注意', danger: '重要' };
    const date = a.createdAt ? new Date(a.createdAt).toLocaleString('ja-JP') : '';
    html += `<div class="announcement-card level-${lvl}">
      <div class="flex items-center flex-wrap gap-1">
        <span class="announcement-level-chip">${labels[lvl]}</span>
        ${a.pinned ? '<span style="background:#111827;color:#fff;font-size:10px;padding:1px 8px;border-radius:9999px;margin-right:6px;">📌 ピン留め</span>' : ''}
        ${a.title ? `<span class="announcement-title">${escapeHtml(a.title)}</span>` : ''}
      </div>
      <div class="announcement-body">${escapeHtml(a.body || '')}</div>
      <div class="announcement-meta">投稿者: ${escapeHtml(a.authorEmail || '不明')} ／ ${date}</div>
    </div>`;
  });
  html += '</div>';
  area.innerHTML = html;
}

// ---------------- 検索 ----------------
function setupSearchEvents() {
  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      currentSearchQuery = searchInput.value;
      updateSearchClearButton();
      renderThreadList();
    }, 150);
  });
  searchClearBtn.addEventListener('click', () => {
    searchInput.value = ''; currentSearchQuery = '';
    updateSearchClearButton(); renderThreadList(); searchInput.focus();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = ''; currentSearchQuery = '';
      updateSearchClearButton(); renderThreadList();
    }
  });
}
function updateSearchClearButton() {
  searchClearBtn.classList.toggle('show', !!searchInput.value.trim());
}

// ---------------- 教科タブ ----------------
function setupSubjectTabs() {
  const tabs = $('subjectTabs');
  if (!tabs) return;
  tabs.querySelectorAll('.subject-tab').forEach(tab => {
    if (tab.dataset.subject === currentSubjectFilter) tab.classList.add('active');
    else tab.classList.remove('active');
    if (tab.dataset.bound === '1') return;
    tab.dataset.bound = '1';
    tab.addEventListener('click', () => {
      tabs.querySelectorAll('.subject-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSubjectFilter = tab.dataset.subject;
      saveSubjectFilter(currentSubjectFilter);
      renderThreadList();
    });
  });
}
function setupSubjectSelectUI() {
  const container = $('subjectSelectBig');
  if (!container) return;
  container.querySelectorAll('.subject-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.subject-select-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedSubjectForNewThread = btn.dataset.subject;
      $('selectedSubject').value = btn.dataset.subject;
    });
  });
}
function updateSubjectTabCounts() {
  const counts = { all: 0, math: 0, science: 0, social: 0, japanese: 0, english: 0, other: 0 };
  allThreadsCache.forEach(t => {
    counts.all++;
    const s = t.subject && SUBJECTS[t.subject] ? t.subject : 'other';
    counts[s]++;
  });
  $('countAll').textContent = counts.all;
  $('countMath').textContent = counts.math;
  $('countScience').textContent = counts.science;
  $('countSocial').textContent = counts.social;
  $('countJapanese').textContent = counts.japanese;
  $('countEnglish').textContent = counts.english;
  $('countOther').textContent = counts.other;
}

// ---------------- 一覧描画 ----------------
function renderThreadList() {
  threadsContainer.innerHTML = '';
  let threads = allThreadsCache;
  if (currentSubjectFilter !== 'all') {
    threads = threads.filter(t => {
      const s = t.subject && SUBJECTS[t.subject] ? t.subject : 'other';
      return s === currentSubjectFilter;
    });
  }
  const tokens = tokenizeQuery(currentSearchQuery);
  searchResultInfo.classList.toggle('show', tokens.length > 0);

  let results = [];
  if (tokens.length > 0) {
    results = threads
      .map(t => {
        const combined = `${t.title || ''} ${getSubjectInfo(t.subject).label}`;
        if (!matchesAllTokens(combined, tokens)) return null;
        return { thread: t };
      })
      .filter(Boolean);
    searchResultInfo.innerHTML = `「${escapeHtml(currentSearchQuery)}」 の検索結果: <strong>${results.length}</strong> 件`;
  } else {
    results = threads.map(t => ({ thread: t }));
  }

  if (results.length === 0) {
    threadsContainer.innerHTML = tokens.length > 0
      ? `<p class="text-gray-500 text-sm">「${escapeHtml(currentSearchQuery)}」に一致するスレッドがありません。</p>`
      : '<p class="text-gray-500 text-sm">該当するスレッドがありません。新しく作成してください。</p>';
    updateSubjectTabCounts();
    return;
  }

  const frag = document.createDocumentFragment();
  results.forEach(({ thread }) => {
    let date = '日時不明';
    if (thread.createdAt) { try { date = new Date(thread.createdAt).toLocaleString('ja-JP'); } catch (e) {} }
    const subjHtml = subjectBadgeHtml(thread.subject);
    const hasNew = isThreadNew(thread);
    const likes = threadLikesCache[thread.id] || {};
    const likeCount = Object.keys(likes).length;
    const likeCountHtml = likeCount > 0
      ? `<span class="thread-like-count-inline">❤ ${likeCount}</span>` : '';
    const totalPosts = thread.postCount || 0;
    const unreadCount = hasNew ? Math.max(1, totalPosts) : 0;
    const unreadBadge = (hasNew && unreadCount > 1)
      ? `<span class="unread-badge">新着 ${unreadCount}件</span>` : '';

    const item = document.createElement('a');
    item.href = `thread.html?id=${encodeURIComponent(thread.id)}`;
    item.className = 'thread-item bg-white p-3 border border-gray-300 rounded hover:bg-blue-50 cursor-pointer transition flex justify-between items-center shadow-sm'
      + (hasNew ? ' has-new' : '');
    item.dataset.threadId = thread.id;
    item.innerHTML = `
      ${hasNew ? '<span class="new-mark"></span>' : ''}
      <div class="flex-1 min-w-0" style="padding-left: ${hasNew ? '16px' : '0'};">
        ${subjHtml}
        <span class="font-bold text-blue-900 break-words">${escapeHtml(thread.title)}</span>
        <span class="text-xs text-gray-400 ml-2 whitespace-nowrap">(${date})</span>
        ${likeCountHtml}
        ${unreadBadge}
      </div>
      <span class="text-xs bg-gray-200 text-gray-700 px-2 py-1 rounded-full ml-2 whitespace-nowrap">開く</span>`;
    frag.appendChild(item);
  });
  threadsContainer.appendChild(frag);
  updateSubjectTabCounts();
}

// ---------------- スレッド作成 ----------------
function setupCreateThreadForm() {
  $('createThreadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) { alert('ログインが必要です。'); return; }
    const subject = $('selectedSubject').value;
    const title = $('threadTitle').value.trim();
    const contentHtml = getEditorHtml($('firstPostEditorWrap'));
    const contentText = getEditorText($('firstPostEditorWrap'));
    const file = $('threadFileInput').files[0];
    const btn = $('createThreadBtn');
    if (!subject) { alert('教科を選択してください。'); return; }
    if (!title) { alert('タイトルを入力してください。'); return; }
    btn.disabled = true; btn.innerText = '作成中...';
    try {
      let fileData = null;
      if (file) fileData = await fileToBase64Image(file);
      const now = Date.now();
      const threadRef = await addDoc(collection(db, COL.threads), {
        title, subject, createdAt: now, lastPostAt: now,
        postCount: (contentText || fileData) ? 1 : 0,
        authorEmail: currentUser.email, authorUid: currentUser.uid, authorRole: userRole || null
      });
      if (contentText || fileData) {
        await addDoc(collection(db, COL.threads, threadRef.id, 'posts'), {
          author: '名無しさん', content: contentHtml || '', contentText: contentText || '',
          createdAt: now, authorEmail: currentUser.email, authorUid: currentUser.uid,
          authorRole: userRole || null, badgeVisible: myBadgePublic,
          parentId: null, file: fileData, editedAt: null
        });
      }
      $('createThreadForm').reset();
      $('threadPreviewBox').classList.remove('show');
      clearEditor($('firstPostEditorWrap'));
      document.querySelectorAll('#subjectSelectBig .subject-select-btn').forEach(b => b.classList.remove('selected'));
      $('selectedSubject').value = '';
      selectedSubjectForNewThread = '';
      showBanner('スレッドを作成しました', false);
      setTimeout(() => { location.href = `thread.html?id=${encodeURIComponent(threadRef.id)}`; }, 400);
    } catch (err) {
      console.error(err);
      showBanner('保存失敗: ' + (err.code || err.message), true);
    } finally {
      btn.disabled = false; btn.innerText = 'スレッドを立てる';
    }
  });
}

function setupFileInput() {
  $('threadFileInput').addEventListener('change', async () => {
    const file = $('threadFileInput').files[0];
    const box = $('threadPreviewBox');
    const img = $('threadPreviewImg');
    const info = $('threadPreviewInfo');
    if (!file) { box.classList.remove('show'); return; }
    try {
      const r = await fileToBase64Image(file);
      img.src = r.dataUrl;
      info.textContent = `${file.name}（${r.width}×${r.height}, ${formatSize(r.size)}）`;
      box.classList.add('show');
    } catch (err) { alert(err.message); $('threadFileInput').value = ''; box.classList.remove('show'); }
  });
}

// ---------------- ボタン設定 ----------------
function setupNicknameBtn() {
  $('myNicknameBtn').addEventListener('click', () => {
    if (!currentUser) { alert('ログインが必要です。'); return; }
    const n = nicknamesCache[currentUser.uid];
    const current = n?.nickname || '';
    const input = prompt('ニックネームを入力してください（最大20文字）:\n空欄で削除します。', current);
    if (input === null) return;
    const nickname = input.trim();
    if (nickname.length > 20) { alert('20文字以内で入力してください。'); return; }
    if (!nickname) {
      if (!confirm('ニックネームを削除しますか？')) return;
      deleteDoc(doc(db, COL.nicknames, currentUser.uid))
        .then(() => showBanner('ニックネームを削除しました', false))
        .catch(err => showBanner('削除失敗: ' + (err.code || err.message), true));
      return;
    }
    setDoc(doc(db, COL.nicknames, currentUser.uid), {
      nickname, email: currentUser.email,
      updatedAt: Date.now(), updatedBy: currentUser.email, selfSet: true
    })
      .then(() => showBanner('ニックネームを保存しました', false))
      .catch(err => showBanner('保存失敗: ' + (err.code || err.message), true));
  });
}
function setupLogoutBtn() {
  // onAuthStateChanged 内で既に紐付け済みなので何もしない
}
function setupAnnouncementBtn() {
  $('announcementBtn').addEventListener('click', async () => {
    if (!canAnnounce()) { alert('権限がありません。'); return; }
    const title = prompt('タイトル（任意）:') || '';
    const body = prompt('本文（必須）:');
    if (!body) return;
    const level = prompt('重要度 (info/warning/danger):', 'info') || 'info';
    const pinned = confirm('ピン留めしますか？');
    try {
      await addDoc(collection(db, COL.announcements), {
        title, body, level, pinned,
        createdAt: Date.now(),
        authorEmail: currentUser.email,
        authorUid: currentUser.uid
      });
      showBanner('アナウンスを投稿しました', false);
    } catch (err) {
      showBanner('投稿失敗: ' + (err.code || err.message), true);
    }
  });
}
function setupUserListBtn() {
  $('userListBtn').addEventListener('click', () => {
    alert('ユーザー一覧機能は今後のバージョンで追加予定です。\n（必要なら thread.js 側と統合します）');
  });
}

// ---------------- 離脱時 ----------------
window.addEventListener('beforeunload', () => {
  [threadsUnsubscribe, threadLikesUnsubscribe, announcementsUnsubscribe,
   badgesUnsubscribe, officialUnsubscribe, nicknamesUnsubscribe]
   .forEach(un => { if (un) un(); });
});
