const storageKey = "paper-reading-notes-v1";
const makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const initialState = {
  currentBookId: "siddhartha",
  autoSavePaste: false,
  books: [
    { id: "siddhartha", title: "悉达多", author: "赫尔曼·黑塞" },
    { id: "slow-reading", title: "慢读笔记", author: "随手收集" },
  ],
  notes: [
    {
      id: makeId(),
      bookId: "siddhartha",
      type: "体会",
      text: "看书时先把感觉留下来，不急着整理成结论。",
      createdAt: Date.now() - 1000 * 60 * 16,
    },
  ],
};

let state = loadState();
let selectedType = "体会";

const views = document.querySelectorAll(".app-page");
const tabs = document.querySelectorAll(".tab");
const noteInput = document.querySelector("#noteInput");
const detectedType = document.querySelector("#detectedType");
const wordCount = document.querySelector("#wordCount");
const notesList = document.querySelector("#notesList");
const bookList = document.querySelector("#bookList");
const currentBookTitle = document.querySelector("#currentBookTitle");
const segments = document.querySelectorAll(".segment");
const autoSavePaste = document.querySelector("#autoSavePaste");
const bookForm = document.querySelector("#bookForm");
const bookTitleInput = document.querySelector("#bookTitleInput");
const bookAuthorInput = document.querySelector("#bookAuthorInput");
const toast = document.querySelector("#toast");
let pasteTimer;
let toastTimer;

function loadState() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return initialState;

  try {
    const parsed = JSON.parse(raw);
    return {
      ...initialState,
      ...parsed,
      books: parsed.books?.length ? parsed.books : initialState.books,
      notes: parsed.notes || [],
    };
  } catch {
    return initialState;
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1400);
}

function currentBook() {
  return state.books.find((book) => book.id === state.currentBookId) || state.books[0];
}

function setView(name) {
  views.forEach((view) => view.classList.toggle("is-hidden", view.dataset.view !== name));
  tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.target === name));

  if (name === "capture") {
    requestAnimationFrame(() => noteInput.focus());
  }
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

function saveNote() {
  const text = noteInput.value.trim();
  if (!text) {
    noteInput.focus();
    return;
  }
  const book = currentBook();

  state.notes.unshift({
    id: makeId(),
    bookId: book.id,
    type: selectedType,
    text,
    createdAt: Date.now(),
  });

  noteInput.value = "";
  selectedType = "体会";
  saveState();
  render();
  updateInputMeta();
  showToast(`已存到《${book.title}》`);
  noteInput.focus();
}

function render() {
  const book = currentBook();
  currentBookTitle.textContent = book.title;
  renderNotes(book.id);
  renderBooks();
}

function renderNotes(bookId) {
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
      }).format(note.createdAt);
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
  bookForm.classList.remove("is-hidden");
  requestAnimationFrame(() => bookTitleInput.focus());
}

function closeBookForm() {
  bookForm.reset();
  bookForm.classList.add("is-hidden");
}

function addBook(event) {
  event.preventDefault();
  const title = bookTitleInput.value.trim();
  if (!title) {
    bookTitleInput.focus();
    return;
  }
  const author = bookAuthorInput.value.trim() || "未填写";
  const id = makeId();
  state.books.unshift({ id, title, author });
  state.currentBookId = id;
  saveState();
  closeBookForm();
  render();
  showToast(`当前书已切到《${title}》`);
  setView("capture");
}

function exportNotes() {
  const book = currentBook();
  const notes = state.notes.filter((note) => note.bookId === book.id);
  const markdown = [
    `# ${book.title}`,
    "",
    ...notes.map((note) => `## ${note.type}\n\n${note.text}\n`),
  ].join("\n");

  navigator.clipboard?.writeText(markdown);
  showToast("已复制 Markdown");
}

function maybeAutoSavePaste() {
  clearTimeout(pasteTimer);
  if (!state.autoSavePaste) return;
  pasteTimer = setTimeout(saveNote, 260);
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
  saveState();
  render();
  setView("capture");
});

notesList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete]");
  if (!button) return;
  state.notes = state.notes.filter((note) => note.id !== button.dataset.delete);
  saveState();
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
autoSavePaste.checked = Boolean(state.autoSavePaste);
autoSavePaste.addEventListener("change", () => {
  state.autoSavePaste = autoSavePaste.checked;
  saveState();
  showToast(autoSavePaste.checked ? "已开启粘贴后自动存下" : "已关闭自动存下");
  noteInput.focus();
});
document.querySelector("#bookSwitch").addEventListener("click", () => setView("books"));
document.querySelector("#addBook").addEventListener("click", openBookForm);
document.querySelector("#cancelBook").addEventListener("click", closeBookForm);
bookForm.addEventListener("submit", addBook);
document.querySelector("#exportNotes").addEventListener("click", exportNotes);
document.querySelector("#syncOpen").addEventListener("click", () => setView("sync"));
document.querySelector("#syncClose").addEventListener("click", () => setView("capture"));

document.querySelectorAll("[data-sync]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector("#syncStatus").textContent = `${button.textContent}已准备，等待接入 WEREAD_API_KEY`;
  });
});

render();
updateInputMeta();
requestAnimationFrame(() => noteInput.focus());

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
