/* TikTok LIVE Auto Pin - popup controller */

const $ = (id) => document.getElementById(id);
const intervalInput = $("interval");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const pinNowBtn = $("pinNowBtn");
const statusEl = $("status");
const warnEl = $("warn");
const dot = $("dot");
const listEl = $("list");
const loadBtn = $("loadBtn");
const selAll = $("selAll");
const selNone = $("selNone");
const selHint = $("selHint");
const updateBanner = $("updateBanner");
const updLatest = $("updLatest");
const updNotes = $("updNotes");
const updLink = $("updLink");

let pollTimer = null;
let intervalSeeded = false; // only fill the input from storage once

let products = []; // [{slot, name, pinned}]
let selected = new Set(); // chosen slot numbers

// find the LIVE console tab (the one the content script runs in)
async function getLiveTab() {
  const tabs = await chrome.tabs.query({ url: "https://shop.tiktok.com/streamer/*" });
  const active = tabs.find((t) => t.active);
  return active || tabs[0] || null;
}

function send(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

// ---- product list rendering ------------------------------------------------
function renderProducts() {
  if (!products.length) {
    listEl.innerHTML =
      '<div class="empty">Click "Load products" to choose which products to pin.</div>';
    selHint.textContent = "";
    return;
  }
  listEl.innerHTML = "";
  for (const p of products) {
    const row = document.createElement("label");
    row.className = "item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(p.slot);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(p.slot);
      else selected.delete(p.slot);
      persistSelection();
      updateSelHint();
    });
    const slot = document.createElement("span");
    slot.className = "slot";
    slot.textContent = p.slot;
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = p.name;
    nm.title = p.name;
    row.appendChild(cb);
    row.appendChild(slot);
    row.appendChild(nm);
    if (p.pinned) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "pinned";
      row.appendChild(b);
    }
    listEl.appendChild(row);
  }
  updateSelHint();
}

function updateSelHint() {
  const n = selected.size;
  if (!products.length) {
    selHint.textContent = "";
  } else if (n === 0) {
    selHint.textContent = "None selected — rotation will use ALL products.";
  } else {
    selHint.textContent = `${n} of ${products.length} products selected.`;
  }
}

async function persistSelection() {
  const tab = await getLiveTab();
  if (!tab) return;
  await send(tab.id, { type: "setSelection", selected: [...selected] });
}

async function loadProducts() {
  const tab = await getLiveTab();
  if (!tab) return render(null);
  loadBtn.textContent = "Loading…";
  loadBtn.disabled = true;
  const resp = await send(tab.id, { type: "listProducts" });
  loadBtn.textContent = "Reload products from LIVE";
  loadBtn.disabled = false;
  if (!resp) return render(null);
  products = resp.products || [];
  // default: keep prior selection if any, otherwise select all
  const prior = new Set(resp.selected || []);
  selected = prior.size
    ? new Set([...prior].filter((s) => products.some((p) => p.slot === s)))
    : new Set(products.map((p) => p.slot));
  persistSelection();
  renderProducts();
  if (resp.status) render(resp.status);
}

// ---- status ----------------------------------------------------------------
function render(st) {
  if (!st) {
    warnEl.style.display = "block";
    statusEl.textContent = "Not connected to a LIVE console tab.";
    dot.classList.remove("on");
    startBtn.disabled = true;
    stopBtn.disabled = true;
    pinNowBtn.disabled = true;
    return;
  }
  warnEl.style.display = st.onConsole ? "none" : "block";
  startBtn.disabled = st.running;
  stopBtn.disabled = !st.running;
  pinNowBtn.disabled = false;
  dot.classList.toggle("on", st.running);

  const editing = document.activeElement === intervalInput;
  if (!intervalSeeded && !editing && typeof st.intervalSec === "number") {
    intervalInput.value = st.intervalSec;
    intervalSeeded = true;
  }

  const lines = [];
  lines.push(`Status: <b>${st.running ? "Running" : "Stopped"}</b>`);
  lines.push(`Rotating: <b>${st.rotationCount || 0}</b> of <b>${st.total || "–"}</b> products`);
  if (st.pointer) lines.push(`Last pinned slot: <b>#${st.pointer}</b>`);
  if (st.running) lines.push(`Next change in: <b>${st.secondsToNext}s</b>`);
  if (st.lastResult) lines.push(`Last action: <b>${st.lastResult}</b>`);
  statusEl.innerHTML = lines.join("<br>");
}

async function refresh() {
  const tab = await getLiveTab();
  if (!tab) return render(null);
  const st = await send(tab.id, { type: "status" });
  render(st);
}

async function withTab(msg) {
  const tab = await getLiveTab();
  if (!tab) return render(null);
  const st = await send(tab.id, msg);
  render(st);
}

// ---- events ----------------------------------------------------------------
startBtn.addEventListener("click", () => {
  const sec = Math.max(5, Math.min(3600, parseInt(intervalInput.value, 10) || 10));
  withTab({ type: "start", intervalSec: sec, selected: [...selected] });
});

stopBtn.addEventListener("click", () => withTab({ type: "stop" }));
pinNowBtn.addEventListener("click", () => withTab({ type: "pinNow" }));
loadBtn.addEventListener("click", loadProducts);

selAll.addEventListener("click", () => {
  selected = new Set(products.map((p) => p.slot));
  persistSelection();
  renderProducts();
});
selNone.addEventListener("click", () => {
  selected = new Set();
  persistSelection();
  renderProducts();
});

document.querySelectorAll(".quick button").forEach((b) => {
  b.addEventListener("click", () => {
    intervalInput.value = b.dataset.sec;
  });
});

// ---- update notifier -------------------------------------------------------
function renderUpdate(info) {
  if (info && info.hasUpdate && info.downloadUrl) {
    updLatest.textContent = "v" + info.latest;
    updNotes.textContent = info.notes ? "— " + info.notes : "";
    updLink.href = info.downloadUrl;
    updateBanner.classList.add("show");
  } else {
    updateBanner.classList.remove("show");
  }
}

async function checkUpdate() {
  // show last known result immediately
  try {
    const { updateInfo } = await chrome.storage.local.get("updateInfo");
    renderUpdate(updateInfo);
  } catch (_) {}
  // then ask the background worker to re-check now
  chrome.runtime.sendMessage({ type: "checkUpdate" }, (info) => {
    if (!chrome.runtime.lastError) renderUpdate(info);
  });
}

// poll status while popup is open so the countdown updates
pollTimer = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(pollTimer));

// auto-load the product list on open so the user can pick right away
(async () => {
  await refresh();
  await loadProducts();
  checkUpdate();
})();
