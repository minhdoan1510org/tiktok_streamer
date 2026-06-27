/* TikTok LIVE Auto Pin - content script
 *
 * Runs on the LIVE console product dashboard
 * (https://shop.tiktok.com/streamer/live/product/dashboard).
 *
 * The product list is rendered inside a *virtualized* container: only a few
 * rows exist in the DOM at any time, so to reach a given product we must
 * scroll the container until that product's row is rendered.
 *
 * Each product row carries a stable "slot number" (the small numbered input
 * box: 1, 2, 3, ...). We use that slot number as the product's identity.
 *
 * Rotation: round-robin through the user-selected slots (or all products if
 * none are selected). Pinning a product auto-replaces the previously pinned
 * one (TikTok LIVE allows only one pinned product).
 */
(() => {
  "use strict";

  const SEL = {
    // hashed suffix on the class changes between TikTok deploys, so match loosely
    container: '[class*="virtualized-container"]',
    pin: ".pc_pin_product_pin", // an unpinned product's "Pin" button
    unpin: ".pc_pin_product_unpin", // the currently pinned product's "Unpin" button
    listPin: ".pc_pin_product_list_pin", // bulk Pin in summary - never click for rotation
  };

  const STORAGE_KEY = "ttAutoPin";

  const state = {
    running: false,
    intervalSec: 10,
    selected: [], // slot numbers the user chose; empty = all products
    idx: -1, // current index within the rotation order
    pointer: 0, // last slot we pinned (for display)
    total: 0, // number of products (slots 1..total)
  };

  let loopTimer = null;
  let nextFireAt = 0;
  let busy = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[AutoPin]", ...a);

  // ---- persistence (per-tab) -----------------------------------------------
  // We use the page's sessionStorage, which is scoped to THIS tab: other tabs
  // keep their own independent settings, and the `running` flag is never
  // restored, so refreshing the tab auto-stops the rotation.
  function save() {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          intervalSec: state.intervalSec,
          selected: state.selected,
        })
      );
    } catch (_) {}
  }

  function load() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        state.intervalSec = s.intervalSec || 10;
        state.selected = Array.isArray(s.selected) ? s.selected : [];
      }
    } catch (_) {}
    // Always start stopped after a (re)load -> auto-stop on tab refresh.
    state.running = false;
    state.idx = -1;
    state.pointer = 0;
  }

  // ---- DOM helpers ---------------------------------------------------------
  function getContainer() {
    return document.querySelector(SEL.container);
  }

  // The virtualized rows are the direct children of the inner spacer element.
  // Walk up from a Pin/Unpin button to that row element so we capture the WHOLE
  // row (the slot-number box lives in a separate left column from the price).
  function rowOf(btn) {
    const container = getContainer();
    const inner = container && (container.children[0] || container);
    let el = btn;
    while (el && el.parentElement && el.parentElement !== inner) {
      el = el.parentElement;
    }
    return el && el.parentElement === inner ? el : btn.closest("div") || btn;
  }

  // Walk up from a Pin/Unpin button to the product "card" element
  // (the smallest ancestor that contains the price + stock text) - used for the
  // product NAME only (it excludes the filter bar in the pinned top block).
  function cardOf(btn) {
    let el = btn;
    for (let i = 0; i < 14 && el; i++) {
      const t = el.textContent || "";
      if (/Stock/i.test(t) && /đ|₫/.test(t) && t.length < 400) return el;
      el = el.parentElement;
    }
    return btn.closest("div") || btn;
  }

  // Extract a readable product title from a card.
  function nameOf(card) {
    let t = (card.textContent || "").replace(/\s+/g, " ").trim();
    // cut everything from the price / stock onward
    t = t.split(/\s*\d[\d.,]*\s*(?:đ|₫)/)[0];
    t = t.split(/Stock/i)[0];
    t = t.replace(/Hot deals/gi, "").trim();
    return t.slice(0, 80) || "(unnamed)";
  }

  // Read the slot number from a row. Unpinned product rows have exactly one
  // small numbered input; the pinned product (top block) has filter/search
  // inputs, so we only trust the slot for rows whose button is a "Pin" button.
  function slotOfRow(row) {
    const inp = row.querySelector('input[type="number"]') || row.querySelector("input");
    if (inp && inp.value !== "") {
      const v = parseInt(inp.value, 10);
      if (!isNaN(v)) return v;
    }
    return null;
  }

  // returns the rendered row for a given slot, or null if not rendered
  function findRenderedCard(slot) {
    const container = getContainer();
    if (!container) return null;
    const inner = container.children[0] || container;
    for (const block of inner.children) {
      const btn = block.querySelector(SEL.pin);
      if (!btn) continue; // only unpinned rows can be pinned (and carry a slot)
      const row = rowOf(btn);
      if (slotOfRow(row) === slot) return { card: row, btn };
    }
    return null;
  }

  // Scroll the virtualized list and build the full product catalog:
  // [{ slot, name, pinned }] sorted by slot. The currently pinned product has
  // no slot input, so we infer its slot from the gap in 1..max.
  async function scanProducts() {
    const container = getContainer();
    if (!container) return [];
    const inner = container.children[0] || container;

    const bySlot = new Map(); // slot -> name
    let pinnedName = null;

    const collect = () => {
      for (const block of inner.children) {
        const btn = block.querySelector(`${SEL.pin}, ${SEL.unpin}`);
        if (!btn) continue;
        const isPinned = btn.classList.contains("pc_pin_product_unpin");
        if (isPinned) {
          if (!pinnedName) pinnedName = nameOf(cardOf(btn));
          continue;
        }
        const slot = slotOfRow(rowOf(btn));
        if (slot != null && !bySlot.has(slot)) {
          bySlot.set(slot, nameOf(cardOf(btn)));
        }
      }
    };

    const orig = container.scrollTop;
    collect();
    for (let pos = 0; pos <= container.scrollHeight; pos += 250) {
      container.scrollTop = pos;
      await sleep(110);
      collect();
    }
    container.scrollTop = orig;
    await sleep(80);

    const present = [...bySlot.keys()];
    let max = present.length ? Math.max(...present) : 0;

    // infer the pinned product's slot (the missing number in 1..max)
    let pinnedSlot = null;
    for (let i = 1; i <= max; i++) {
      if (!bySlot.has(i)) {
        pinnedSlot = i;
        break;
      }
    }
    if (pinnedSlot == null && pinnedName) {
      // pinned product is beyond current max (e.g. only one product)
      pinnedSlot = max + 1;
      max = pinnedSlot;
    }
    if (pinnedSlot != null) {
      bySlot.set(pinnedSlot, pinnedName || `Product #${pinnedSlot}`);
    }

    return [...bySlot.entries()]
      .map(([slot, name]) => ({ slot, name, pinned: slot === pinnedSlot }))
      .sort((a, b) => a.slot - b.slot);
  }

  // dismiss a confirmation modal if TikTok shows one after clicking Pin.
  function confirmModalIfAny() {
    const modal = document.querySelector(
      ".arco-modal, [class*='modal-content'], [role='dialog']"
    );
    if (!modal) return false;
    const buttons = [...modal.querySelectorAll("button")];
    const ok = buttons.find((b) =>
      /^(confirm|ok|pin|yes|đồng ý|xác nhận|có)$/i.test(
        (b.textContent || "").trim()
      )
    );
    if (ok) {
      ok.click();
      return true;
    }
    return false;
  }

  // Pin the product at the given slot.
  // Returns: "pinned" | "already" | "not-found" | "no-container"
  async function pinSlot(slot) {
    const container = getContainer();
    if (!container) return "no-container";

    let hit = findRenderedCard(slot);
    if (!hit) {
      for (let pos = 0; pos <= container.scrollHeight; pos += 220) {
        container.scrollTop = pos;
        await sleep(110);
        hit = findRenderedCard(slot);
        if (hit) break;
      }
    }
    // Not found: the slot is most likely the one already pinned (pinned product
    // is lifted into a top block without a slot number).
    if (!hit) return "not-found";

    try {
      hit.card.scrollIntoView({ block: "center" });
    } catch (_) {}
    await sleep(180);

    const pinBtn = hit.card.querySelector(SEL.pin);
    if (!pinBtn) return "already"; // showing "Unpin" -> already pinned
    pinBtn.click();
    await sleep(250);
    confirmModalIfAny();
    await sleep(150);
    container.scrollTop = 0;
    return "pinned";
  }

  // ---- rotation loop -------------------------------------------------------
  // The slots to rotate through, in order.
  function rotationOrder() {
    if (state.selected && state.selected.length) {
      return state.selected.slice().sort((a, b) => a - b);
    }
    const all = [];
    for (let i = 1; i <= state.total; i++) all.push(i);
    return all;
  }

  async function tick() {
    if (!state.running || busy) return;
    busy = true;
    try {
      if (!getContainer()) {
        log("product list not found (are you on the LIVE console?)");
        return;
      }
      if (!state.total) {
        const prods = await scanProducts();
        state.total = prods.length ? Math.max(...prods.map((p) => p.slot)) : 0;
        log("discovered", state.total, "products");
      }

      const order = rotationOrder();
      if (!order.length) {
        log("no products to rotate");
        return;
      }

      let result = "not-found";
      for (let attempt = 0; attempt < order.length; attempt++) {
        state.idx = (state.idx + 1) % order.length;
        const slot = order[state.idx];
        result = await pinSlot(slot);
        log("pin slot", slot, "->", result);
        if (result === "pinned") {
          state.pointer = slot;
          break;
        }
        // "already"/"not-found" -> that slot is the currently pinned one; skip
      }
      save();
    } catch (e) {
      log("tick error", e);
    } finally {
      busy = false;
      scheduleNext();
    }
  }

  function scheduleNext() {
    clearTimeout(loopTimer);
    if (!state.running) return;
    nextFireAt = Date.now() + state.intervalSec * 1000;
    loopTimer = setTimeout(tick, state.intervalSec * 1000);
  }

  async function start(intervalSec, selected) {
    if (intervalSec && intervalSec > 0) state.intervalSec = intervalSec;
    if (Array.isArray(selected)) state.selected = selected;
    state.running = true;
    state.idx = -1; // restart rotation from the beginning of the selection
    save();
    log("started, interval", state.intervalSec, "s, selected", state.selected);
    clearTimeout(loopTimer);
    busy = false;
    await tick();
  }

  function stop() {
    state.running = false;
    clearTimeout(loopTimer);
    nextFireAt = 0;
    save();
    log("stopped");
  }

  function status() {
    return {
      running: state.running,
      intervalSec: state.intervalSec,
      selected: state.selected,
      pointer: state.pointer,
      total: state.total,
      rotationCount: rotationOrder().length,
      secondsToNext: state.running
        ? Math.max(0, Math.round((nextFireAt - Date.now()) / 1000))
        : 0,
      onConsole: !!getContainer(),
    };
  }

  // ---- messaging with popup ------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "start":
        start(msg.intervalSec, msg.selected);
        sendResponse(status());
        break;
      case "stop":
        stop();
        sendResponse(status());
        break;
      case "status":
        sendResponse(status());
        break;
      case "listProducts":
        (async () => {
          const products = await scanProducts();
          state.total = products.length
            ? Math.max(...products.map((p) => p.slot))
            : 0;
          save();
          sendResponse({ products, selected: state.selected, status: status() });
        })();
        return true;
      case "setSelection":
        state.selected = Array.isArray(msg.selected) ? msg.selected : [];
        save();
        sendResponse(status());
        break;
      case "pinNow":
        (async () => {
          if (!state.total) {
            const prods = await scanProducts();
            state.total = prods.length
              ? Math.max(...prods.map((p) => p.slot))
              : 0;
          }
          const order = rotationOrder();
          let r = "not-found";
          for (let attempt = 0; attempt < order.length; attempt++) {
            state.idx = (state.idx + 1) % order.length;
            r = await pinSlot(order[state.idx]);
            if (r === "pinned") {
              state.pointer = order[state.idx];
              break;
            }
          }
          save();
          sendResponse({ ...status(), lastResult: r });
        })();
        return true;
      default:
        sendResponse({ error: "unknown message" });
    }
    return true;
  });

  // ---- init ----------------------------------------------------------------
  // Load this tab's saved settings (interval + selection). Rotation stays
  // stopped until the user presses Start, including after a tab refresh.
  load();

  log("content script ready (stopped; per-tab settings loaded)");
})();
