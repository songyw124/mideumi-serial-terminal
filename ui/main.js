const { invoke, Channel } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;
const $ = (id) => document.getElementById(id);

// This desktop webview reports MacIntel on both Intel and Apple Silicon Macs.
// Overlay/hiddenTitle are macOS-only Tauri options; other OSes keep native chrome.
const isMac = navigator.platform.startsWith("Mac");
document.documentElement.classList.toggle("macos", isMac);
$("windowTitle").textContent = document.title;

// First matching rule colours the line. Edit to taste.
const HIGHLIGHTS = [
  { re: /error|fail|fault|assert|hardfault/i, cls: "hl-error" },
  { re: /warn/i, cls: "hl-warn" },
  { re: /\bok\b|success|done|passed/i, cls: "hl-ok" },
];

const BAUD_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000, 4000000,
];
const LINE_ENDINGS = {
  none: { label: "No ending", text: "" },
  lf: { label: "LF", text: "\n" },
  cr: { label: "CR", text: "\r" },
  crlf: { label: "CR+LF", text: "\r\n" },
};
const OVERSCAN = 20; // extra lines rendered above/below the visible area
const FONT_PT_MIN = 6;
const FONT_PT_MAX = 36;
const FONT_PT_STEP = 0.5;
const SETTINGS_KEY = "mideumi-serial-terminal.settings";

const DEFAULTS = {
  port: "",
  baud: 115200,
  font: "monospace",
  fontPt: 10,
  bufferSize: 100000,
  timestamps: true,
  wrap: true,
  lineEnding: "crlf",
};

const settings = loadSettings();

let lines = [];     // { seq, ts, text, cls, rows, rowsCpr }
let filtered = [];  // subset of `lines` matching filterRe (only maintained while a filter is set)
let filterRe = null;
let nextSeq = 0;

// Layout of the shown lines, in rows (a wrapped line spans several rows).
// tops[i] is the first row of currentView()[i]; values only grow, the first shown line starts at base().
let tops = [];
let rowEnd = 0;
let cpr = Infinity; // characters per row; Infinity when not wrapping
let lineHeight = 18; // px per row
let viewWidth = 0;

let follow = true;
let renderQueued = false;
let connected = false;
let rxBytes = 0;
let txBytes = 0;
let mouseDown = false;     // left button held in the view, i.e. probably selecting text
const rendered = new Map(); // seq -> row element currently in the DOM
const history = [];
let historyPos = 0;

const view = $("view");
const spacer = $("spacer");
const rows = $("rows");

// ---------------------------------------------------------------------------
// Settings

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)
      ?? localStorage.getItem("uart-viewer.settings") ?? "{}");
    delete stored.fontSize; // old px setting, replaced by fontPt
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable; settings just won't persist
  }
}

function formatPt(pt) {
  return pt.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function setFontPt(pt) {
  if (Number.isNaN(pt)) pt = settings.fontPt;
  settings.fontPt = Math.round(Math.min(FONT_PT_MAX, Math.max(FONT_PT_MIN, pt)) * 10) / 10;
  $("fontSize").value = formatPt(settings.fontPt);
  saveSettings();
  relayout(applyFont);
}

function applyFont() {
  lineHeight = Math.ceil(((settings.fontPt * 4) / 3) * 1.4);
  const root = document.documentElement.style;
  // Generic families must remain unquoted to select the platform's default.
  root.setProperty("--font", settings.font === "monospace" ? "monospace" : JSON.stringify(settings.font));
  root.setProperty("--font-size", settings.fontPt + "pt");
  root.setProperty("--lh", lineHeight + "px");
}

function initFontMenu() {
  const menu = $("font");
  const context = document.createElement("canvas").getContext("2d");
  // Compare against different fallbacks: an absent font uses each fallback's
  // metrics, while an installed font supplies its own metrics in both cases.
  // document.fonts.check() also returns true for nonexistent system fonts.
  const samples = ["mmmmmmmmWWWWiiiiiiii", "0123456789 .,:;+-_/"];
  const fallbacks = ["serif", "monospace"];
  const widths = (family) => {
    context.font = `72px ${family}`;
    return samples.map((text) => context.measureText(text).width);
  };
  const baseline = context && fallbacks.map(widths);
  const available = (font) => font === "monospace" || !context || fallbacks.some((fallback, i) =>
    widths(`${JSON.stringify(font)}, ${fallback}`).some((width, j) =>
      Math.abs(width - baseline[i][j]) > 0.01));

  // Keep an installed saved font even if it isn't in the built-in shortlist.
  if (!Array.from(menu.options).some((option) => option.value === settings.font)) {
    menu.add(new Option(settings.font, settings.font));
  }
  for (const option of Array.from(menu.options)) {
    if (!available(option.value)) option.remove();
  }
  // Ensure the menu and the rendered font agree if a saved font is unavailable.
  menu.value = settings.font;
  if (!menu.value) {
    settings.font = "monospace";
    menu.value = settings.font;
  }
}

// ---------------------------------------------------------------------------
// Line buffer

function currentView() {
  return filterRe ? filtered : lines;
}

function classify(text) {
  for (const h of HIGHLIGHTS) if (h.re.test(text)) return h.cls;
  return "";
}

function appendLines(batch, cls) {
  for (const l of batch) {
    const line = { seq: nextSeq++, ts: l.ts, text: l.text, cls: cls ?? classify(l.text) };
    lines.push(line);
    if (filterRe) {
      if (!filterRe.test(line.text)) continue;
      filtered.push(line);
    }
    tops.push(rowEnd);
    rowEnd += rowsOf(line);
  }
  trim();
  scheduleRender();
}

function appendSystem(text) {
  appendLines([{ ts: Date.now(), text: `--- ${text} ---` }], "sys");
}

// Drops the oldest lines beyond the buffer size, keeping the view still if the user scrolled up
function trim() {
  const excess = lines.length - settings.bufferSize;
  if (excess <= 0) return;
  const oldBase = base();
  lines.splice(0, excess);
  let removed = excess;
  if (filterRe) {
    const firstSeq = lines.length ? lines[0].seq : nextSeq;
    removed = 0;
    while (removed < filtered.length && filtered[removed].seq < firstSeq) removed++;
    filtered.splice(0, removed);
  }
  tops.splice(0, removed);
  const removedRows = base() - oldBase;
  if (!follow && removedRows > 0) view.scrollTop -= removedRows * lineHeight;
}

function clearLines() {
  lines = [];
  filtered = [];
  tops = [];
  rowEnd = 0;
  rxBytes = 0;
  txBytes = 0;
  setFollow(true);
  resetRows();
  updateStatus();
}

function setFilter(value) {
  const input = $("filter");
  if (input.value !== value) input.value = value; // only when cleared from elsewhere, so typing keeps the caret
  input.classList.remove("invalid");
  input.classList.toggle("active", !!value);
  $("filterText").textContent = value;
  if (!value) {
    filterRe = null;
  } else {
    try {
      filterRe = new RegExp(value, "i");
    } catch {
      input.classList.add("invalid");
      filterRe = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  }
  filtered = filterRe ? lines.filter((l) => filterRe.test(l.text)) : [];
  rebuildTops();
  resetRows();
  updateStatus();
}

// ---------------------------------------------------------------------------
// Layout. The view is monospace, so a wrapped line's row count follows from its length:
// no per-line DOM measuring needed, which keeps scrolling fast with big buffers.

function base() {
  return tops.length ? tops[0] : rowEnd;
}

// Display columns of a text: tabs jump to the next multiple of 8, East Asian wide characters take 2
function textColumns(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let col = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (ch === "\t") col += 8 - (col % 8);
    else if (c >= 0x1100 && /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch)) col += 2;
    else col += 1;
  }
  return col;
}

function rowsOf(line) {
  if (line.rowsCpr !== cpr) {
    line.rows = cpr === Infinity ? 1 : Math.max(1, Math.ceil(textColumns(line.text) / cpr));
    line.rowsCpr = cpr;
  }
  return line.rows;
}

function rebuildTops() {
  const shown = currentView();
  tops = new Array(shown.length);
  let r = 0;
  for (let i = 0; i < shown.length; i++) {
    tops[i] = r;
    r += rowsOf(shown[i]);
  }
  rowEnd = r;
}

// Index of the shown line containing absolute row `row`
function indexAtRow(row) {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= row) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// How many characters fit in the message column, measured on a hidden probe row
function measureCharsPerRow() {
  const probe = document.createElement("div");
  probe.className = "row";
  probe.style.visibility = "hidden";
  if (settings.timestamps) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = "00:00:00.000";
    probe.appendChild(ts);
  }
  const msg = document.createElement("span");
  msg.className = "msg";
  const ruler = document.createElement("span");
  ruler.style.cssText = "display:inline-block;white-space:pre";
  ruler.textContent = "0".repeat(200);
  msg.appendChild(ruler);
  probe.appendChild(msg);
  rows.appendChild(probe);
  const charWidth = ruler.getBoundingClientRect().width / 200;
  const msgWidth = msg.getBoundingClientRect().width;
  probe.remove();
  // Erring low only leaves a little slack at the end of a row; erring high would clip text
  return Math.max(8, Math.floor((msgWidth - 1) / charWidth));
}

// Re-lays out after anything that changes row sizes (font, wrap, width, timestamps), keeping the top line in place
function relayout(change) {
  const anchor = !follow && tops.length ? indexAtRow(base() + view.scrollTop / lineHeight) : null;
  change?.();
  view.classList.toggle("wrap", settings.wrap);
  const newCpr = settings.wrap ? measureCharsPerRow() : Infinity;
  if (newCpr !== cpr) {
    cpr = newCpr;
    rebuildTops();
    resetRows();
  }
  spacer.style.height = (rowEnd - base()) * lineHeight + "px";
  if (anchor !== null) view.scrollTop = (tops[anchor] - base()) * lineHeight;
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Rendering (virtualized: only the lines in view exist in the DOM)

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function setFollow(value) {
  follow = value;
  $("follow").checked = value;
  scheduleRender();
}

// Drops all row elements; needed when the shown lines change other than by append/trim
function resetRows() {
  rendered.clear();
  rows.replaceChildren();
  scheduleRender();
}

function render() {
  renderQueued = false;
  const shown = currentView();
  const b = base();
  spacer.style.height = (rowEnd - b) * lineHeight + "px";
  if (follow && !mouseDown) view.scrollTop = view.scrollHeight;

  let first = 0;
  let last = 0;
  if (shown.length) {
    const topRow = b + view.scrollTop / lineHeight;
    first = Math.max(0, indexAtRow(topRow) - OVERSCAN);
    last = Math.min(shown.length, indexAtRow(topRow + view.clientHeight / lineHeight) + 1 + OVERSCAN);
    rows.style.transform = `translateY(${(tops[first] - b) * lineHeight}px)`;
  }

  // Rows that stay in view keep their elements, so a text selection in them survives new data arriving.
  // Lines only get appended/trimmed, so the kept rows are always one contiguous run in the middle.
  const want = shown.slice(first, last);
  const wantSeqs = new Set(want.map((l) => l.seq));
  for (const [seq, el] of rendered) {
    if (!wantSeqs.has(seq)) {
      el.remove();
      rendered.delete(seq);
    }
  }
  let i = 0;
  const head = document.createDocumentFragment();
  for (; i < want.length && !rendered.has(want[i].seq); i++) head.appendChild(makeRow(want[i]));
  rows.insertBefore(head, rows.firstChild);
  while (i < want.length && rendered.has(want[i].seq)) i++;
  const tail = document.createDocumentFragment();
  for (; i < want.length; i++) tail.appendChild(makeRow(want[i]));
  rows.appendChild(tail);

  updateStatus();
}

function makeRow(line) {
  const div = document.createElement("div");
  div.className = line.cls ? "row " + line.cls : "row";
  const n = rowsOf(line);
  if (n > 1) div.style.setProperty("--rows", n);
  if (settings.timestamps) {
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = formatTime(line.ts);
    div.appendChild(ts);
  }
  const msg = document.createElement("span");
  msg.className = "msg";
  appendMessageText(msg, line.text);
  div.appendChild(msg);
  rendered.set(line.seq, div);
  return div;
}

// Called only for visible rows. Use text nodes rather than parsing serial data
// as HTML; marks must preserve the original text and monospace layout.
function appendMessageText(msg, text) {
  if (!filterRe) {
    msg.textContent = text;
    return;
  }
  const matches = new RegExp(filterRe.source, "gi");
  let end = 0;
  for (const match of text.matchAll(matches)) {
    // Anchors/lookarounds may match no characters. matchAll advances safely;
    // there is no visible text to mark for those matches.
    if (!match[0].length) continue;
    if (match.index > end) msg.append(document.createTextNode(text.slice(end, match.index)));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    msg.append(mark);
    end = match.index + match[0].length;
  }
  if (end < text.length) msg.append(document.createTextNode(text.slice(end)));
}

function formatTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Renders a number as one span per 3-digit group; the gap comes from CSS, so the text itself has no spaces
function groupedDigits(n) {
  const s = String(n);
  const frag = document.createDocumentFragment();
  for (let start = 0, end = s.length % 3 || 3; start < s.length; start = end, end += 3) {
    const span = document.createElement("span");
    span.className = "digit-group";
    span.textContent = s.slice(start, end);
    frag.appendChild(span);
  }
  return frag;
}

// Refreshes the digit-grouped overlay of a .numbox input
function updateNumDisplay(input) {
  input.parentElement.querySelector(".num-display").replaceChildren(groupedDigits(input.value));
}

// Parses a .numbox input, clamps it, writes the cleaned value back and returns it
function readNumBox(input, fallback, min = 1, max = Infinity) {
  const value = parseInt(input.value.replace(/\D/g, ""), 10);
  const result = Number.isNaN(value) ? fallback : Math.min(max, Math.max(min, value));
  input.value = result;
  updateNumDisplay(input);
  return result;
}

function commitBaud() {
  settings.baud = readNumBox($("baud"), settings.baud || DEFAULTS.baud);
  saveSettings();
}

// Opens a popup menu; items are { value, content (string or node), active }
function openMenu(menu, items, onPick) {
  closeMenus();
  menu.replaceChildren(
    ...items.map((it) => {
      const item = document.createElement("button");
      if (it.active) item.className = "active";
      item.append(it.content);
      item.onclick = () => {
        onPick(it.value);
        closeMenus();
      };
      return item;
    }),
  );
  menu.hidden = false;
  menu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function closeMenus() {
  for (const m of document.querySelectorAll(".menu")) m.hidden = true;
}

function toggleBaudMenu() {
  const menu = $("baudMenu");
  if (!menu.hidden) return closeMenus();
  const items = BAUD_RATES.map((rate) => ({ value: rate, content: groupedDigits(rate), active: rate === settings.baud }));
  openMenu(menu, items, (rate) => {
    $("baud").value = rate;
    commitBaud();
  });
}

function toggleLineEndingMenu() {
  const menu = $("lineEndingMenu");
  if (!menu.hidden) return closeMenus();
  const items = Object.entries(LINE_ENDINGS).map(([value, le]) => ({
    value,
    content: le.label,
    active: value === settings.lineEnding,
  }));
  openMenu(menu, items, (value) => {
    setLineEnding(value);
    saveSettings();
  });
}

function setLineEnding(value) {
  settings.lineEnding = value in LINE_ENDINGS ? value : DEFAULTS.lineEnding;
  $("lineEnding").textContent = LINE_ENDINGS[settings.lineEnding].label + " ▾";
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function updateStatus() {
  const parts = [];
  parts.push([groupedDigits(lines.length), " lines"]);
  parts.push([`RX ${formatBytes(rxBytes)}`]);
  parts.push([`TX ${formatBytes(txBytes)}`]);

  const status = $("status");
  status.replaceChildren();
  parts.forEach((p, i) => {
    if (i) status.append("  ·  ");
    status.append(...p);
  });

  $("filterBar").hidden = !filterRe;
  if (filterRe) {
    $("filterShown").replaceChildren(groupedDigits(filtered.length));
    $("filterTotal").replaceChildren(groupedDigits(lines.length));
  }
}

// ---------------------------------------------------------------------------
// Serial

async function refreshPorts() {
  const select = $("port");
  let ports = [];
  try {
    ports = await invoke("list_ports");
  } catch (e) {
    appendSystem(`Port list failed: ${e}`);
  }
  select.replaceChildren(
    ...ports.map((p) => new Option(p.description ? `${p.name} – ${p.description}` : p.name, p.name)),
  );
  if (ports.some((p) => p.name === settings.port)) select.value = settings.port;
  updatePortTitle();
}

// The picker is narrow, so the full port description goes in the tooltip
function updatePortTitle() {
  const select = $("port");
  select.title = select.selectedOptions[0]?.text ?? "Serial port";
}

function setConnected(value) {
  connected = value;
  const btn = $("connect");
  btn.querySelector("span").textContent = value ? "Disconnect" : "Connect";
  btn.classList.toggle("connected", value);
  $("port").disabled = value;
  $("baud").disabled = value;
  $("baudPick").disabled = value;
  if (value) closeMenus();
  $("refresh").disabled = value;
  updateStatus();
}

function onSerialEvent(msg) {
  if (msg.kind === "lines") {
    rxBytes += msg.bytes;
    appendLines(msg.lines);
  } else if (msg.kind === "closed") {
    if (connected) {
      setConnected(false);
      appendSystem(msg.error ? `Disconnected: ${msg.error}` : "Disconnected");
      invoke("disconnect").catch(() => {});
    }
  }
}

async function toggleConnection() {
  if (connected) {
    setConnected(false);
    await invoke("disconnect");
    appendSystem("Disconnected");
    return;
  }

  settings.port = $("port").value;
  commitBaud();
  if (!settings.port) {
    appendSystem("No port selected");
    return;
  }

  const channel = new Channel();
  channel.onmessage = onSerialEvent;
  try {
    await invoke("connect", { port: settings.port, baud: settings.baud, onEvent: channel });
    setConnected(true);
    appendSystem(`Connected to ${settings.port} @ ${settings.baud} bps`);
  } catch (e) {
    appendSystem(`Connect failed: ${e}`);
  }
}

async function sendLine() {
  const input = $("sendText");
  const text = input.value;
  if (!connected) {
    appendSystem("Not connected");
    return;
  }
  try {
    const data = text + LINE_ENDINGS[settings.lineEnding].text;
    await invoke("send", { data });
    txBytes += new TextEncoder().encode(data).length;
    appendLines([{ ts: Date.now(), text: "> " + text }], "tx");
    if (text && history[history.length - 1] !== text) history.push(text);
    historyPos = history.length;
    input.value = "";
  } catch (e) {
    appendSystem(`Send failed: ${e}`);
  }
}

async function saveBuffer() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${formatTime(d).replace(/[:.]/g, "").slice(0, 6)}`;
  const path = await dialog.save({
    defaultPath: `serial-log-${stamp}.txt`,
    filters: [{ name: "Text files", extensions: ["txt"] }],
  });
  if (!path) return;
  const contents = currentView()
    .map((l) => (settings.timestamps ? formatTime(l.ts) + "  " : "") + l.text)
    .join("\n");
  try {
    await invoke("save_text", { path, contents: contents + "\n" });
    appendSystem(`Saved ${currentView().length.toLocaleString()} lines to ${path}`);
  } catch (e) {
    appendSystem(`Save failed: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Wiring

function init() {
  initFontMenu();
  $("baud").value = settings.baud;
  updateNumDisplay($("baud"));
  $("font").value = settings.font;
  $("fontSize").value = formatPt(settings.fontPt);
  $("bufferSize").value = settings.bufferSize;
  updateNumDisplay($("bufferSize"));
  $("timestamps").checked = settings.timestamps;
  $("wrap").checked = settings.wrap;
  $("follow").checked = follow;
  setLineEnding(settings.lineEnding);

  $("connect").onclick = toggleConnection;
  $("refresh").onclick = refreshPorts;
  $("port").onchange = updatePortTitle;
  $("clear").onclick = clearLines;
  $("save").onclick = saveBuffer;
  $("send").onclick = sendLine;

  document.addEventListener("dragstart", (e) => {
    if (!e.target.closest?.(".msg, input, textarea")) e.preventDefault();
  });

  $("filter").oninput = (e) => setFilter(e.target.value);
  $("filter").addEventListener("keydown", (e) => {
    if (e.key === "Escape") setFilter("");
  });
  $("filterClear").onclick = () => setFilter("");

  $("timestamps").onchange = (e) => {
    settings.timestamps = e.target.checked;
    saveSettings();
    resetRows();
    relayout(); // the message column width changes
  };
  $("wrap").onchange = (e) => {
    settings.wrap = e.target.checked;
    saveSettings();
    relayout();
  };
  $("follow").onchange = (e) => setFollow(e.target.checked);

  // Hold the view still while drag-selecting; keep auto-scroll off afterwards if something got selected
  view.addEventListener("mousedown", (e) => {
    if (e.button === 0) mouseDown = true;
  });
  document.addEventListener("mouseup", () => {
    if (!mouseDown) return;
    mouseDown = false;
    const sel = window.getSelection();
    if (!sel.isCollapsed && view.contains(sel.anchorNode)) setFollow(false);
    else scheduleRender();
  });

  $("font").onchange = (e) => {
    settings.font = e.target.value;
    saveSettings();
    relayout(applyFont);
  };
  // Accepts "12,7" as well as "12.7"; Up/Down step it
  $("fontSize").onchange = (e) => setFontPt(parseFloat(e.target.value.replace(",", ".")));
  $("fontSize").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setFontPt(settings.fontPt + (e.key === "ArrowUp" ? FONT_PT_STEP : -FONT_PT_STEP));
    }
  });

  $("bufferSize").onchange = (e) => {
    settings.bufferSize = readNumBox(e.target, settings.bufferSize, 1000, 1000000);
    saveSettings();
    trim();
    scheduleRender();
  };
  $("lineEnding").onclick = toggleLineEndingMenu;
  $("baud").onchange = commitBaud;
  for (const input of document.querySelectorAll(".num")) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.target.blur();
    });
  }
  $("baudPick").onclick = toggleBaudMenu;
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".menu, .menu-toggle")) closeMenus();
  });

  // Scrolling back to the bottom resumes auto-scroll; leaving it (e.g. dragging the scrollbar) pauses it
  view.addEventListener("scroll", () => {
    const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - lineHeight;
    if (atBottom !== follow) setFollow(atBottom);
    else scheduleRender();
  });
  new ResizeObserver(() => {
    if (view.clientWidth !== viewWidth) {
      viewWidth = view.clientWidth;
      if (settings.wrap) relayout();
    }
    scheduleRender();
  }).observe(view);

  view.addEventListener("wheel", (e) => {
    if (e.ctrlKey) {
      // Ctrl+wheel zooms the text
      e.preventDefault();
      setFontPt(settings.fontPt + (e.deltaY < 0 ? FONT_PT_STEP : -FONT_PT_STEP));
    } else if (e.deltaY < 0 && follow) {
      // Pause right away: smooth scrolling moves only a few px per frame, which new data would otherwise undo
      setFollow(false);
    }
  }, { passive: false });

  $("sendText").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      sendLine();
    } else if (e.key === "ArrowUp" && historyPos > 0) {
      e.target.value = history[--historyPos];
      e.preventDefault();
    } else if (e.key === "ArrowDown" && historyPos < history.length) {
      e.target.value = history[++historyPos] ?? "";
      e.preventDefault();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      clearLines();
    }
    // Scrolling up with the keyboard pauses auto-scroll too
    const inField = e.target.closest?.("input, select, textarea");
    if (!inField && ["ArrowUp", "PageUp", "Home"].includes(e.key) && follow) setFollow(false);
  });

  applyFont();
  relayout();
  refreshPorts();
  updateStatus();
}

init();
