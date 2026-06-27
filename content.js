/* TikTok LIVE Auto Pin - content script (API-based)
 *
 * Runs on the LIVE console (https://shop.tiktok.com/streamer/*).
 *
 * Instead of scraping the virtualized product list / clicking buttons, this
 * drives TikTok's own streamer APIs directly (same-origin fetch, uses the
 * logged-in cookies, no request signing required):
 *
 *   GET  /api/v1/streamer_desktop/live_product/list   -> products (id, title, order)
 *   GET  /api/v1/streamer_desktop/pin/get?room_id=..   -> currently pinned product_id
 *   POST /api/v1/streamer_desktop/live_product/pin     -> {room_id, product_id, op:1}
 *
 * room_id is read from the dashboard page's HTML. Rotation = round-robin over
 * the selected product_ids (or all products if none selected). Pinning a new
 * product automatically replaces the previous one.
 */
(() => {
  "use strict";

  const AID = "253642";
  const APP = "i18n_ecom_alliance";
  const BASE = "https://shop.tiktok.com/api/v1/streamer_desktop";
  const Q =
    "aid=" + AID +
    "&app_name=" + APP +
    "&device_platform=web&user_language=en-US&locale=en-US&page_scene=0";

  const STORAGE_KEY = "ttAutoPin";

  const state = {
    running: false,
    intervalSec: 10,
    selected: [], // chosen product_ids; empty = all products
    idx: -1, // current index within the rotation order
    currentId: null, // last product_id we pinned
    products: [], // [{ id, name, slot }] cached from the API
  };

  let loopTimer = null;
  let nextFireAt = 0;
  let busy = false;
  let cachedRoom = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[AutoPin]", ...a);

  // ---- persistence (per-tab) -----------------------------------------------
  // sessionStorage is scoped to THIS tab and survives a refresh, so settings +
  // run state persist per tab and the rotation auto-resumes after a reload.
  function save() {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          intervalSec: state.intervalSec,
          selected: state.selected,
          running: state.running,
          idx: state.idx,
          currentId: state.currentId,
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
        state.running = !!s.running;
        state.idx = typeof s.idx === "number" ? s.idx : -1;
        state.currentId = s.currentId || null;
      }
    } catch (_) {}
  }

  // ---- API helpers ---------------------------------------------------------
  // room_id is embedded in the dashboard HTML (e.g. ...room_id":"7655...").
  function getRoomId() {
    if (cachedRoom) return cachedRoom;
    try {
      const html = document.documentElement.innerHTML;
      const m = html.match(/room_id[\\"'\s:=]{1,8}(\d{15,25})/);
      cachedRoom = m ? m[1] : null;
    } catch (_) {
      cachedRoom = null;
    }
    return cachedRoom;
  }

  async function apiList() {
    const r = await fetch(BASE + "/live_product/list?" + Q, {
      credentials: "include",
    });
    const j = await r.json();
    if (!j || j.code !== 0 || !j.data) throw new Error("list code " + (j && j.code));
    return (j.data.products || []).map((p, i) => ({
      id: String(p.product_id),
      name: p.title || "Product " + (i + 1),
      slot: i + 1,
    }));
  }

  async function apiGetPin() {
    const room = getRoomId();
    if (!room) return null;
    try {
      const r = await fetch(BASE + "/pin/get?room_id=" + room + "&" + Q, {
        credentials: "include",
      });
      const j = await r.json();
      return j && j.code === 0 && j.product_id ? String(j.product_id) : null;
    } catch (_) {
      return null;
    }
  }

  async function apiPin(productId) {
    const room = getRoomId();
    if (!room) return { ok: false, msg: "no room_id (not on a live console?)" };
    try {
      const r = await fetch(BASE + "/live_product/pin?" + Q, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room_id: room, product_id: String(productId), op: 1 }),
      });
      const j = await r.json().catch(() => ({}));
      return { ok: j.code === 0, code: j.code, msg: j.message };
    } catch (e) {
      return { ok: false, msg: String((e && e.message) || e) };
    }
  }

  // ---- rotation ------------------------------------------------------------
  // product_ids to rotate, kept in the catalog's display order.
  function rotationOrder() {
    const ids = state.products.map((p) => p.id);
    if (state.selected && state.selected.length) {
      return ids.filter((id) => state.selected.includes(id));
    }
    return ids;
  }

  async function tick() {
    if (!state.running || busy) return;
    busy = true;
    try {
      // refresh the catalog at the start of each full cycle (and first run) so
      // added/removed/reordered products are picked up.
      if (!state.products.length || state.idx < 0) {
        try {
          state.products = await apiList();
        } catch (e) {
          log("list failed:", e.message);
        }
      }
      const order = rotationOrder();
      if (!order.length) {
        log("no products to rotate");
        return;
      }
      state.idx = (state.idx + 1) % order.length;
      const id = order[state.idx];
      const res = await apiPin(id);
      log("pin", id, res);
      if (res.ok) state.currentId = id;
      // when we wrap around, force a catalog refresh next cycle
      if (state.idx >= order.length - 1) {
        // refresh on next tick
        setTimeout(() => { state.products = []; }, 0);
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
    state.idx = -1; // restart from the beginning of the selection
    state.products = []; // force a fresh catalog
    save();
    log("started, interval", state.intervalSec, "s, selected", state.selected.length || "all");
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
    const cur = state.products.find((p) => p.id === state.currentId);
    return {
      running: state.running,
      intervalSec: state.intervalSec,
      selected: state.selected,
      total: state.products.length,
      rotationCount: rotationOrder().length,
      currentId: state.currentId,
      currentName: cur ? cur.name : null,
      secondsToNext: state.running
        ? Math.max(0, Math.round((nextFireAt - Date.now()) / 1000))
        : 0,
      onConsole: !!getRoomId(),
    };
  }

  // ---- messaging with popup ------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "start":
        start(msg.intervalSec, msg.selected).then(() => sendResponse(status()));
        return true;
      case "stop":
        stop();
        sendResponse(status());
        break;
      case "status":
        sendResponse(status());
        break;
      case "listProducts":
        (async () => {
          try {
            state.products = await apiList();
            const pinned = await apiGetPin();
            if (pinned) state.currentId = state.currentId || pinned;
            const products = state.products.map((p) => ({
              id: p.id,
              name: p.name,
              slot: p.slot,
              pinned: p.id === pinned,
            }));
            sendResponse({ products, selected: state.selected, status: status() });
          } catch (e) {
            sendResponse({
              products: [],
              selected: state.selected,
              status: status(),
              error: String((e && e.message) || e),
            });
          }
        })();
        return true;
      case "setSelection":
        state.selected = Array.isArray(msg.selected) ? msg.selected : [];
        save();
        sendResponse(status());
        break;
      case "pinNow":
        (async () => {
          try {
            if (!state.products.length) state.products = await apiList();
            const order = rotationOrder();
            if (!order.length) return sendResponse({ ...status(), lastResult: "no products" });
            state.idx = (state.idx + 1) % order.length;
            const res = await apiPin(order[state.idx]);
            if (res.ok) state.currentId = order[state.idx];
            save();
            sendResponse({ ...status(), lastResult: res.ok ? "pinned" : "fail: " + res.msg });
          } catch (e) {
            sendResponse({ ...status(), lastResult: "error: " + ((e && e.message) || e) });
          }
        })();
        return true;
      default:
        sendResponse({ error: "unknown message" });
    }
    return true;
  });

  // ---- init ----------------------------------------------------------------
  load();

  async function resumeIfRunning() {
    if (!state.running) return;
    log("resuming after refresh…");
    // wait until room_id is available in the page (SPA may render late)
    for (let i = 0; i < 30 && !getRoomId(); i++) await sleep(500);
    if (state.running) tick();
  }
  resumeIfRunning();

  log(
    "content script ready (API mode, " +
      (state.running ? "resuming" : "stopped") +
      ")"
  );
})();
