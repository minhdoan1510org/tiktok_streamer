# TikTok LIVE Auto Pin

A Chrome extension that **automatically rotates the pinned product** on your
TikTok Shop **LIVE console** at a fixed interval (round-robin).

While you're live, it cycles through every product in your LIVE product list,
pinning each one in turn — slot 1, then 2, then 3, … and back to 1 — so every
product gets screen time without you clicking **Pin** manually.

---

## Install (Load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `auto_pin_stream` folder.
4. The **TikTok LIVE Auto Pin** icon appears in your toolbar. (Pin it for easy
   access via the puzzle-piece menu.)

## Use

1. Start your LIVE and open the product dashboard:
   `https://shop.tiktok.com/streamer/live/product/dashboard?region=us`
2. Click the extension icon to open the popup. It auto-loads your LIVE product
   list.
3. Under **Products to rotate**, tick the products you want to cycle through.
   Use **All** / **None** for quick selection. (If you select none, it rotates
   through *all* products.)
4. Set **Change pin every … seconds** (or use a quick preset).
5. Click **Start**. The first selected product is pinned immediately, then it
   rotates through your selection on the interval.
6. Click **Stop** any time. **Pin next product now** does one manual rotation.

> The product list is virtualized, so the popup scrolls the list when it loads
> products and when it pins — that scrolling is normal and only affects your
> console view, not what viewers see.

The rotation keeps running as long as the LIVE console tab stays open — you can
close the popup.

**Per-tab & refresh behavior:**

- Settings + run state are saved **per tab** (in that tab's `sessionStorage`).
  Two LIVE tabs run independently and don't affect each other.
- **Refreshing the tab auto-resumes**: if rotation was running, it continues
  after the page reloads (with the same interval, product selection, and
  position) once the product list has rendered. State is cleared only when the
  tab is closed.

---

## How it works

The extension drives TikTok's own streamer APIs directly (same-origin `fetch`
using your logged-in cookies — no request signing required), instead of scraping
the virtualized DOM. This is fast, language-independent, and reliable.

| Purpose            | Endpoint                                             | Notes                                   |
| ------------------ | --------------------------------------------------- | --------------------------------------- |
| List products      | `GET /api/v1/streamer_desktop/live_product/list`    | returns `data.products[]` in slot order |
| Current pinned     | `GET /api/v1/streamer_desktop/pin/get?room_id=…`    | returns the pinned `product_id`         |
| Pin a product      | `POST /api/v1/streamer_desktop/live_product/pin`    | body `{room_id, product_id, op:1}`      |

- `room_id` is read from the dashboard page's HTML.
- Each product is identified by its stable `product_id`; rotation round-robins
  over the selected ids (or all products if none selected).
- Pinning a product automatically replaces the previously pinned one (TikTok
  LIVE allows only one pinned product at a time).

> If TikTok changes these endpoints, the picker will show an "API error" and
> nothing will pin — check the `[AutoPin]` logs in the LIVE page DevTools
> console and update the endpoint paths / params in `content.js`.

---

## Update notifications (for Load-unpacked distribution)

Load-unpacked extensions can't auto-install updates, so this extension tells
users when a newer version exists and links them to the download.

**How it works:** a background worker checks a hosted `version.json` every few
hours (and when the popup opens). If the hosted `version` is higher than the
installed `manifest.json` version, the toolbar icon shows a red **!** badge and
the popup shows an **"Update available"** banner with a **Download** button.

### One-time setup (you, the publisher)

1. Host this repo somewhere public (e.g. GitHub).
2. Edit **`background.js`** → set `UPDATE_URL` to your raw `version.json`, e.g.
   `https://raw.githubusercontent.com/<user>/<repo>/main/version.json`
   (If you host elsewhere, also add that host to `host_permissions` in
   `manifest.json`.)
3. Make sure `version.json` `downloadUrl` points to where users get the new zip
   (e.g. your GitHub **Releases** page).

### Releasing a new version

1. Make your code changes.
2. Bump `"version"` in **`manifest.json`** (e.g. `1.0.0` → `1.1.0`).
3. Update **`version.json`**: set the same new `version`, and a short `notes`.
4. Publish the new zip at your `downloadUrl` (e.g. attach it to a GitHub Release)
   and push the updated `version.json`.

Within a few hours every user sees the **!** badge. They click **Download**, get
the new zip, and reload it via `chrome://extensions` → **Load unpacked** (or
drag-drop). `manifest.json` and `version.json` must always carry the **same**
version number for the prompt to clear after they update.

> Tip: if you'd rather have *silent* auto-updates with no manual reload, publish
> to the Chrome Web Store (Unlisted is fine) — then Chrome updates everyone
> automatically and this notifier isn't needed.

## Troubleshooting

- **Popup says "Not connected"** — make sure the LIVE console product dashboard
  tab is open and you reload it once after installing the extension (content
  scripts only inject on load).
- **"Products detected: –" or 0** — the product list hadn't rendered yet. Make
  sure products are loaded in the list, then press **Start** again.
- **Nothing pins / TikTok changed their UI** — open DevTools console on the LIVE
  page and look for `[AutoPin]` logs. If the class names changed, update the
  selectors in `content.js` (see the table above).
- **A confirmation dialog appears** — the extension tries to auto-confirm common
  dialogs, but if TikTok adds a new one, let me know the button text.

## Notes / limits

- This automates clicks in **your own** logged-in browser session; it uses no
  TikTok API and stores no credentials.
- It only reaches products in the LIVE product list (slots `1..N`); it does not
  add products to the LIVE.
- Tested against the LIVE Manager product dashboard as of June 2026. TikTok
  ships UI changes frequently — selectors may need occasional updates.
