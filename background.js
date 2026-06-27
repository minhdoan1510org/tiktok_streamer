/* TikTok LIVE Auto Pin - background service worker
 *
 * Checks a hosted version.json for a newer release and notifies the user via a
 * toolbar badge ("!") and a banner in the popup. This does NOT auto-install the
 * update (Load-unpacked extensions can't); it tells the user a new version
 * exists and links to the download.
 *
 * ┌─ SET THIS ────────────────────────────────────────────────────────────────
 * │ Point UPDATE_URL at a raw version.json you host. Example (GitHub):
 * │   https://raw.githubusercontent.com/<user>/<repo>/main/version.json
 * │ version.json format:
 * │   { "version": "1.1.0",
 * │     "downloadUrl": "https://github.com/<user>/<repo>/releases/latest",
 * │     "notes": "What changed" }
 * └────────────────────────────────────────────────────────────────────────────
 */

const UPDATE_URL =
  "https://raw.githubusercontent.com/minhdoan1510org/tiktok_streamer/main/version.json";

const CHECK_ALARM = "checkUpdate";
const CHECK_EVERY_MIN = 180; // every 3 hours

// numeric semver-ish comparison: returns 1 if a > b, -1 if a < b, 0 if equal
function cmpVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function isConfigured() {
  return UPDATE_URL && !/USER\/REPO/.test(UPDATE_URL);
}

async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  if (!isConfigured()) {
    await chrome.storage.local.set({
      updateInfo: { current, hasUpdate: false, configured: false },
    });
    return { current, hasUpdate: false, configured: false };
  }
  try {
    const res = await fetch(UPDATE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const latest = data.version || "0";
    const hasUpdate = cmpVersion(latest, current) > 0;
    const info = {
      current,
      latest,
      downloadUrl: data.downloadUrl || "",
      notes: data.notes || "",
      hasUpdate,
      configured: true,
      checkedAt: Date.now(),
    };
    await chrome.storage.local.set({ updateInfo: info });
    await chrome.action.setBadgeBackgroundColor({ color: "#d4393f" });
    await chrome.action.setBadgeText({ text: hasUpdate ? "!" : "" });
    return info;
  } catch (e) {
    // offline / bad URL: leave any previous result in place
    const prev = (await chrome.storage.local.get("updateInfo")).updateInfo;
    return prev || { current, hasUpdate: false, configured: true, error: true };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  checkForUpdate();
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_EVERY_MIN });
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdate();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) checkForUpdate();
});

// popup can ask for an immediate re-check
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "checkUpdate") {
    checkForUpdate().then(sendResponse);
    return true; // async response
  }
});
