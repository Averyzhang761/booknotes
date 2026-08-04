const prefsKey = "paper-booknotes-prefs-v1";
const hiddenWereadAuthor = "__BOOKNOTES_HIDDEN__";

const config = window.READING_NOTES_CONFIG || {};
const agentContext = window.READING_AGENT_CONTEXT || {};
const canUseCloud = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
const db = canUseCloud ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
const defaultCopilotText = "粘贴一段微信读书内容后，我会沿着作者视角，结合当前书和你的本地上下文，回你一句可以继续聊的话。";

let prefs = loadPrefs();
let state = {
  session: null,
  currentBookId: prefs.currentBookId || null,
  books: [],
  notes: [],
};
let selectedType = "体会";
let typeLocked = false;
let bookSearchQuery = "";
let batchMode = false;
let selectedBookIds = new Set();
let selectedWereadBook = null;
let activeNoteView = "mine";
let pasteTimer;
let autoSavePasteInFlight = false;
let toastTimer;
let swipedBookId = null;
let latestCopilotResponse = "";

const views = document.querySelectorAll(".app-page");
const tabs = document.querySelectorAll(".tab");
const noteTabs = document.querySelectorAll(".note-tab");
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
const bookSearch = document.querySelector("#bookSearch");
const bookTitleInput = document.querySelector("#bookTitleInput");
const bookAuthorInput = document.querySelector("#bookAuthorInput");
const wereadSearchResults = document.querySelector("#wereadSearchResults");
const bulkBar = document.querySelector("#bulkBar");
const bulkCount = document.querySelector("#bulkCount");
const authForm = document.querySelector("#authForm");
const emailInput = document.querySelector("#emailInput");
const googleLogin = document.querySelector("#googleLogin");
const signOut = document.querySelector("#signOut");
const syncStatus = document.querySelector("#syncStatus");
const wereadStatus = document.querySelector("#wereadStatus");
const toast = document.querySelector("#toast");
const saveNoteButton = document.querySelector("#saveNote");
const pasteButton = document.querySelector("#pasteButton");
const quoteWrapButton = document.querySelector("#quoteWrap");
const clearInputButton = document.querySelector("#clearInput");
const copilotCard = document.querySelector("#copilotCard");
const copilotResponse = document.querySelector("#copilotResponse");
const copilotRefreshButton = document.querySelector("#copilotRefresh");
const copilotSaveButton = document.querySelector("#copilotSave");
const bookSwitchButton = document.querySelector("#bookSwitch");
const batchBooksButton = document.querySelector("#batchBooks");
const cancelBatchBooksButton = document.querySelector("#cancelBatchBooks");
const toggleSelectBooksButton = document.querySelector("#toggleSelectBooks");
const deleteSelectedBooksButton = document.querySelector("#deleteSelectedBooks");
const addBookButton = document.querySelector("#addBook");
const cancelBookButton = document.querySelector("#cancelBook");
const searchWereadBookButton = document.querySelector("#searchWereadBook");
const exportNotesButton = document.querySelector("#exportNotes");
const syncOpenButton = document.querySelector("#syncOpen");
const syncCloseButton = document.querySelector("#syncClose");
const themeToggleButton = document.querySelector("#themeToggle");
const importWereadShelfButton = document.querySelector("#importWereadShelf");
const importWereadNotebooksButton = document.querySelector("#importWereadNotebooks");
const importCurrentWereadNotesButton = document.querySelector("#importCurrentWereadNotes");

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

function applyTheme(theme = prefs.theme || "day") {
  const nextTheme = theme === "day" ? "day" : "night";
  document.documentElement.dataset.theme = nextTheme;
  themeToggleButton.dataset.mode = nextTheme;
  themeToggleButton.setAttribute("aria-label", nextTheme === "day" ? "切换到夜间主题" : "切换到白天主题");
}

function toggleTheme() {
  prefs.theme = (prefs.theme || "day") === "night" ? "day" : "night";
  prefs.themeVersion = 2;
  savePrefs();
  applyTheme(prefs.theme);
}

function migrateThemePrefs() {
  if (prefs.themeVersion === 2) return;
  prefs.theme = "day";
  prefs.themeVersion = 2;
  savePrefs();
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
  if (trimmed.length <= 18) return "随想";
  return "体会";
}

function setType(type) {
  selectedType = normalizeNoteType(type);
  detectedType.textContent = selectedType;
  segments.forEach((segment) => segment.classList.toggle("is-active", segment.dataset.type === selectedType));
}

function chooseType(type) {
  typeLocked = true;
  setType(normalizeNoteType(type));
}

function normalizeNoteType(type) {
  return type === "random" ? "随想" : type;
}

function updateInputMeta() {
  const text = noteInput.value;
  wordCount.textContent = `${text.trim().length} 字`;
  if (!typeLocked) {
    setType(inferType(text));
  }
}

function updateCopilotResponse(sourceText = noteInput.value) {
  const text = sourceText.trim();
  if (text.length < 12) {
    copilotResponse.textContent = text ? "这段太短，还不足以判断。粘贴一整句或一小段微信读书内容试试。" : defaultCopilotText;
    latestCopilotResponse = "";
    return false;
  }

  latestCopilotResponse = buildCopilotResponse(text);
  copilotResponse.textContent = latestCopilotResponse;
  return true;
}

function buildCopilotResponse(text) {
  const theme = detectReadingTheme(text);
  const thread = inferRecentThread();
  const wereadSignal = inferWereadSignal(text, theme);
  const agentSignal = inferAgentSignal(theme);
  const book = currentBook();
  const author = readableAuthor(book?.author);
  const authorView = buildAuthorView(theme, author);
  const personalTurn = buildPersonalTurn(theme, thread, wereadSignal, agentSignal);
  return `${authorView}\n\n${personalTurn}`;
}

function detectReadingTheme(text) {
  const rules = [
    { label: "意义感", pattern: /意义|愿景|价值|真正|重要|生活|人生|空虚|虚无/ },
    { label: "控制感", pattern: /控制|坚持|自律|选择|自由|秩序|规则|失控|稳定/ },
    { label: "关系与孤独", pattern: /孤独|关系|亲密|理解|他人|沟通|爱|被看见/ },
    { label: "欲望与成就", pattern: /成功|名利|野心|成就|得到|拥有|财富|目标/ },
    { label: "时间与行动", pattern: /时间|长期|当下|行动|拖延|开始|完成|未来/ },
  ];
  return rules.find((rule) => rule.pattern.test(text))?.label || "一个还没命名的反复主题";
}

function inferRecentThread() {
  const recentText = state.notes
    .filter((note) => note.source !== "weread")
    .slice(0, 12)
    .map((note) => note.text)
    .join("\n");
  if (/意义|愿景|价值|空虚|生活|人生/.test(recentText)) return "意义感";
  if (/控制|坚持|自律|选择|自由|秩序/.test(recentText)) return "控制感";
  if (/成功|名利|野心|成就|目标/.test(recentText)) return "欲望与成就";
  if (/孤独|关系|亲密|理解|他人/.test(recentText)) return "关系与孤独";
  return "为什么这句话会抓住我";
}

function buildAuthorView(theme, author) {
  const speaker = author ? `如果沿着 ${author} 的作者视角继续说` : "如果沿着这本书的作者视角继续说";
  const lines = {
    意义感: `${speaker}，他大概不会急着劝你“找到意义”。他会先问：你现在抓住的这个愿景，是从内心长出来的，还是你用来抵抗空虚的一套秩序？`,
    控制感: `${speaker}，他可能不会夸你“更自律”。他会问：你现在说的坚持，是主动选择，还是你害怕失控时给自己套上的绳子？`,
    关系与孤独: `${speaker}，他可能不会安慰你“会有人理解”。他会问：你想被看见，还是只想在不暴露真实需要的情况下被接住？`,
    欲望与成就: `${speaker}，他可能不会反对成就本身。他会问：如果名利真的来了，你准备用它服务什么？还是只是证明自己终于安全了？`,
    时间与行动: `${speaker}，他可能不会让你继续规划。他会问：你把“以后”说得这么清楚，是因为你真的要行动，还是因为计划比当下更容易承受？`,
  };
  return lines[theme] || `${speaker}，他可能会先停在这里问你：你为什么偏偏复制这一句？它不像答案，更像一个你还没有说出口的问题。`;
}

function buildPersonalTurn(theme, thread, wereadSignal, agentSignal) {
  const contextLine = [wereadSignal, agentSignal].filter(Boolean).join(" ");
  const prefix = contextLine ? `${contextLine}\n\n` : "";
  const focus = thread || theme;
  return `${prefix}那你要不要诚实一点：你复制它，是想确认自己已经懂了，还是其实在等它反过来质问你「${focus}」这件事？`;
}

function readableAuthor(author) {
  if (!author || author === hiddenWereadAuthor || author === "未填写") return "";
  return author.split(/[·,，/]/)[0].trim();
}

function inferWereadSignal(text, theme) {
  const book = currentBook();
  if (!book) return "";
  const wereadNotes = state.notes.filter((note) => note.bookId === book.id && note.source === "weread");
  if (!wereadNotes.length) return "";

  const bestMatch = findRelatedNote(text, wereadNotes);
  const matchTheme = bestMatch ? detectReadingTheme(bestMatch.text) : theme;
  if (!bestMatch || matchTheme === "一个还没命名的反复主题") return "";
  return `你在微信读书里留下过相近的痕迹：这不是第一次碰到「${matchTheme}」。`;
}

function findRelatedNote(text, notes) {
  const tokens = extractChineseTokens(text);
  if (!tokens.length) return notes[0] || null;
  return notes
    .map((note) => ({
      note,
      score: tokens.filter((token) => note.text.includes(token)).length,
    }))
    .sort((a, b) => b.score - a.score)[0]?.note || notes[0] || null;
}

function extractChineseTokens(text) {
  return [...new Set((text.match(/[\u4e00-\u9fa5]{2,}/g) || [])
    .flatMap((item) => item.length > 6 ? [item.slice(0, 2), item.slice(-2)] : [item])
    .filter((item) => item.length >= 2))]
    .slice(0, 16);
}

function inferAgentSignal(theme) {
  const keywords = Array.isArray(agentContext.keywords) ? agentContext.keywords : [];
  const sources = Array.isArray(agentContext.sources) ? agentContext.sources : [];
  const exactHit = keywords.find((keyword) => theme.includes(keyword) || keyword.includes(theme));
  if (exactHit) return `你的本地上下文里也反复出现「${exactHit}」。`;
  const sourceHit = sources.find((source) => source.text?.includes(theme));
  if (sourceHit) return `你的本地上下文里也有这个方向的记录。`;
  if (keywords.length) return `它也许能接到你长期在处理的「${keywords.slice(0, 2).join(" / ")}」。`;
  return "";
}

async function loadCloudData() {
  if (!state.session) {
    state.books = [];
    state.notes = [];
    render();
    return;
  }

  const [booksResult, notesResult] = await Promise.all([
    db.from("books").select("id,title,author,source,external_id,created_at").order("created_at", { ascending: false }),
    db.from("notes").select("id,book_id,type,text,source,external_id,created_at").order("created_at", { ascending: false }),
  ]);

  if (booksResult.error || notesResult.error) {
    showToast("云端读取失败，请稍后再试");
    syncStatus.textContent = "云端读取失败";
    return;
  }

  state.books = booksResult.data
    .filter((book) => book.author !== hiddenWereadAuthor)
    .map((book) => ({
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
    type: normalizeNoteType(note.type),
    text: note.text,
    source: note.source || "manual",
    externalId: note.external_id,
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
    return false;
  }
  if (!state.session) {
    showToast("先登录，笔记才会进云端");
    setView("sync");
    return false;
  }

  const book = currentBook();
  if (!book) {
    showToast("先加一本书");
    setView("books");
    return false;
  }

  const { data, error } = await db
    .from("notes")
    .insert({ book_id: book.id, type: selectedType, text, source: "manual" })
    .select("id,book_id,type,text,source,external_id,created_at")
    .single();

  if (error) {
    showToast("保存失败，未写入云端");
    return false;
  }

  state.notes.unshift({
    id: data.id,
    bookId: data.book_id,
    type: data.type,
    text: data.text,
    source: data.source || "manual",
    externalId: data.external_id,
    createdAt: data.created_at,
  });
  noteInput.value = "";
  selectedType = "体会";
  typeLocked = false;
  activeNoteView = "mine";
  setType(selectedType);
  render();
  updateInputMeta();
  showToast(`已保存到《${book.title}》`);
  noteInput.focus();
  return true;
}

function render() {
  const book = currentBook();
  currentBookTitle.textContent = book ? book.title : "读书笔记";
  cloudStatus.textContent = statusText();
  syncStatus.textContent = statusText();
  wereadStatus.textContent = state.session ? "可同步微信读书" : "登录后可同步微信读书";
  authForm.classList.toggle("is-hidden", Boolean(state.session) || !canUseCloud);
  googleLogin.classList.toggle("is-hidden", Boolean(state.session) || !canUseCloud);
  signOut.classList.toggle("is-hidden", !state.session);
  bulkBar.classList.toggle("is-hidden", !batchMode);
  bulkCount.textContent = `已选 ${selectedBookIds.size} 本`;
  const visibleIds = visibleBooks().map((book) => book.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedBookIds.has(id));
  toggleSelectBooksButton.textContent = allVisibleSelected ? "取消全选" : "全选";
  noteTabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.noteView === activeNoteView));
  renderNotes(book?.id);
  renderBooks();
}

function statusText() {
  if (!canUseCloud) return "未配置";
  if (!state.session) return "未登录";
  return `${state.books.length} 本书 · ${state.notes.length} 条`;
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

  const visibleNotes = activeNoteView === "weread"
    ? notes.filter((note) => note.source === "weread")
    : notes.filter((note) => note.source !== "weread");
  if (!visibleNotes.length) {
    const message = activeNoteView === "weread" ? "这本书还没有微信导入。" : "这本书还没有我的笔记。";
    notesList.innerHTML = `<div class="empty">${message}</div>`;
    return;
  }
  notesList.innerHTML = visibleNotes.map((note) => renderNoteItem(note)).join("");
}

function renderNoteItem(note) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(note.createdAt));
  const source = note.source === "weread" ? "微信读书" : note.type;
  return `
    <article class="note-item ${note.source === "weread" ? "is-auxiliary" : ""}">
      <div class="note-top">
        <span class="note-type">${escapeHtml(source)}</span>
        <span>${time} <button class="delete-note" type="button" data-delete="${escapeHtml(note.id)}">删除</button></span>
      </div>
      <div class="note-text">${escapeHtml(note.text)}</div>
    </article>
  `;
}

function renderBooks() {
  if (!state.session) {
    bookList.innerHTML = `<div class="empty">登录后书会保存在云端。</div>`;
    return;
  }

  if (batchMode) swipedBookId = null;
  const query = bookSearchQuery.trim();
  const books = sortBooksForDisplay(visibleBooks());

  if (!books.length) {
    bookList.innerHTML = `<div class="empty">${query ? "没有匹配的书。" : "还没有书。"}</div>`;
    return;
  }

  bookList.innerHTML = books
    .map((book) => {
      const count = state.notes.filter((note) => note.bookId === book.id).length;
      const ownCount = state.notes.filter((note) => note.bookId === book.id && note.source !== "weread").length;
      const auxCount = count - ownCount;
      const active = book.id === state.currentBookId;
      const sourceLabel = book.source === "weread" ? "微信读书" : "手动添加";
      const countLabel = auxCount ? `${ownCount} 条 + 微信 ${auxCount}` : `${ownCount} 条`;
      const selected = selectedBookIds.has(book.id) ? "checked" : "";
      return `
        <article class="book-swipe ${book.id === swipedBookId ? "is-open" : ""}" data-swipe-book="${escapeHtml(book.id)}">
          <button class="delete-book" type="button" data-delete-book="${escapeHtml(book.id)}">删除</button>
          <div class="book-item" data-book-card="${escapeHtml(book.id)}">
            ${batchMode ? `<input class="book-select" type="checkbox" data-select-book="${escapeHtml(book.id)}" ${selected} aria-label="选择 ${escapeHtml(book.title)}" />` : ""}
            <div>
              <div class="book-title">${escapeHtml(book.title)}</div>
              <div class="book-meta">${escapeHtml(book.author)} · ${sourceLabel} · ${countLabel}</div>
            </div>
            ${batchMode ? "" : `<span class="book-action ${active ? "is-current" : ""}">${active ? "当前" : "›"}</span>`}
          </div>
        </article>
      `;
    })
    .join("");
}

function visibleBooks() {
  const query = bookSearchQuery.trim().toLowerCase();
  return query
    ? state.books.filter((book) => `${book.title} ${book.author}`.toLowerCase().includes(query))
    : state.books;
}

function sortBooksForDisplay(books) {
  if (!state.currentBookId) return books;
  return [...books].sort((a, b) => {
    if (a.id === state.currentBookId) return -1;
    if (b.id === state.currentBookId) return 1;
    return 0;
  });
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
    const text = await readClipboardText();
    if (!text) {
      showToast("剪贴板为空");
      return;
    }
    noteInput.focus();
    insertIntoNoteInput(text);
    updateInputMeta();
    updateCopilotResponse(text);
    if (!maybeAutoSavePaste()) {
      showToast("已粘贴");
    }
  } catch {
    noteInput.focus();
    showToast("已定位输入框，请点系统粘贴");
  }
}

async function readClipboardText() {
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }
  throw new Error("Clipboard API unavailable");
}

function insertIntoNoteInput(text) {
  const start = noteInput.selectionStart ?? noteInput.value.length;
  const end = noteInput.selectionEnd ?? noteInput.value.length;
  const prefix = noteInput.value.slice(0, start);
  const suffix = noteInput.value.slice(end);
  const spacer = prefix && !prefix.endsWith("\n") ? "\n" : "";
  const nextText = `${prefix}${spacer}${text}${suffix}`;
  const cursor = start + spacer.length + text.length;
  noteInput.value = nextText;
  noteInput.setSelectionRange(cursor, cursor);
}

function wrapAsQuote() {
  const text = noteInput.value.trim();
  if (!text) {
    showToast("先粘贴或输入摘句");
    noteInput.focus();
    return;
  }
  noteInput.value = `「${text.replace(/^「|」$/g, "")}」`;
  chooseType("摘句");
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
  selectedWereadBook = null;
  wereadSearchResults.innerHTML = "";
  wereadSearchResults.classList.add("is-hidden");
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
  const wereadBook = selectedWereadBook;
  const row = selectedWereadBook
    ? {
      user_id: state.session.user.id,
      title,
      author,
      source: "weread",
      external_id: selectedWereadBook.bookId,
    }
    : { title, author, source: "manual" };
  const query = selectedWereadBook
    ? db.from("books").upsert(row, { onConflict: "user_id,source,external_id" })
    : db.from("books").insert(row);
  const { data, error } = await query.select("id,title,author,source,external_id,created_at").single();

  if (error) {
    showToast("加书失败，未写入云端");
    return;
  }

  const savedBook = {
    id: data.id,
    title: data.title,
    author: data.author,
    source: data.source,
    externalId: data.external_id,
    createdAt: data.created_at,
  };
  state.books.unshift(savedBook);
  state.currentBookId = data.id;
  prefs.currentBookId = data.id;
  savePrefs();
  closeBookForm();
  render();
  showToast(`当前书已切到《${title}》`);
  setView("capture");
  if (wereadBook) {
    wereadStatus.textContent = "正在导入这本书的微信笔记...";
    await importWereadNotesForBook(savedBook);
  }
}

async function searchWereadBook() {
  const keyword = bookTitleInput.value.trim();
  if (!keyword) {
    bookTitleInput.focus();
    return;
  }

  wereadSearchResults.classList.remove("is-hidden");
  wereadSearchResults.innerHTML = `<div class="empty small">正在搜索微信读书...</div>`;
  const data = await invokeWeread({ action: "search", keyword, count: 8 });
  if (!data) return;

  const books = parseWereadSearchBooks(data).slice(0, 8);
  if (!books.length) {
    wereadSearchResults.innerHTML = `<div class="empty small">没有找到匹配的微信读书书籍。</div>`;
    return;
  }

  wereadSearchResults.innerHTML = books.map((book, index) => `
    <button class="weread-result" type="button" data-weread-result="${index}">
      <span>${escapeHtml(book.title)}</span>
      <small>${escapeHtml(book.author || "未填写")}</small>
    </button>
  `).join("");
  wereadSearchResults.dataset.results = JSON.stringify(books);
}

function parseWereadSearchBooks(data) {
  return (data.results || [])
    .flatMap((group) => group.books || [])
    .map((item) => item.bookInfo || item)
    .filter((book) => book.bookId && book.title)
    .map((book) => ({
      bookId: book.bookId,
      title: book.title,
      author: book.author || "未填写",
    }));
}

function exportNotes() {
  const book = currentBook();
  if (!book) return;
  const notes = state.notes.filter((note) => note.bookId === book.id);
  const ownNotes = notes.filter((note) => note.source !== "weread");
  const wereadNotes = notes.filter((note) => note.source === "weread");
  const markdown = [
    `# ${book.title}`,
    "",
    "## 我的笔记",
    "",
    ...ownNotes.map((note) => `### ${note.type}\n\n${note.text}\n`),
    wereadNotes.length ? "## 微信读书辅助信息" : "",
    "",
    ...wereadNotes.map((note) => `### 微信读书\n\n${note.text}\n`),
  ].filter(Boolean).join("\n");
  navigator.clipboard?.writeText(markdown);
  showToast("已复制 Markdown");
}

function maybeAutoSavePaste() {
  clearTimeout(pasteTimer);
  if (!prefs.autoSavePaste) return false;
  pasteTimer = setTimeout(autoSavePastedNote, 260);
  return true;
}

async function autoSavePastedNote() {
  if (autoSavePasteInFlight) return;
  autoSavePasteInFlight = true;
  try {
    await saveNote();
  } finally {
    autoSavePasteInFlight = false;
  }
}

async function sendLoginLink(event) {
  event.preventDefault();
  if (!canUseCloud) {
    showToast("云端未配置");
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

async function signInWithGoogle() {
  if (!canUseCloud) {
    showToast("云端未配置");
    return;
  }

  const { error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${location.origin}${location.pathname}` },
  });

  if (error) {
    syncStatus.textContent = error.message;
    showToast(error.message);
  }
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
  const result = await fetch(`${config.supabaseUrl}/functions/v1/weread-gateway`, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${state.session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(result);

  if (!result.ok || data?.error) {
    const message = data?.error || data?.msg || data?.message || `微信读书同步失败：HTTP ${result.status}`;
    wereadStatus.textContent = message;
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

  const { error } = await db.from("books").upsert(rows, { onConflict: "user_id,source,external_id", ignoreDuplicates: true });
  if (error) {
    showDbError("书架写入失败", error);
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

  const { error } = await db.from("books").upsert(rows, { onConflict: "user_id,source,external_id", ignoreDuplicates: true });
  if (error) {
    showDbError("笔记本写入失败", error);
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

  await importWereadNotesForBook(book);
}

async function importWereadNotesForBook(book) {
  wereadStatus.textContent = "正在拉取当前书微信笔记...";
  const bookmarksData = await invokeWeread({ action: "bookmarks", bookId: book.externalId });
  if (!bookmarksData) return;
  const reviewsData = await invokeWeread({ action: "reviews", bookId: book.externalId, count: 100 });
  if (!reviewsData) return;

  const marks = bookmarksData.updated || [];
  const bookmarkRows = marks
    .filter((mark) => mark.markText)
    .map((mark) => ({
      user_id: state.session.user.id,
      book_id: book.id,
      type: "摘句",
      text: mark.markText,
      source: "weread",
      external_id: mark.bookmarkId,
    }));
  const reviewRows = (reviewsData.reviews || [])
    .map((item) => item.review || item)
    .filter((review) => review.content)
    .map((review) => {
      const text = review.abstract
        ? `原文：${review.abstract}\n想法：${review.content}`
        : review.content;
      return {
        user_id: state.session.user.id,
        book_id: book.id,
        type: "体会",
        text,
        source: "weread",
        external_id: `review:${review.reviewId || `${review.createTime || "0"}-${review.range || text.slice(0, 24)}`}`,
      };
    });
  const rows = [...bookmarkRows, ...reviewRows];

  if (!rows.length) {
    wereadStatus.textContent = "当前书没有可导入微信笔记";
    return;
  }

  const { error } = await db.from("notes").upsert(rows, { onConflict: "user_id,source,external_id" });
  if (error) {
    showDbError("微信笔记写入失败", error);
    return;
  }

  activeNoteView = "weread";
  await loadCloudData();
  wereadStatus.textContent = `已导入 ${rows.length} 条当前书微信笔记`;
}

function showDbError(prefix, error) {
  const message = `${prefix}: ${error.message || error.details || error.code || "未知数据库错误"}`;
  wereadStatus.textContent = message;
  showToast(message);
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.target));
});

segments.forEach((segment) => {
  segment.addEventListener("click", () => chooseType(segment.dataset.type));
});

noteTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeNoteView = tab.dataset.noteView;
    render();
  });
});

bookList.addEventListener("click", (event) => {
  const checkbox = event.target.closest("[data-select-book]");
  if (checkbox) {
    if (checkbox.checked) {
      selectedBookIds.add(checkbox.dataset.selectBook);
    } else {
      selectedBookIds.delete(checkbox.dataset.selectBook);
    }
    render();
    return;
  }

  const deleteButton = event.target.closest("[data-delete-book]");
  if (deleteButton) {
    deleteBook(deleteButton.dataset.deleteBook);
    return;
  }

  if (batchMode) return;

  const card = event.target.closest("[data-book-card]");
  if (!card) return;
  if (swipedBookId === card.dataset.bookCard) {
    swipedBookId = null;
    renderBooks();
    return;
  }
  state.currentBookId = card.dataset.bookCard;
  swipedBookId = null;
  prefs.currentBookId = state.currentBookId;
  savePrefs();
  render();
  setView("capture");
});

bookList.addEventListener("pointerdown", (event) => {
  if (batchMode) return;
  const card = event.target.closest("[data-book-card]");
  if (!card) return;
  card.dataset.startX = String(event.clientX);
  card.dataset.startY = String(event.clientY);
});

bookList.addEventListener("pointerup", (event) => {
  if (batchMode) return;
  const card = event.target.closest("[data-book-card]");
  if (!card?.dataset.startX) return;

  const deltaX = event.clientX - Number(card.dataset.startX);
  const deltaY = event.clientY - Number(card.dataset.startY);
  delete card.dataset.startX;
  delete card.dataset.startY;

  if (Math.abs(deltaY) > 30 || Math.abs(deltaX) < 48) return;
  swipedBookId = deltaX < 0 ? card.dataset.bookCard : null;
  renderBooks();
});

wereadSearchResults.addEventListener("click", (event) => {
  const button = event.target.closest("[data-weread-result]");
  if (!button) return;
  const books = JSON.parse(wereadSearchResults.dataset.results || "[]");
  selectedWereadBook = books[Number(button.dataset.wereadResult)];
  if (!selectedWereadBook) return;
  bookTitleInput.value = selectedWereadBook.title;
  bookAuthorInput.value = selectedWereadBook.author || "未填写";
  wereadSearchResults.querySelectorAll(".weread-result").forEach((item) => {
    item.classList.toggle("is-selected", item === button);
  });
  showToast("已填入微信读书书籍信息");
});

async function deleteBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) return;
  const count = state.notes.filter((note) => note.bookId === bookId).length;
  const ok = confirm(`删除《${book.title}》？这会同时删除这本书下的 ${count} 条笔记。`);
  if (!ok) return;

  const okDelete = await deleteBookRows([bookId]);
  if (!okDelete) return;

  showToast("已删除本书");
}

async function deleteSelectedBooks() {
  const ids = [...selectedBookIds].filter((id) => state.books.some((book) => book.id === id));
  if (!ids.length) {
    showToast("先选择要删除的书");
    return;
  }
  const noteCount = state.notes.filter((note) => ids.includes(note.bookId)).length;
  const ok = confirm(`删除选中的 ${ids.length} 本书？这会同时删除 ${noteCount} 条笔记。`);
  if (!ok) return;

  const okDelete = await deleteBookRows(ids);
  if (!okDelete) return;

  batchMode = false;
  selectedBookIds.clear();
  showToast(`已删除 ${ids.length} 本书`);
}

async function deleteBookRows(bookIds) {
  const books = state.books.filter((book) => bookIds.includes(book.id));
  const { error: notesError } = await db.from("notes").delete().in("book_id", bookIds);
  if (notesError) {
    showToast(`删除笔记失败: ${notesError.message}`);
    return false;
  }

  const wereadIds = books.filter((book) => book.source === "weread").map((book) => book.id);
  const manualIds = books.filter((book) => book.source !== "weread").map((book) => book.id);

  if (wereadIds.length) {
    const { error } = await db.from("books").update({ author: hiddenWereadAuthor }).in("id", wereadIds);
    if (error) {
      showToast(`删除本书失败: ${error.message}`);
      return false;
    }
  }

  if (manualIds.length) {
    const { error } = await db.from("books").delete().in("id", manualIds);
    if (error) {
      showToast(`删除本书失败: ${error.message}`);
      return false;
    }
  }

  state.books = state.books.filter((item) => !bookIds.includes(item.id));
  state.notes = state.notes.filter((note) => !bookIds.includes(note.bookId));
  selectedBookIds = new Set([...selectedBookIds].filter((id) => !bookIds.includes(id)));
  if (bookIds.includes(state.currentBookId)) {
    state.currentBookId = state.books[0]?.id || null;
    prefs.currentBookId = state.currentBookId;
    savePrefs();
  }
  swipedBookId = null;
  render();
  return true;
}

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
    updateCopilotResponse();
    maybeAutoSavePaste();
  }, 0);
});
noteInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    saveNote();
  }
});

saveNoteButton.addEventListener("click", saveNote);
pasteButton.addEventListener("click", pasteFromClipboard);
quoteWrapButton.addEventListener("click", wrapAsQuote);
clearInputButton.addEventListener("click", () => {
  noteInput.value = "";
  typeLocked = false;
  setType("体会");
  updateInputMeta();
  copilotResponse.textContent = defaultCopilotText;
  latestCopilotResponse = "";
  noteInput.focus();
});
copilotRefreshButton.addEventListener("click", () => {
  if (!updateCopilotResponse()) {
    showToast("先粘贴一段让你停住的话");
    noteInput.focus();
  }
});
copilotSaveButton.addEventListener("click", () => {
  if (!latestCopilotResponse) return;
  noteInput.value = latestCopilotResponse;
  chooseType("体会");
  updateInputMeta();
  noteInput.focus();
});
autoSavePaste.checked = Boolean(prefs.autoSavePaste);
autoSavePaste.addEventListener("change", () => {
  prefs.autoSavePaste = autoSavePaste.checked;
  savePrefs();
  showToast(autoSavePaste.checked ? "已开启粘贴后自动保存" : "已关闭自动保存");
  noteInput.focus();
});
bookSwitchButton.addEventListener("click", () => setView("books"));
bookSearch.addEventListener("input", () => {
  bookSearchQuery = bookSearch.value;
  swipedBookId = null;
  renderBooks();
});
bookTitleInput.addEventListener("input", () => {
  selectedWereadBook = null;
  wereadSearchResults.querySelectorAll(".weread-result").forEach((item) => item.classList.remove("is-selected"));
});
batchBooksButton.addEventListener("click", () => {
  batchMode = true;
  swipedBookId = null;
  render();
});
cancelBatchBooksButton.addEventListener("click", () => {
  batchMode = false;
  selectedBookIds.clear();
  render();
});
toggleSelectBooksButton.addEventListener("click", () => {
  const ids = visibleBooks().map((book) => book.id);
  const allSelected = ids.length > 0 && ids.every((id) => selectedBookIds.has(id));
  ids.forEach((id) => {
    if (allSelected) {
      selectedBookIds.delete(id);
    } else {
      selectedBookIds.add(id);
    }
  });
  render();
});
deleteSelectedBooksButton.addEventListener("click", deleteSelectedBooks);
addBookButton.addEventListener("click", openBookForm);
cancelBookButton.addEventListener("click", closeBookForm);
searchWereadBookButton.addEventListener("click", searchWereadBook);
bookForm.addEventListener("submit", addBook);
authForm.addEventListener("submit", sendLoginLink);
googleLogin.addEventListener("click", signInWithGoogle);
signOut.addEventListener("click", signOutUser);
exportNotesButton.addEventListener("click", exportNotes);
syncOpenButton.addEventListener("click", () => setView("sync"));
syncCloseButton.addEventListener("click", () => setView("capture"));
themeToggleButton.addEventListener("click", toggleTheme);
importWereadShelfButton.addEventListener("click", importWereadShelf);
importWereadNotebooksButton.addEventListener("click", importWereadNotebooks);
importCurrentWereadNotesButton.addEventListener("click", importCurrentWereadNotes);

async function init() {
  migrateThemePrefs();
  applyTheme();
  render();
  updateInputMeta();

  if (!canUseCloud) {
    setView("sync");
    return;
  }

  db.auth.onAuthStateChange((_event, session) => {
    state.session = session;
    if (session) {
      loadCloudData();
    } else {
      render();
      setView("sync");
    }
  });

  const url = new URL(location.href);
  const hasCodeCallback = url.searchParams.has("code");
  const hasHashCallback = url.hash.includes("access_token");
  if (hasCodeCallback) {
    const { error } = await db.auth.exchangeCodeForSession(location.href);
    if (error) {
      syncStatus.textContent = error.message;
      showToast(error.message);
    } else {
      history.replaceState({}, document.title, `${location.origin}${location.pathname}`);
    }
  }

  const { data } = await db.auth.getSession();
  state.session = data.session;
  if (hasHashCallback && state.session) {
    history.replaceState({}, document.title, `${location.origin}${location.pathname}`);
  }

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
