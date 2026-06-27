/* TikTok LIVE Auto Pin - MAIN-world bridge
 *
 * Runs in the PAGE's main world (manifest world:"MAIN"). The content script
 * (isolated world) can't reliably call TikTok's APIs itself — its fetch runs in
 * a different context and the server returns an empty body (missing the cookies
 * / signing that the page's own fetch carries). So we perform the API calls
 * HERE, in the same context the page uses, and bridge results back to the
 * content script via window.postMessage.
 *
 * Protocol:
 *   content -> page:  {type:"AUTOPIN_REQ", reqId, action, payload}
 *   page -> content:  {type:"AUTOPIN_RES", reqId, ok, data | error}
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

  function getRoomId() {
    try {
      const m = document.documentElement.innerHTML.match(
        /room_id[\\"'\s:=]{1,8}(\d{15,25})/
      );
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  async function list() {
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

  async function getPin() {
    const room = getRoomId();
    if (!room) return null;
    const r = await fetch(BASE + "/pin/get?room_id=" + room + "&" + Q, {
      credentials: "include",
    });
    const j = await r.json();
    return j && j.code === 0 && j.product_id ? String(j.product_id) : null;
  }

  async function pin(productId) {
    const room = getRoomId();
    if (!room) return { ok: false, msg: "no room_id (not on a live console?)" };
    const r = await fetch(BASE + "/live_product/pin?" + Q, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room_id: room, product_id: String(productId), op: 1 }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: j.code === 0, code: j.code, msg: j.message };
  }

  async function handle(action, payload) {
    if (action === "list") return await list();
    if (action === "getPin") return await getPin();
    if (action === "pin") return await pin(payload && payload.productId);
    if (action === "roomId") return getRoomId();
    throw new Error("unknown action " + action);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.type !== "AUTOPIN_REQ") return;
    handle(d.action, d.payload).then(
      (data) =>
        window.postMessage({ type: "AUTOPIN_RES", reqId: d.reqId, ok: true, data }, "*"),
      (err) =>
        window.postMessage(
          { type: "AUTOPIN_RES", reqId: d.reqId, ok: false, error: String((err && err.message) || err) },
          "*"
        )
    );
  });

  window.__AUTOPIN_MAIN_READY = true;
})();
