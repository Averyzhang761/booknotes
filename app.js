const prefsKey = "paper-booknotes-prefs-v1";
const makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const config = window.READING_NOTES_CONFIG || {};
const canUseSupabase = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
const db = canUseSupabase ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

let prefs = loadPrefs();
let state = {
  session: null,
  currentBookId: prefs.currentBookId || null,
  books: [],
  notes: [],
};
let selectedType = "体会";
let pasteTimer;
let toastTimer;

const views = document.querySelectorAll(".app-page");
const tabs = document.querySelectorAll(".tab");
const noteInput = document.querySelector("#noteInput");
const detectedType = document.querySelector("#detectedType");
const wordCount = document.querySelector("#wordCount");
const notesList = document.querySelector("#notesList");
const bookList = document.querySelector("#bookList");
const currentBookTitle = document.querySelector("#currentBookTitle");
const cloudStatus = document.querySelector("#cloudStatus");
const segments = document.querySelectorAll(".segment");
const autoSavePaste = document.querySelector("#autoSavePaste");
const bookForm = document.querySelector("#bookForm");
const bookTitleInput = document.querySelector("#bookTitleInput");
const bookAuthorInput = document.querySelector("#bookAuthorInput");
const authForm = document.querySelector("#authForm");
const emailInput = document.querySelector("#emailInput");
const signOut = document.querySelector("#signOut");
const syncStatus = document.querySelector("#syncStatus");
const wereadStatus = document.querySelector("#wereadStatus");
const toast = document.querySelector("#toast");

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(prefsKey)) || { autoSavePaste: false };
  } catch {
    return { autoSavePaste: false };
  }
}

function savePrefs() {
  localStorage.setItem(prefsKey, JSON.stringify(prefs));
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1600);
}

function setView(name) {
  views.forEach((view) => view.classList.toggle("is-hidden", view.dataset.view !== name));
  tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.target === name));

  if (name === "capture" && state.session) {
    requestAnimationFrame(() => noteInput.focus());
  }
}

function currentBook() {
  return state.books.find((book) => book.id === state.currentBookId) || state.books[0] || null;
}

function inferType(text) {
  const trimmed = text.trim();
  if (!trimmed) return selectedType;
  const hasQuoteMarks = /^[“"「『《]/.test(trimmed) || /[”"」』]$/.test(trimmed);
  const longSingleParagraph = trimmed.length > 45 && !/(我觉得|想到|也许|可能|为什么)/.test(trimmed);
  if (hasQuoteMarks || longSingleParagraph) return "摘句";
  if (trimmed.length <= 18) return "random";
  return "体会";
}

function setType(type) {
  selectedType = type;
  detectedType.textContent = type;
  segments.forEach((segment) => segment.classList.toggle("is-active", segment.dataset.type === type));
}

function updateInputMeta() {
  const text = noteInput.value;
  wordCount.textContent = `${text.trim().length} 字`;
  setType(inferType(text));
}

async function loadCloudData() {
  if (!state.session) {
    state.books = [];
    state.notes = [];
    render();
    return;
  }

  const [booksResult, notesResult] = await Promise.all([
    db.from("books").select("id,title,author,created_at").order("created_at", { ascending: false }),
    db.from("notes").select("id,book_id,type,text,created_at").order("created_at", { ascending: false }),
  ]);

  if (booksResult.error || notesResult.error) {
    showToast("云端读取失败，请检查表结构和 RLS");
    syncStatus.textContent = "云端读取失败";
    return;
  }

  state.books = booksResult.data.map((book) => ({
    id: book.id,
    title: book.title,
    author: book.author || "未填写",
    source: book.source || "manual",
    externalId: book.external_id,
    createdAt: book.created_at,
  }));
  state.notes = notesResult.data.map((note) => ({
    id: note.id,
    bookId: note.book_id,
    type: note.type,
    text: note.text,
    createdAt: note.created_at,
  }));

  if (!state.books.length) {
    await createStarterBook();
    return;
  }

  if (!state.books.some((book) => book.id === state.currentBookId)) {
    state.currentBookId = state.books[0].id;
    prefs.currentBookId = state.currentBookId;
    savePrefs();
  }

  render();
}

async function createStarterBook() {
  const { data, error } = await db
    .from("books")
    .insert({ title: "未命名读书笔记", author: "随手收集", source: "manual" })
    .select("id,title,author,source,external_id,created_at")
    .single();

  if (error) {
    showToast("默认书创建失败");
    return;
  }

  state.books = [{
    id: data.id,
    title: data.title,
    author: data.author,
    source: data.source,
    externalId: data.external_id,
    createdAt: data.created_at,
  }];
  state.currentBookId = data.id;
  prefs.currentBookId = data.id;
  savePrefs();
  render();
}

async function saveNote() {
  const text = noteInput.value.trim();
  if (!text) {
    noteInput.focus();
    return;
  }
  if (!state.session) {
    showToast("先登录，笔记才会进云端");
    setView("sync");
    return;
  }

  const book = currentBook();
  if (!book) {
    showToast("先加一本书");
    setView("books");
    return;
  }

  const { data, error } = await db
    .from("notes")
    .insert({ book_id: book.id, type: selectedType, text })
    .select("id,book_id,type,text,created_at")
    .single();

  if (error) {
    showToast("保存失败，未写入云端");
    return;
  }

  state.notes.unshift({
    id: data.id,
    bookId: data.book_id,
    type: data.type,
    text: data.text,
    createdAt: data.created_at,
  });
  noteInput.value = "";
  selectedType = "体会";
  render();
  updateInputMeta();
  showToast(`已存到《${book.title}》`);
  noteInput.focus();
}

function render() {
  const book = currentBook();
  currentBookTitle.textContent = book ? book.title : "读书笔记";
  cloudStatus.textContent = statusText();
  syncStatus.textContent = statusText();
  wereadStatus.textContent = state.session ? "可同步微信读书" : "登录后可同步微信读书";
  authForm.classList.toggle("is-hidden", Boolean(state.session) || !canUseSupabase);
  signOut.classList.toggle("is-hidden", !state.session);
  renderNotes(book?.id);
  renderBooks();
}

function statusText() {
  if (!canUseSupabase) return "需要配置 Supabase publishable key";
  if (!state.session) return "未登录云端";
  return `已同步 ${state.books.length} 本书 · ${state.notes.length} 条`;
}

function renderNotes(bookId) {
  if (!state.session) {
    notesList.innerHTML = `<div class="empty">登录后开始记录，笔记会保存到云端。</div>`;
    return;
  }
  const notes = state.notes.filter((note) => note.bookId === bookId);
  if (!notes.length) {
    notesList.innerHTML = `<div class="empty">这本书还没有笔记。</div>`;
    return;
  }

  notesList.innerHTML = notes
    .map((note) => {
      const time = new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(note.createdAt));
      return `
        <article class="note-item">
          <div class="note-top">
            <span class="note-type">${escapeHtml(note.type)}</span>
            <span>${time} <button class="delete-note" type="button" data-delete="${escapeHtml(note.id)}">删除</button></span>
          </div>
          <div class="note-text">${escapeHtml(note.text)}</div>
        </article>
      `;
    })
    .join("");
}

function renderBooks() {
  if (!state.session) {
    bookList.innerHTML = `<div class="empty">登录后书会保存在 Supabase。</div>`;
    return;
  }

  bookList.innerHTML = state.books
    .map((book) => {
      const count = state.notes.filter((note) => note.bookId === book.id).length;
      const active = book.id === state.currentBookId ? "当前" : "切换";
      return `
        <article class="book-item">
          <div>
            <div class="book-title">${escapeHtml(book.title)}</div>
            <div class="book-meta">${escapeHtml(book.author)} · ${count} 条</div>
          </div>
          <button type="button" data-book="${escapeHtml(book.id)}">${active}</button>
        </article>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    noteInput.value = noteInput.value ? `${noteInput.value}\n${text}` : text;
    updateInputMeta();
    maybeAutoSavePaste();
    noteInput.focus();
  } catch {
    noteInput.focus();
  }
}

function wrapAsQuote() {
  const text = noteInput.value.trim();
  if (!text) return;
  noteInput.value = `「${text.replace(/^「|」$/g, "")}」`;
  setType("摘句");
  updateInputMeta();
  noteInput.focus();
}

function openBookForm() {
  if (!state.session) {
    showToast("先登录云端");
    setView("sync");
    return;
  }
  bookForm.classList.remove("is-hidden");
  requestAnimationFrame(() => bookTitleInput.focus());
}

function closeBookForm() {
  bookForm.reset();
  bookForm.classList.add("is-hidden");
}

async function addBook(event) {
  event.preventDefault();
  const title = bookTitleInput.value.trim();
  if (!title) {
    bookTitleInput.focus();
    return;
  }
  const author = bookAuthorInput.value.trim() || "未填写";
  const { data, error } = await db
    .from("books")
    .insert({ title, author, source: "manual" })
    .select("id,title,author,source,external_id,created_at")
    .single();

  if (error) {
    showToast("加书失败，未写入云端");
    return;
  }

  state.books.unshift({
    id: data.id,
    title: data.title,
    author: data.author,
    source: data.source,
    externalId: data.external_id,
    createdAt: data.created_at,
  });
  state.currentBookId = data.id;
  prefs.currentBookId = data.id;
  savePrefs();
  closeBookForm();
  render();
  showToast(`当前书已切到《${title}》`);
  setView("capture");
}

function exportNotes() {
  const book = currentBook();
  if (!book) return;
  const notes = state.notes.filter((note) => note.bookId === book.id);
  const markdown = [`# ${book.title}`, "", ...notes.map((note) => `## ${note.type}\n\n${note.text}\n`)].join("\n");
  navigator.clipboard?.writeText(markdown);
  showToast("已复制 Markdown");
}

function maybeAutoSavePaste() {
  clearTimeout(pasteTimer);
  if (!prefs.autoSavePaste) return;
  pasteTimer = setTimeout(saveNote, 260);
}

async function sendLoginLink(event) {
  event.preventDefault();
  if (!canUseSupabase) {
    showToast("先配置 Supabase publishable key");
    return;
  }
  const email = emailInput.value.trim();
  if (!email) {
    emailInput.focus();
    return;
  }

  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${location.origin}${location.pathname}` },
  });

  if (error) {
    syncStatus.textContent = error.message;
    showToast(error.message);
    return;
  }

  syncStatus.textContent = "登录链接已发送，请检查邮箱和垃圾箱";
  showToast("登录链接已发送");
}

async function signOutUser() {
  await db.auth.signOut();
  state.session = null;
  state.books = [];
  state.notes = [];
  render();
  setView("sync");
}

async function invokeWeread(body) {
  if (!state.session) {
    showToast("先登录云端");
    setView("sync");
    return null;
  }
  const { data, error } = await db.functions.invoke("weread-gateway", { body });
  if (error || data?.error) {
    wereadStatus.textContent = "微信读书同步失败";
    showToast("微信读书同步失败");
    return null;
  }
  return data;
}

async function importWereadShelf() {
  wereadStatus.textContent = "正在拉取微信读书书架...";
  const data = await invokeWeread({ action: "shelf" });
  if (!data) return;

  const books = data.books || [];
  const rows = books.map((book) => ({
    user_id: state.session.user.id,
    title: book.title || "未命名",
    author: book.author || "未填写",
    source: "weread",
    external_id: book.bookId,
  }));

  if (!rows.length) {
    wereadStatus.textContent = "微信读书书架为空";
    return;
  }

  const { error } = await db.from("books").upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) {
    showToast("书架写入失败");
    return;
  }

  await loadCloudData();
  wereadStatus.textContent = `已同步 ${rows.length} 本微信读书书架书籍`;
}

async function importWereadNotebooks() {
  wereadStatus.textContent = "正在拉取微信读书笔记本...";
  const data = await invokeWeread({ action: "notebooks", count: 100 });
  if (!data) return;

  const notebooks = data.books || [];
  const rows = notebooks.map((item) => ({
    user_id: state.session.user.id,
    title: item.book?.title || "未命名",
    author: item.book?.author || "未填写",
    source: "weread",
    external_id: item.bookId,
  }));

  if (!rows.length) {
    wereadStatus.textContent = "微信读书没有可同步笔记本";
    return;
  }

  const { error } = await db.from("books").upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) {
    showToast("笔记本写入失败");
    return;
  }

  await loadCloudData();
  wereadStatus.textContent = `已同步 ${rows.length} 本有笔记的书`;
}

async function importCurrentWereadNotes() {
  const book = currentBook();
  if (!book?.externalId || book.source !== "weread") {
    showToast("当前书不是微信读书同步书籍");
    return;
  }

  wereadStatus.textContent = "正在拉取当前书划线...";
  const data = await invokeWeread({ action: "bookmarks", bookId: book.externalId });
  if (!data) return;

  const marks = data.updated || [];
  const rows = marks
    .filter((mark) => mark.markText)
    .map((mark) => ({
      user_id: state.session.user.id,
      book_id: book.id,
      type: "摘句",
      text: mark.markText,
      source: "weread",
      external_id: mark.bookmarkId,
    }));

  if (!rows.length) {
    wereadStatus.textContent = "当前书没有可导入划线";
    return;
  }

  const { error } = await db.from("notes").upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) {
    showToast("划线写入失败");
    return;
  }

  await loadCloudData();
  wereadStatus.textContent = `已导入 ${rows.length} 条当前书划线`;
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.target));
});

segments.forEach((segment) => {
  segment.addEventListener("click", () => setType(segment.dataset.type));
});

bookList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-book]");
  if (!button) return;
  state.currentBookId = button.dataset.book;
  prefs.currentBookId = state.currentBookId;
  savePrefs();
  render();
  setView("capture");
});

notesList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete]");
  if (!button) return;
  const { error } = await db.from("notes").delete().eq("id", button.dataset.delete);
  if (error) {
    showToast("删除失败");
    return;
  }
  state.notes = state.notes.filter((note) => note.id !== button.dataset.delete);
  render();
  showToast("已删除");
});

noteInput.addEventListener("input", updateInputMeta);
noteInput.addEventListener("paste", () => {
  setTimeout(() => {
    updateInputMeta();
    maybeAutoSavePaste();
  }, 0);
});
noteInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    saveNote();
  }
});

document.querySelector("#saveNote").addEventListener("click", saveNote);
document.querySelector("#pasteButton").addEventListener("click", pasteFromClipboard);
document.querySelector("#quoteWrap").addEventListener("click", wrapAsQuote);
document.querySelector("#clearInput").addEventListener("click", () => {
  noteInput.value = "";
  updateInputMeta();
  noteInput.focus();
});
autoSavePaste.checked = Boolean(prefs.autoSavePaste);
autoSavePaste.addEventListener("change", () => {
  prefs.autoSavePaste = autoSavePaste.checked;
  savePrefs();
  showToast(autoSavePaste.checked ? "已开启粘贴后自动存下" : "已关闭自动存下");
  noteInput.focus();
});
document.querySelector("#bookSwitch").addEventListener("click", () => setView("books"));
document.querySelector("#addBook").addEventListener("click", openBookForm);
document.querySelector("#cancelBook").addEventListener("click", closeBookForm);
bookForm.addEventListener("submit", addBook);
authForm.addEventListener("submit", sendLoginLink);
signOut.addEventListener("click", signOutUser);
document.querySelector("#exportNotes").addEventListener("click", exportNotes);
document.querySelector("#syncOpen").addEventListener("click", () => setView("sync"));
document.querySelector("#syncClose").addEventListener("click", () => setView("capture"));
document.querySelector("#importWereadShelf").addEventListener("click", importWereadShelf);
document.querySelector("#importWereadNotebooks").addEventListener("click", importWereadNotebooks);
document.querySelector("#importCurrentWereadNotes").addEventListener("click", importCurrentWereadNotes);

async function init() {
  render();
  updateInputMeta();

  if (!canUseSupabase) {
    setView("sync");
    return;
  }

  const { data } = await db.auth.getSession();
  state.session = data.session;
  db.auth.onAuthStateChange((_event, session) => {
    state.session = session;
    loadCloudData();
  });

  if (state.session) {
    await loadCloudData();
    setView("capture");
  } else {
    render();
    setView("sync");
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init();
