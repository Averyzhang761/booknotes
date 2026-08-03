const bridgePrefsKey = "booknotes-bridge-v1";
const config = window.READING_NOTES_CONFIG || {};
const canUseCloud = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
const db = canUseCloud ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

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

function bookStateKey(bookId) {
  return `book:${bookId}`;
}

function noteCountForBook(bookId) {
  return notes.filter((note) => note.bookId === bookId).length;
}

function isBookActive(book) {
  return localState[bookStateKey(book.id)] === "active" || noteCountForBook(book.id) > 0;
}

function isBookIgnored(book) {
  return localState[bookStateKey(book.id)] === "ignored";
}

function showToast(message) {
  clearTimeout(toastTimer);
  bridgeToast.textContent = message;
  bridgeToast.classList.add("is-visible");
  toastTimer = setTimeout(() => bridgeToast.classList.remove("is-visible"), 1600);
}

async function signInWithGoogle() {
  if (!canUseCloud) {
    showToast("云端未配置");
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
  bridgeSyncStatus.textContent = "正在同步有笔记的书...";
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
  bridgeSyncStatus.textContent = `已同步 ${rows.length} 本已发生的书`;
}

async function importWereadShelf() {
  bridgeSyncStatus.textContent = "正在同步微信读书书架候选...";
  const data = await invokeWeread({ action: "shelf" });
  if (!data) return;

  const rows = (data.books || []).map((book) => ({
    user_id: session.user.id,
    title: book.title || "未命名",
    author: book.author || "未填写",
    source: "weread",
    external_id: book.bookId,
  }));

  if (!rows.length) {
    bridgeSyncStatus.textContent = "微信读书书架为空";
    return;
  }

  const { error } = await db.from("books").upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) {
    bridgeSyncStatus.textContent = `候选写入失败: ${error.message}`;
    return;
  }

  await loadCloudData();
  bridgeSyncStatus.textContent = `已同步 ${rows.length} 本候选书`;
}

async function importCurrentBookMarks() {
  const book = currentBook();
  if (!book?.externalId || book.source !== "weread") {
    showToast("先在已发生里选择一本微信读书来源的书");
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
    showToast("待整理为空");
    return;
  }

  const body = queued.map(formatForMarkdown).join("\n\n---\n\n");
  await navigator.clipboard.writeText(body);
  showToast("已复制 Markdown");
}

function formatForMarkdown(note) {
  const book = books.find((item) => item.id === note.bookId);
  return [
    "# 读书片段",
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
  bridgeStatus.textContent = session ? `已连接云端 · ${notes.length} 条` : "未登录";
  bridgeAuthStatus.textContent = session ? "已连接云端" : "登录后读取微信读书同步内容";
  bridgeGoogle.classList.toggle("is-hidden", Boolean(session));
  bridgeSignOut.classList.toggle("is-hidden", !session);
  bridgeListTitle.textContent = view === "queue" ? "待整理" : view === "active" ? "已发生" : "候选";

  if (!session) {
    bridgeList.innerHTML = `<div class="empty">先登录，然后同步微信读书笔记本。</div>`;
    return;
  }

  renderBridgeList();
}

function renderActiveBooks() {
  const book = currentBook();
  const activeBooks = books.filter((item) => isBookActive(item) && !isBookIgnored(item));
  if (!activeBooks.length) {
    bridgeList.innerHTML = `<div class="empty">还没有已发生的书。同步“已发生”或从候选里点“开始处理”。</div>`;
    return;
  }

  bridgeList.innerHTML = `
    <article class="note-item">
      <div class="note-top">
        <span class="note-type">当前来源书</span>
        <span>${activeBooks.length} 本</span>
      </div>
      <div class="note-text">${escapeHtml(book?.title || "无")}</div>
    </article>
    ${activeBooks.map((item) => `
      <article class="book-item bridge-book-row">
        <div>
          <div class="book-title">${escapeHtml(item.title)}</div>
          <div class="book-meta">${escapeHtml(item.author)} · ${noteCountForBook(item.id)} 条片段</div>
        </div>
        <button type="button" data-pick-book="${escapeHtml(item.id)}">${item.id === currentBookId ? "当前" : "选择"}</button>
      </article>
    `).join("")}
  `;
}

function renderCandidateBooks() {
  const candidates = books.filter((book) => book.source === "weread" && !isBookActive(book) && !isBookIgnored(book));
  if (!candidates.length) {
    bridgeList.innerHTML = `<div class="empty">候选为空。点“书架候选”从微信读书同步高熵书架。</div>`;
    return;
  }

  bridgeList.innerHTML = candidates.map((book) => `
    <article class="book-item bridge-book-row">
      <div>
        <div class="book-title">${escapeHtml(book.title)}</div>
        <div class="book-meta">${escapeHtml(book.author)} · 候选</div>
      </div>
      <div class="bridge-inline-actions">
        <button type="button" data-ignore-book="${escapeHtml(book.id)}">忽略</button>
        <button type="button" data-start-book="${escapeHtml(book.id)}">开始处理</button>
      </div>
    </article>
  `).join("");
}

function renderBridgeList() {
  if (view === "inbox") {
    renderCandidateBooks();
    return;
  }

  if (view === "active") {
    renderActiveBooks();
    return;
  }

  const items = visibleNotes();
  if (!items.length) {
    bridgeList.innerHTML = `<div class="empty">${view === "queue" ? "还没有待整理内容。" : "候选为空，先同步微信读书。"}</div>`;
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
          <button type="button" data-queue="${escapeHtml(note.id)}">${localState[note.id] === "queue" ? "已待整理" : "待整理"}</button>
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
  const ignoreBook = event.target.closest("[data-ignore-book]");
  if (ignoreBook) {
    localState[bookStateKey(ignoreBook.dataset.ignoreBook)] = "ignored";
    saveLocalState();
    render();
    return;
  }

  const startBook = event.target.closest("[data-start-book]");
  if (startBook) {
    localState[bookStateKey(startBook.dataset.startBook)] = "active";
    currentBookId = startBook.dataset.startBook;
    saveLocalState();
    setBridgeView("active");
    return;
  }

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
    await navigator.clipboard.writeText(formatForMarkdown(note));
    localState[note.id] = "sent";
    saveLocalState();
    render();
    showToast("已复制");
  }
});

document.querySelector("#bridgeRefresh").addEventListener("click", loadCloudData);
document.querySelector("#bridgeSettings").addEventListener("click", () => setBridgeView("active"));
document.querySelector("#bridgeGoogle").addEventListener("click", signInWithGoogle);
document.querySelector("#bridgeSignOut").addEventListener("click", signOut);
document.querySelector("#bridgeImportShelf").addEventListener("click", importWereadShelf);
document.querySelector("#bridgeImportBooks").addEventListener("click", importWereadBooks);
document.querySelector("#bridgeImportMarks").addEventListener("click", importCurrentBookMarks);
document.querySelector("#bridgeCopyQueue").addEventListener("click", copyQueue);

async function init() {
  render();
  if (!canUseCloud) {
    bridgeAuthStatus.textContent = "云端未配置";
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
