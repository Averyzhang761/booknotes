const bridgePrefsKey = "booknotes-bridge-v1";
const config = window.READING_NOTES_CONFIG || {};
const canUseSupabase = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
const db = canUseSupabase ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

let session = null;
let books = [];
let notes = [];
let currentBookId = null;
let view = "inbox";
let localState = loadLocalState();
let toastTimer;

const bridgeStatus = document.querySelector("#bridgeStatus");
const bridgeAuth = document.querySelector("#bridgeAuth");
const bridgeAuthStatus = document.querySelector("#bridgeAuthStatus");
const bridgeGoogle = document.querySelector("#bridgeGoogle");
const bridgeSignOut = document.querySelector("#bridgeSignOut");
const bridgeSyncStatus = document.querySelector("#bridgeSyncStatus");
const bridgeListTitle = document.querySelector("#bridgeListTitle");
const bridgeList = document.querySelector("#bridgeList");
const bridgeToast = document.querySelector("#bridgeToast");
const bridgeTabs = document.querySelectorAll("[data-bridge-target]");

function loadLocalState() {
  try {
    return JSON.parse(localStorage.getItem(bridgePrefsKey)) || {};
  } catch {
    return {};
  }
}

function saveLocalState() {
  localStorage.setItem(bridgePrefsKey, JSON.stringify(localState));
}

function setItemState(noteId, value) {
  localState[noteId] = value;
  saveLocalState();
  render();
}

function showToast(message) {
  clearTimeout(toastTimer);
  bridgeToast.textContent = message;
  bridgeToast.classList.add("is-visible");
  toastTimer = setTimeout(() => bridgeToast.classList.remove("is-visible"), 1600);
}

async function signInWithGoogle() {
  if (!canUseSupabase) {
    showToast("需要 Supabase 配置");
    return;
  }

  const { error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${location.origin}${location.pathname}` },
  });

  if (error) showToast(error.message);
}

async function signOut() {
  await db.auth.signOut();
  session = null;
  books = [];
  notes = [];
  render();
}

async function loadCloudData() {
  if (!session) {
    render();
    return;
  }

  const [booksResult, notesResult] = await Promise.all([
    db.from("books").select("id,title,author,source,external_id,created_at").order("created_at", { ascending: false }),
    db.from("notes").select("id,book_id,type,text,source,external_id,created_at").order("created_at", { ascending: false }),
  ]);

  if (booksResult.error || notesResult.error) {
    showToast("读取云端失败");
    return;
  }

  books = booksResult.data.map((book) => ({
    id: book.id,
    title: book.title,
    author: book.author || "未填写",
    source: book.source || "manual",
    externalId: book.external_id,
    createdAt: book.created_at,
  }));
  notes = notesResult.data.map((note) => ({
    id: note.id,
    bookId: note.book_id,
    type: note.type,
    text: note.text,
    source: note.source || "manual",
    externalId: note.external_id,
    createdAt: note.created_at,
  }));

  currentBookId = currentBookId || books.find((book) => book.source === "weread")?.id || books[0]?.id || null;
  render();
}

function currentBook() {
  return books.find((book) => book.id === currentBookId) || books[0] || null;
}

async function invokeWeread(body) {
  if (!session) {
    showToast("先登录");
    return null;
  }

  const result = await fetch(`${config.supabaseUrl}/functions/v1/weread-gateway`, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(result);

  if (!result.ok || data?.error) {
    const message = data?.error || data?.msg || data?.message || `微信读书同步失败：HTTP ${result.status}`;
    bridgeSyncStatus.textContent = message;
    showToast(message);
    return null;
  }
  return data;
}

async function readJsonResponse(response) {
  try {
    return await response.clone().json();
  } catch {
    try {
      const text = await response.clone().text();
      return text ? { message: text } : {};
    } catch {
      return {};
    }
  }
}

async function importWereadBooks() {
  bridgeSyncStatus.textContent = "正在同步微信读书笔记本...";
  const data = await invokeWeread({ action: "notebooks", count: 100 });
  if (!data) return;

  const rows = (data.books || []).map((item) => ({
    user_id: session.user.id,
    title: item.book?.title || "未命名",
    author: item.book?.author || "未填写",
    source: "weread",
    external_id: item.bookId,
  }));

  if (!rows.length) {
    bridgeSyncStatus.textContent = "没有可同步的微信读书笔记本";
    return;
  }

  const { error } = await db.from("books").upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) {
    bridgeSyncStatus.textContent = `写入失败: ${error.message}`;
    return;
  }

  await loadCloudData();
  bridgeSyncStatus.textContent = `已同步 ${rows.length} 本有笔记的书`;
}

async function importCurrentBookMarks() {
  const book = currentBook();
  if (!book?.externalId || book.source !== "weread") {
    showToast("先在收件箱选择一本微信读书来源的书");
    return;
  }

  bridgeSyncStatus.textContent = `正在导入《${book.title}》划线...`;
  const data = await invokeWeread({ action: "bookmarks", bookId: book.externalId });
  if (!data) return;

  const rows = (data.updated || [])
    .filter((mark) => mark.markText)
    .map((mark) => ({
      user_id: session.user.id,
      book_id: book.id,
      type: "摘句",
      text: mark.markText,
      source: "weread",
      external_id: mark.bookmarkId,
    }));

  if (!rows.length) {
    bridgeSyncStatus.textContent = "当前书没有可导入划线";
    return;
  }

  const { error } = await db.from("notes").upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) {
    bridgeSyncStatus.textContent = `划线写入失败: ${error.message}`;
    return;
  }

  await loadCloudData();
  bridgeSyncStatus.textContent = `已导入 ${rows.length} 条划线`;
}

async function copyQueue() {
  const queued = visibleNotes("queue");
  if (!queued.length) {
    showToast("待发送为空");
    return;
  }

  const body = queued.map(formatForSuwen).join("\n\n---\n\n");
  await navigator.clipboard.writeText(body);
  showToast("已复制素问格式");
}

function formatForSuwen(note) {
  const book = books.find((item) => item.id === note.bookId);
  return [
    "#读书摘记",
    "",
    `来源：微信读书 / ${book?.title || "未知书籍"}`,
    `作者：${book?.author || "未填写"}`,
    `类型：${note.type}`,
    "",
    note.text,
  ].join("\n");
}

function setBridgeView(nextView) {
  view = nextView;
  bridgeTabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.bridgeTarget === view));
  render();
}

function visibleNotes(targetView = view) {
  if (targetView === "queue") {
    return notes.filter((note) => localState[note.id] === "queue");
  }
  return notes.filter((note) => localState[note.id] !== "ignored" && localState[note.id] !== "sent");
}

function render() {
  bridgeStatus.textContent = session ? `${session.user.email} · ${notes.length} 条` : "未登录";
  bridgeAuthStatus.textContent = session ? "已连接 Supabase" : "登录后读取微信读书同步内容";
  bridgeGoogle.classList.toggle("is-hidden", Boolean(session));
  bridgeSignOut.classList.toggle("is-hidden", !session);
  bridgeListTitle.textContent = view === "queue" ? "待发送" : view === "settings" ? "设置" : "收件箱";

  if (!session) {
    bridgeList.innerHTML = `<div class="empty">先登录，然后同步微信读书笔记本。</div>`;
    return;
  }

  if (view === "settings") {
    renderSettings();
    return;
  }

  renderBridgeList();
}

function renderSettings() {
  const book = currentBook();
  bridgeList.innerHTML = `
    <article class="note-item">
      <div class="note-top">
        <span class="note-type">当前来源书</span>
        <span>${books.length} 本</span>
      </div>
      <div class="note-text">${escapeHtml(book?.title || "无")}</div>
    </article>
    ${books.map((item) => `
      <article class="book-item bridge-book-row">
        <div>
          <div class="book-title">${escapeHtml(item.title)}</div>
          <div class="book-meta">${escapeHtml(item.author)} · ${escapeHtml(item.source)}</div>
        </div>
        <button type="button" data-pick-book="${escapeHtml(item.id)}">${item.id === currentBookId ? "当前" : "选择"}</button>
      </article>
    `).join("")}
  `;
}

function renderBridgeList() {
  const items = visibleNotes();
  if (!items.length) {
    bridgeList.innerHTML = `<div class="empty">${view === "queue" ? "还没有待发送内容。" : "收件箱为空，先同步微信读书。"}</div>`;
    return;
  }

  bridgeList.innerHTML = items.map((note) => {
    const book = books.find((item) => item.id === note.bookId);
    return `
      <article class="note-item bridge-note">
        <div class="note-top">
          <span class="note-type">${escapeHtml(note.type)}</span>
          <span>${escapeHtml(book?.title || "未知书籍")}</span>
        </div>
        <div class="note-text">${escapeHtml(note.text)}</div>
        <div class="bridge-actions">
          <button type="button" data-ignore="${escapeHtml(note.id)}">忽略</button>
          <button type="button" data-queue="${escapeHtml(note.id)}">${localState[note.id] === "queue" ? "已待发" : "待发送"}</button>
          <button type="button" data-copy-one="${escapeHtml(note.id)}">复制</button>
        </div>
      </article>
    `;
  }).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

bridgeTabs.forEach((tab) => {
  tab.addEventListener("click", () => setBridgeView(tab.dataset.bridgeTarget));
});

bridgeList.addEventListener("click", async (event) => {
  const pickBook = event.target.closest("[data-pick-book]");
  if (pickBook) {
    currentBookId = pickBook.dataset.pickBook;
    render();
    return;
  }

  const ignore = event.target.closest("[data-ignore]");
  if (ignore) {
    setItemState(ignore.dataset.ignore, "ignored");
    return;
  }

  const queue = event.target.closest("[data-queue]");
  if (queue) {
    setItemState(queue.dataset.queue, "queue");
    return;
  }

  const copyOne = event.target.closest("[data-copy-one]");
  if (copyOne) {
    const note = notes.find((item) => item.id === copyOne.dataset.copyOne);
    if (!note) return;
    await navigator.clipboard.writeText(formatForSuwen(note));
    localState[note.id] = "sent";
    saveLocalState();
    render();
    showToast("已复制");
  }
});

document.querySelector("#bridgeRefresh").addEventListener("click", loadCloudData);
document.querySelector("#bridgeSettings").addEventListener("click", () => setBridgeView("settings"));
document.querySelector("#bridgeGoogle").addEventListener("click", signInWithGoogle);
document.querySelector("#bridgeSignOut").addEventListener("click", signOut);
document.querySelector("#bridgeImportBooks").addEventListener("click", importWereadBooks);
document.querySelector("#bridgeImportMarks").addEventListener("click", importCurrentBookMarks);
document.querySelector("#bridgeCopyQueue").addEventListener("click", copyQueue);
document.querySelector("#bridgeClearLocal").addEventListener("click", () => {
  localState = {};
  saveLocalState();
  render();
  showToast("已清本地筛选状态");
});

async function init() {
  render();
  if (!canUseSupabase) {
    bridgeAuthStatus.textContent = "需要 Supabase 配置";
    return;
  }

  const url = new URL(location.href);
  if (url.searchParams.has("code")) {
    const { error } = await db.auth.exchangeCodeForSession(location.href);
    if (!error) history.replaceState({}, document.title, `${location.origin}${location.pathname}`);
  }

  const { data } = await db.auth.getSession();
  session = data.session;
  db.auth.onAuthStateChange((_event, nextSession) => {
    session = nextSession;
    loadCloudData();
  });
  await loadCloudData();
}

init();
