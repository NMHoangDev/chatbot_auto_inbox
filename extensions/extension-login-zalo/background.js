/**
 * Zalo QR Login Extension — Background Service Worker
 *
 * Responsibilities:
 * 1. Listen for messages from content script (QR captured, login detected)
 * 2. Extract cookies from Zalo domains via chrome.cookies API
 * 3. Send session data to backend API
 * 4. Manage extension state (tab tracking, polling)
 */

// ─── State ───────────────────────────────────────────────────────────
let zaloTabId = null;
let loginStatus = "idle"; // idle | opening | waiting_scan | confirmed | error
let lastQrDataUrl = "";
let pollIntervalId = null;
let syncInProgress = false;
let keepAliveIntervalId = null;
let isExtInitiated = false; // Track if the tab was opened by the extension

// When IMPORT_ZALO_SESSION is in-progress, skip the default auto-sync in
// handleContentResponse — the caller handles extract+POST with the correct
// backend_url / owner_id coming from ZaloPersonal.vue.
let importZaloInProgress = false;

// ─── Helpers ─────────────────────────────────────────────────────────
// Keep service worker alive during long sync (Chrome MV3 unloads SW after 30s idle)
function startKeepAlive() {
  stopKeepAlive();
  keepAliveIntervalId = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
}

function timeoutPromise(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

function log(...args) {
  // Single prefix to make filtering easier in DevTools
  console.log("[ZaloExt]", ...args);
}
function logErr(...args) {
  console.error("[ZaloExt]", ...args);
}
// ─── SW State Persistence ─────────────────────────────────────────

// Domain của các project markee KHÁC (không phải project này) từng bị lưu
// nhầm vào backendUrl — do dùng chung 1 bản extension cho nhiều project khi
// test trên cùng máy. Bất kỳ giá trị nào khớp regex này đều phải rewrite về
// đúng backend của project hiện tại (chatbot_auto_inbox / zalo-forward-demo).
const OTHER_PROJECT_BACKEND_RE = /(^|\/\/|@)(mabuu|timetech|seeding)\.markeeai\.com/i;
const THIS_PROJECT_BACKEND_URL = "https://chatbot-inbox.markeeai.com/zalo-bridge";

/**
 * One-shot migration: tự sửa backendUrl đã lưu trong chrome.storage.local
 * khi user dùng chung extension với project markee khác (mabuu/timetech/
 * seeding.markeeai.com) — rewrite về đúng backend của project này.
 * Migration chạy 1 lần/session (đánh dấu bằng key `_backendUrlMigratedV2`)
 * để tránh chiếm tài nguyên; đổi tên flag so với bản cũ (`_mabuuToTimetechMigrated`)
 * để user đã từng migrate sang timetech (giờ CŨNG sai với project này) được
 * quét lại đúng 1 lần.
 */
async function migrateLegacyBackendUrl() {
  try {
    const { _backendUrlMigratedV2, backendUrl } = await chrome.storage.local.get([
      "_backendUrlMigratedV2",
      "backendUrl",
    ]);
    if (_backendUrlMigratedV2) return;
    if (backendUrl && OTHER_PROJECT_BACKEND_RE.test(backendUrl)) {
      log(`migrateLegacyBackendUrl: ${backendUrl} -> ${THIS_PROJECT_BACKEND_URL}`);
      await chrome.storage.local.set({ backendUrl: THIS_PROJECT_BACKEND_URL });
    }
    await chrome.storage.local.set({ _backendUrlMigratedV2: true });
  } catch (e) {
    logErr("migrateLegacyBackendUrl failed", e);
  }
}

async function loadState() {
  await migrateLegacyBackendUrl();
  const s = await chrome.storage.session.get([
    'loginStatus',
    'lastQrDataUrl',
    'zaloTabId',
    'isExtInitiated',
    'importZaloInProgress'
  ]);
  loginStatus = s.loginStatus || 'idle';
  lastQrDataUrl = s.lastQrDataUrl || '';
  zaloTabId = s.zaloTabId ? Number(s.zaloTabId) : null;
  isExtInitiated = s.isExtInitiated || false;
  importZaloInProgress = s.importZaloInProgress || false;
}

async function persistState() {
  await chrome.storage.session.set({
    loginStatus,
    lastQrDataUrl,
    zaloTabId,
    isExtInitiated,
    importZaloInProgress
  });
}

// Khởi động SW → load lại state
loadState();

async function getSettings() {
  const result = await chrome.storage.local.get([
    "backendUrl",
    "apiKey",
    "userId",
    "inboxId",
  ]);
  // Defensive: nếu storage còn URL của project markee khác (do extension cũ /
  // chưa migrate / dùng chung máy test nhiều project), rewrite ngay tại đây —
  // không đợi migrateLegacyBackendUrl() (chạy async lúc SW khởi động) kịp xong.
  let backendUrl = (result.backendUrl || THIS_PROJECT_BACKEND_URL).replace(
    /\/+$/,
    ""
  );
  if (OTHER_PROJECT_BACKEND_RE.test(backendUrl)) {
    log(`getSettings: rewrite legacy backendUrl ${backendUrl} -> ${THIS_PROJECT_BACKEND_URL}`);
    backendUrl = THIS_PROJECT_BACKEND_URL;
    chrome.storage.local.set({ backendUrl }).catch(() => {});
  }
  return {
    backendUrl,
    apiKey: result.apiKey || "",
    userId: result.userId || "default",
    inboxId: result.inboxId || null,
  };
}

// ─── IMEI per-account cache ─────────────────────────────────────────
// BUG (đã root-cause, xem MULTI-ACCOUNT-FORWARD-PLAN.md mục 0): trước đây
// imei được cache vào 1 key GLOBAL DUY NHẤT `imei` trong chrome.storage.local,
// dùng chung cho MỌI account_id. Khi 1 browser dùng để import nhiều account
// Zalo khác nhau (vd "customer" rồi "shop-owner"), giá trị fallback này bị
// lẫn giữa các account — account sau có thể vô tình gửi lên backend đúng
// imei của account trước đó thay vì giá trị captured cho chính nó, khiến
// backend đăng ký 2 accountId với cùng device-id lên Zalo server → Zalo kick
// 1 trong 2 (Overlimit connection).
//
// Fix: key theo account_id — mỗi account chỉ đọc/ghi đúng slot của mình,
// không bao giờ fallback sang imei của account khác. Lưu ý: đây chỉ chặn
// được lỗi "dùng NHẦM cache cũ của account khác" — nếu bạn dùng ĐÚNG 1
// browser để đăng nhập 2 tài khoản Zalo THẬT khác nhau, z_uuid mà Zalo Web
// sinh ra vẫn là 1 giá trị CỐ ĐỊNH theo origin trình duyệt (không đổi theo
// tài khoản), nên 2 account đó vẫn sẽ bị Zalo coi là cùng 1 thiết bị dù
// code có sửa thế nào — cần tách browser profile/incognito riêng cho mỗi
// account, hoặc dùng QR login (sessionManager.startQrLogin, không phụ thuộc
// z_uuid) cho ít nhất 1 trong 2 account.
async function getStoredImei(accountId) {
  if (!accountId) return "";
  try {
    const { imeiByAccount } = await chrome.storage.local.get(["imeiByAccount"]);
    return (imeiByAccount && imeiByAccount[accountId]) || "";
  } catch {
    return "";
  }
}

async function setStoredImei(accountId, imei) {
  if (!accountId || !imei) return;
  try {
    const { imeiByAccount } = await chrome.storage.local.get(["imeiByAccount"]);
    await chrome.storage.local.set({
      imeiByAccount: { ...(imeiByAccount || {}), [accountId]: imei },
    });
  } catch (e) {
    logErr("setStoredImei failed:", e && e.message);
  }
}

// Đợi tab load xong (status "complete") trước khi executeScript — script
// chạy giữa lúc tab đang navigate có thể fail hoặc chạy nhầm vào trang cũ.
async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch {
      return false; // tab đã đóng
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Xoá `z_uuid` (device-id Zalo Web tự sinh, lưu theo origin — KHÔNG theo tài
// khoản) rồi reload tab để Zalo Web sinh lại 1 giá trị MỚI trước khi user
// quét QR cho account tiếp theo. Đây là cách cho phép nhiều tài khoản Zalo
// thật cùng dùng 1 Chrome profile mà không bị Zalo coi là cùng 1 thiết bị
// (tránh kick lẫn nhau / Overlimit connection) — KHÔNG cần profile/incognito
// riêng, KHÔNG cần QR login trong app.
//
// Chỉ nên gọi khi import 1 account_id CHƯA từng có imei lưu trên profile này
// (getStoredImei rỗng) — account ĐÃ từng kết nối trước đó nên giữ nguyên
// device cũ (Zalo đã "quen" thiết bị đó cho account này, đổi liên tục dễ bị
// Zalo nghi ngờ/flag).
async function resetZaloDeviceId(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        try {
          window.localStorage.removeItem("z_uuid");
        } catch (_) {
          /* ignore */
        }
      },
    });
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    log(`resetZaloDeviceId: cleared z_uuid + reloaded tab ${tabId}`);
  } catch (e) {
    logErr("resetZaloDeviceId failed:", e && e.message);
  }
}

function broadcastState(extra = {}) {
  const msg = { type: 'STATE_UPDATE', loginStatus, qrDataUrl: lastQrDataUrl, zaloTabId, ...extra };
  chrome.runtime.sendMessage(msg).catch(() => {});
  persistState(); // đồng bộ mỗi lần state đổi
}

// ─── Cookie Extraction ──────────────────────────────────────────────

async function extractZaloCookies() {
  // Domain list covers all known Zalo endpoints. Zalo backend sets
  // `zppsid` / `zppwsid` / `zphpsid` (newer API auth cookies) on multiple
  // sub-domains; missing any one of them is a common cause of
  // "Thiếu cookies bắt buộc" 400 from /import-session.
  const domains = [
    ".zalo.me",
    "zalo.me",
    "chat.zalo.me",
    ".zaloapp.com",
    "zaloapp.com",
    ".id.zalo.me",
    "id.zalo.me",
    ".id.zaloapp.com",
    "id.zaloapp.com",
    ".ttailieu.zalo.me",
    "ttailieu.zalo.me",
    ".login.zalo.me",
    "login.zalo.me",
  ];
  const allCookies = [];
  const seen = new Set();

  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const c of cookies) {
        const key = `${c.name}||${c.domain}||${c.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allCookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          httpOnly: c.httpOnly || false,
          secure: c.secure || false,
          sameSite: c.sameSite || "unspecified",
          expirationDate: c.expirationDate || null,
        });
      }
    } catch (e) {
      console.warn(`Cookie extraction error for ${domain}:`, e);
    }
  }

  // Fallback: if no Zalo-specific domain matched, get ALL cookies from
  // current tab (covers cases where the user is on a non-standard
  // domain like a custom Zalo web app). Only keep ones that look like
  // Zalo auth cookies.
  if (allCookies.length === 0) {
    try {
      const tab = await getActiveTab();
      if (tab && tab.url) {
        const url = new URL(tab.url);
        const all = await chrome.cookies.getAll({ url: tab.url });
        for (const c of all) {
          const key = `${c.name}||${c.domain}||${c.path}`;
          if (seen.has(key)) continue;
          // Keep only cookies that look Zalo-related
          if (
            c.name.startsWith("zp") ||
            c.name.startsWith("_z") ||
            c.name.startsWith("z") ||
            c.domain.includes("zalo")
          ) {
            seen.add(key);
            allCookies.push({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || "/",
              httpOnly: c.httpOnly || false,
              secure: c.secure || false,
              sameSite: c.sameSite || "unspecified",
              expirationDate: c.expirationDate || null,
            });
          }
        }
        log(`extractZaloCookies: fallback tab-cookies url=${url.hostname} kept=${allCookies.length}`);
      }
    } catch (e) {
      console.warn("extractZaloCookies fallback failed:", e);
    }
  }

  return allCookies;
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch (e) {
    return null;
  }
}

function cookiesToZcaFormat(cookies) {
  // Convert to zca-js style cookie format. Return ARRAY (not stringified)
  // so backend can parse directly as JSON list of {key,value,domain,...}.
  const out = cookies.map((c) => ({
    key: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite === "unspecified" ? "none" : c.sameSite,
    ...(c.expirationDate ? { expires: new Date(c.expirationDate * 1000).toISOString() } : {}),
  }));

  // ── Backend compatibility shim ────────────────────────────────────
  // Backend /import-session validator yêu cầu 4 cookies:
  //   zppsid, zppwsid, zpsid, zphpsid
  // Tuy nhiên Zalo web thuần CHỈ set zpsid + zpw_sek. Cookies zppsid/
  // zppwsid/zphpsid chỉ xuất hiện trong session API mới (do ZCA-JS
  // loginQR tạo ra), không có sẵn trong Chrome cookies. Để vượt qua
  // validation mà vẫn giữ ZCA-JS hoạt động bình thường, ta nhân bản
  // giá trị từ cặp web cookies tương ứng — chúng cùng đại diện cho
  // 1 phiên đăng nhập:
  //   zpsid  -> zppsid   (session id web -> API)
  //   zpw_sek-> zppwsid  (secret key web -> API)
  //   zphpsid: Zalo cấp khi login API thành công; web không có, tạo
  //           giả trùng zpsid (ZCA-JS tự refresh khi gọi API đầu tiên)
  const present = new Set(out.map((c) => c.key));
  const find = (k) => out.find((c) => c.key === k);
  // Debug: surface missing web cookies ngay đầu hàm alias để dễ truy vết
  // khi /import-session fail với "Đăng nhập thất bại".
  const required = ["zpsid", "zpw_sek"];
  const missing = required.filter((k) => !present.has(k));
  if (missing.length > 0) {
    log(
      `cookiesToZcaFormat: WARNING missing web cookies ${JSON.stringify(missing)} — ` +
        `present=${JSON.stringify([...present])}. ` +
        `User must be logged in on chat.zalo.me BEFORE we POST.`,
    );
  }
  const aliasMap = [
    ["zpsid", "zppsid"],
    ["zpw_sek", "zppwsid"],
    ["zpsid", "zphpsid"],
  ];
  for (const [src, alias] of aliasMap) {
    if (present.has(alias)) continue;
    const s = find(src);
    if (!s) continue;
    out.push({
      ...s,
      key: alias,
    });
    present.add(alias);
    log(
      `cookiesToZcaFormat: aliased ${src} -> ${alias} (value len=${(s.value || "").length})`,
    );
  }
  return out;
}

async function waitForCookies(maxRetries = 15, interval = 800) {
  log(`waitForCookies: starting (max ${maxRetries} retries x ${interval}ms)`);
  // Zalo web cookies chỉ có zpsid/zpw_sek; các API cookies (zppsid/zppwsid/zphpsid)
  // sẽ do zca-js tự refresh. Ở đây ta CHẤP NHẬN bất kỳ cookie Zalo nào — kể cả
  // chỉ 1 trong 2 — vì bridge không còn reject khi thiếu.
  const MIN_OK = ["zpsid", "zpw_sek"];
  for (let i = 0; i < maxRetries; i++) {
    const cookies = await extractZaloCookies();
    const names = cookies.map((c) => c.name);
    const uniqueNames = [...new Set(names)];
    const hasAny = MIN_OK.some((k) => uniqueNames.includes(k));
    log(
      `waitForCookies: attempt ${i + 1}/${maxRetries} → ${cookies.length} cookies, ` +
        `unique=${uniqueNames.length}, names=${JSON.stringify(uniqueNames)}`,
    );
    if (cookies.length > 0 && hasAny) {
      log(`waitForCookies: SUCCESS with web cookies (${cookies.length})`);
      return cookies;
    }
    if (cookies.length > 0 && !hasAny) {
      // Có cookie nhưng không phải cặp Zalo tiêu chuẩn — vẫn trả về,
      // bridge/zca-js sẽ quyết định; đỡ phải fail sớm.
      log(`waitForCookies: returning ${cookies.length} non-standard Zalo cookies`);
      return cookies;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const final = await extractZaloCookies();
  if (final.length === 0) throw new Error("No Zalo cookies found after login");
  log(`waitForCookies: returning last-resort ${final.length} cookies`);
  return final;
}
// ─── Backend Communication ───────────────────────────────────────────

async function sendSessionToBackend(cookies, imei = "") {
  const { backendUrl, apiKey, userId, inboxId } = await getSettings();
  log(`sendSessionToBackend: settings → backendUrl=${backendUrl}, userId=${userId}, hasApiKey=${!!apiKey}, imei=${imei}, inboxId=${inboxId}`);

  const cookiesPayload = cookiesToZcaFormat(cookies); // now an array
  log(`sendSessionToBackend: cookies count=${cookiesPayload.length}, isArray=${Array.isArray(cookiesPayload)}`);

  // Try the import-session endpoint first
  const url = `${backendUrl}/api/all-platform/zalo/auth/import-session`;
  const body = {
    user_id: userId,
    account_id: userId,
    owner_id: inboxId,
    inbox_id: inboxId,
    cookies: cookiesPayload,  // ARRAY (not stringified) — backend expects list of {key,value,domain}
    source: "extension",
    user_agent: navigator.userAgent,
    imei,
  };

  log(`sendSessionToBackend: POST ${url}`);
  const t0 = Date.now();
  let resp;
  try {
    resp = await timeoutPromise(
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "X-User-ID": userId,
        },
        body: JSON.stringify(body),
      }),
      90000,
      "fetch /import-session",
    );
  } catch (e) {
    logErr(`sendSessionToBackend: fetch failed after ${Date.now() - t0}ms:`, e.message);
    throw e;
  }
  log(`sendSessionToBackend: response ${resp.status} in ${Date.now() - t0}ms`);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Backend responded ${resp.status}: ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  log(`sendSessionToBackend: success`, data);
  return data;
}

// ─── Tab / Content Script Management ─────────────────────────────────

async function openZaloTab() {
  loginStatus = "opening";
  lastQrDataUrl = "";
  isExtInitiated = true;
  broadcastState();

  // Check if there's an existing Zalo tab (either chat.zalo.me or the id.zalo.me login page)
  const tabs = await chrome.tabs.query({
    url: ["https://chat.zalo.me/*", "https://*.zalo.me/*"]
  });

  if (tabs.length > 0) {
    zaloTabId = tabs[0].id;
    await chrome.tabs.update(zaloTabId, { active: true });
    // Reload to guarantee content script injection
    await chrome.tabs.reload(zaloTabId);
    console.log("[Zalo Ext] Found and reloaded existing Zalo tab:", zaloTabId);
  } else {
    const tab = await chrome.tabs.create({
      url: "https://chat.zalo.me/",
      active: true,
    });
    zaloTabId = tab.id;
    console.log("[Zalo Ext] Created new Zalo tab:", zaloTabId);
  }

  loginStatus = "waiting_scan";
  broadcastState();
  startPolling();
}

function startPolling() {
  stopPolling();
  pollIntervalId = setInterval(async () => {
    if (!zaloTabId) return;
    try {
      // Ask content script for status
      const response = await chrome.tabs.sendMessage(zaloTabId, {
        type: "CHECK_STATUS",
      });
      if (response) {
        if (response.imei) {
          // Legacy single-account flow — key theo userId đã cấu hình
          // (SAVE_SETTINGS), không phải 1 key global dùng chung mọi account.
          getSettings()
            .then(({ userId }) => setStoredImei(userId, response.imei))
            .catch(() => {});
        }
        await handleContentResponse(response);
      }
    } catch (e) {
      // Tab might have navigated away or content script not ready
      console.debug("[Zalo Ext] Poll error:", e.message);
    }
  }, 2000);
}

function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

async function handleContentResponse(response) {
  if (loginStatus === 'confirmed' || syncInProgress) return;

  if (response.qrDataUrl && response.qrDataUrl !== lastQrDataUrl) {
    lastQrDataUrl = response.qrDataUrl;
    loginStatus = 'waiting_scan';
    broadcastState();
  }

  if (response.loginStatus === 'confirmed') {
    const sessionData = await chrome.storage.session.get([
      'importZaloInProgress',
      'bridgeUrl',
      'accountId',
      'ownerId'
    ]);
    const isImportResumed = sessionData.importZaloInProgress;

    // If IMPORT_ZALO_SESSION handler is managing this session, don't double-sync
    if (importZaloInProgress) {
      loginStatus = 'confirmed';
      broadcastState({ message: 'Login confirmed — import handler will sync...' });
      return;
    }
    syncInProgress = true;
    loginStatus = 'confirmed';
    lastQrDataUrl = '';
    stopPolling();
    startKeepAlive(); // prevent SW from sleeping during the sync
    broadcastState({ message: 'Login detected! Extracting cookies...' });
    log(`handleContentResponse: loginStatus=confirmed, starting sync. isImportResumed=${isImportResumed}`);

    try {
      const cookies = await waitForCookies();
      log(`handleContentResponse: extracted ${cookies.length} cookies, sending to backend`);

      let result;
      if (isImportResumed) {
        const { apiKey } = await getSettings();
        const cookiesPayload = cookiesToZcaFormat(cookies);
        const url = `${sessionData.bridgeUrl}/api/all-platform/zalo/auth/import-session`;
        // Ưu tiên giá trị vừa capture được (response.imei); nếu content script
        // không lấy được (race), fallback đúng cache của account_id này —
        // không phải key global (xem getStoredImei).
        const resumedImei = response.imei || (await getStoredImei(sessionData.accountId));
        if (response.imei) setStoredImei(sessionData.accountId, response.imei).catch(() => {});
        const body = {
          account_id: sessionData.accountId,
          chatwoot_account_id: sessionData.chatwootAccountId || "",
          owner_id: sessionData.ownerId,
          cookies: cookiesPayload,
          source: "chatwoot-extension-resumed",
          user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
          imei: resumedImei,
        };
        log(`handleContentResponse: POST resumed import to ${url}`);
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        try { result = JSON.parse(text); } catch { result = { raw: text }; }
        if (!resp.ok) {
          throw new Error(`Resumed backend responded ${resp.status}: ${text.substring(0, 200)}`);
        }
      } else {
        result = await sendSessionToBackend(cookies, response.imei);
      }

      log("handleContentResponse: backend response", result);
      broadcastState({ message: `✅ Session synced! ${result.message || 'OK'}`, backendResult: result });

      // Clean up session storage
      await chrome.storage.session.set({
        importZaloInProgress: false,
        bridgeUrl: null,
        accountId: null,
        ownerId: null
      });

      // NEW: Auto close tab
      if (zaloTabId && isExtInitiated) {
        chrome.tabs.remove(zaloTabId).catch((e) => logErr("tab remove error:", e));
        zaloTabId = null;
      }
      isExtInitiated = false;
      syncInProgress = false; // Reset so user can sync again later
    } catch (e) {
      logErr('handleContentResponse: sync error:', e.message);
      loginStatus = 'error';
      syncInProgress = false;
      broadcastState({ message: `❌ Sync error: ${e.message}`, error: e.message });
    } finally {
      stopKeepAlive();
    }
  }

  if (response.loginStatus === 'qr_expired') {
    loginStatus = 'qr_expired';
    lastQrDataUrl = '';
    broadcastState({ message: 'QR đã hết hạn, đang refresh...' });
  }
}

// ─── Message Listener ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "OPEN_ZALO": {
          await openZaloTab();
          sendResponse({ ok: true });
          break;
        }

        case "RESET_STATE": {
          loginStatus = "opening";
          lastQrDataUrl = "";
          syncInProgress = false;
          isExtInitiated = true; // URL params means it's part of an automated flow
          zaloTabId = sender.tab ? sender.tab.id : null;
          broadcastState({ message: "State reset for new login flow" });
          sendResponse({ ok: true });
          break;
        }

        case "GET_STATE": {
          sendResponse({
            loginStatus,
            qrDataUrl: lastQrDataUrl,
            zaloTabId,
          });
          break;
        }

        case "QR_CAPTURED": {
          // From content script
          if (loginStatus === "confirmed") {
            sendResponse({ ok: true });
            break;
          }
          if (!zaloTabId && sender.tab) {
             zaloTabId = sender.tab.id;
          }
          if (msg.qrDataUrl) {
            lastQrDataUrl = msg.qrDataUrl;
            loginStatus = "waiting_scan";
            broadcastState();
          }
          sendResponse({ ok: true });
          break;
        }

        case "LOGIN_DETECTED": {
          // From content script
          if (loginStatus === "confirmed") {
            sendResponse({ ok: true });
            break;
          }
          if (!zaloTabId && sender.tab) {
             zaloTabId = sender.tab.id;
          }
          await handleContentResponse({
            loginStatus: "confirmed",
            imei: msg.imei
          });
          sendResponse({ ok: true });
          break;
        }

        case "QR_EXPIRED": {
          if (loginStatus === "confirmed") {
            sendResponse({ ok: true });
            break;
          }
          loginStatus = "qr_expired";
          lastQrDataUrl = "";
          broadcastState({ message: "QR hết hạn" });
          sendResponse({ ok: true });
          break;
        }

        case "MANUAL_SYNC": {
          // Manual cookie extraction and sync
          loginStatus = "confirmed";
          stopPolling();
          broadcastState({ message: "Extracting cookies..." });
          try {
            const cookies = await extractZaloCookies();
            if (cookies.length === 0) {
              throw new Error("No Zalo cookies found");
            }
            const result = await sendSessionToBackend(cookies);
            broadcastState({
              message: `✅ Synced ${cookies.length} cookies!`,
              backendResult: result,
            });
            // NEW: Auto close tab
            if (zaloTabId && isExtInitiated) {
              chrome.tabs.remove(zaloTabId).catch(console.warn);
              zaloTabId = null;
            }
            isExtInitiated = false;
            syncInProgress = false;
            sendResponse({ ok: true, result });
          } catch (e) {
            broadcastState({
              message: `❌ Error: ${e.message}`,
              error: e.message,
            });
            syncInProgress = false;
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }

        case "SAVE_SETTINGS": {
          await chrome.storage.local.set({
            backendUrl: msg.backendUrl,
            apiKey: msg.apiKey,
            userId: msg.userId,
          });
          sendResponse({ ok: true });
          break;
        }

        case "EXTRACT_COOKIES_ONLY": {
          // Bridge từ content-script (localhost) cần chỉ cookies thôi, không gọi backend
          try {
            const cookies = await extractZaloCookies();
            const zcaFormat = cookies.map((c) => ({
              key: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              httpOnly: c.httpOnly,
              secure: c.secure,
              sameSite: c.sameSite === "unspecified" ? "none" : c.sameSite,
              ...(c.expirationDate ? { expires: new Date(c.expirationDate * 1000).toISOString() } : {}),
            }));
            const userAgent = (typeof navigator !== "undefined" && navigator.userAgent) || "";
            // IMEI: đọc theo userId đã cấu hình (không phải key global dùng
            // chung mọi account — xem getStoredImei). Endpoint này chỉ dùng
            // để ping/checkLogin, không phải luồng import chính.
            const { userId } = await getSettings();
            const imei = await getStoredImei(userId);
            sendResponse({
              cookies: zcaFormat,
              keys: zcaFormat.map((c) => c.key),
              user_agent: userAgent,
              imei,
              missing: [],
              is_logged_in: zcaFormat.some((c) => ["zpw_sek", "zpsid"].includes(c.key)),
            });
          } catch (e) {
            sendResponse({ cookies: [], keys: [], missing: ["zpw_sek", "zpsid"], is_logged_in: false });
          }
          break;
        }

        case "IMPORT_ZALO_SESSION": {
          /**
           * Called from ZaloPersonal.vue (via page-bridge.js relay).
           * Payload: { account_id, owner_id, backend_url, login_timeout_ms }
           * Flow:
           *  1. Open Zalo Web tab
           *  2. Wait until login confirmed (polling via content script)
           *  3. Extract cookies
           *  4. POST to backend_url (zalo-bridge) with owner_id as inboxId
           *  5. Respond with { success, zaloId, backend }
           */
          const params = msg.data || msg.params || {};
          if (!params.account_id) {
            sendResponse({ success: false, error: "Missing account_id" });
            break;
          }

          // Prevent overlapping imports
          if (importZaloInProgress) {
            sendResponse({ success: false, error: "Import already in progress" });
            break;
          }

          importZaloInProgress = true;
          startKeepAlive();
          // Defensive: nếu frontend gửi nhầm mabuu.markeeai.com thì rewrite sang timetech
          // ngay tại biên extension để không phụ thuộc env prod đã được deploy hay chưa.
          const sanitizeBridgeUrl = (raw) => {
            if (!raw) return raw;
            if (/(^|\/\/|@)mabuu\.markeeai\.com/i.test(raw)) {
              log(`IMPORT_ZALO_SESSION: rewrite legacy bridgeUrl ${raw} -> https://timetech.markeeai.com/zalo-bridge`);
              return "https://timetech.markeeai.com/zalo-bridge";
            }
            return raw;
          };
          const bridgeUrl = sanitizeBridgeUrl(
            (params.backend_url || "http://localhost:3001").replace(/\/+$/, "")
          );
          const loginTimeoutMs = params.login_timeout_ms || 60000;
          const accountId = String(params.account_id || "default");
          const chatwootAccountId = String(params.chatwoot_account_id || params.chatwootAccountId || "");
          const ownerId = String(params.owner_id || "");
          const importApiKey = params.apiKey || params.api_key || "";

          // Persist state to session storage
          await chrome.storage.session.set({
            importZaloInProgress: true,
            bridgeUrl,
            accountId,
            chatwootAccountId,
            ownerId
          });
          if (importApiKey) {
            await chrome.storage.local.set({ apiKey: importApiKey });
          }

          // ── 1. Open / focus Zalo tab ──────────────────────────────────
          try {
            const tabs = await chrome.tabs.query({ url: ["https://chat.zalo.me/*", "https://*.zalo.me/*"] });
            if (tabs.length > 0) {
              zaloTabId = tabs[0].id;
              await chrome.tabs.update(zaloTabId, { active: true });
              await chrome.tabs.reload(zaloTabId);
            } else {
              const tab = await chrome.tabs.create({ url: "https://chat.zalo.me/", active: true });
              zaloTabId = tab.id;
            }
            isExtInitiated = true;
            loginStatus = "waiting_scan";
            await chrome.storage.session.set({ zaloTabId, isExtInitiated });
            broadcastState({ message: "Zalo Web mở — đăng nhập nếu cần..." });

            // account_id này CHƯA từng import trên profile hiện tại → reset
            // device-id (z_uuid) trước khi quét QR, để Zalo không đăng ký
            // account mới này lên CÙNG device-id với 1 account khác đã dùng
            // trước đó trên profile này (nguyên nhân kick lẫn nhau/Overlimit).
            // Account đã từng import rồi (đang reconnect/login lại) thì giữ
            // nguyên z_uuid hiện có — không reset.
            const hasExistingImei = await getStoredImei(accountId);
            if (!hasExistingImei) {
              await waitForTabComplete(zaloTabId);
              await resetZaloDeviceId(zaloTabId);
              broadcastState({ message: "Đã reset device-id cho tài khoản mới — đăng nhập QR bình thường..." });
            }
          } catch (e) {
            importZaloInProgress = false;
            stopKeepAlive();
            await chrome.storage.session.set({ importZaloInProgress: false });
            sendResponse({ success: false, error: `Cannot open Zalo tab: ${e.message}` });
            break;
          }

          // ── 2. Poll until login confirmed or timeout ───────────────────
          let imei = "";
          try {
            await new Promise((resolve, reject) => {
              const deadline = Date.now() + loginTimeoutMs;
              const checkId = setInterval(async () => {
                if (Date.now() > deadline) {
                  clearInterval(checkId);
                  reject(new Error(`Timeout ${loginTimeoutMs}ms — user did not log in`));
                  return;
                }
                try {
                  const resp = await chrome.tabs.sendMessage(zaloTabId, { type: "CHECK_STATUS" });
                  if (resp && resp.loginStatus === "confirmed") {
                    if (resp.imei) {
                      imei = resp.imei;
                      setStoredImei(accountId, resp.imei).catch(() => {});
                    }
                    clearInterval(checkId);
                    resolve();
                  }
                } catch { /* tab reloading, ignore */ }
              }, 1500);
            });
          } catch (e) {
            loginStatus = "idle";
            importZaloInProgress = false;
            stopKeepAlive();
            await chrome.storage.session.set({ importZaloInProgress: false });
            sendResponse({ success: false, error: e.message });
            break;
          }

          // ── 3. Extract cookies ─────────────────────────────────────────
          let cookies;
          try {
            cookies = await waitForCookies(15, 800);
          } catch (e) {
            importZaloInProgress = false;
            stopKeepAlive();
            await chrome.storage.session.set({ importZaloInProgress: false });
            sendResponse({ success: false, error: `Cookie extraction failed: ${e.message}` });
            break;
          }

          // ── 4. POST to zalo-bridge ─────────────────────────────────────
          let backendResult;
          try {
            const cookiesPayload = cookiesToZcaFormat(cookies);
            const settings = await getSettings();
            const apiKey = importApiKey || settings.apiKey || "";
            if (!imei) {
              // Fallback theo ĐÚNG account_id đang import — KHÔNG đọc key
              // global (bug cũ khiến account này vô tình dùng nhầm imei của
              // 1 account khác từng import trước đó trên cùng máy).
              imei = await getStoredImei(accountId);
            }
            const url = `${bridgeUrl}/api/all-platform/zalo/auth/import-session`;
            const body = {
              account_id: accountId,
              chatwoot_account_id: chatwootAccountId,
              owner_id: ownerId,   // bridge extension.js reads as inboxId
              cookies: cookiesPayload,
              source: "chatwoot-extension",
              user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
              imei: imei,
            };
            log("IMPORT_ZALO_SESSION: POST", url, { accountId, ownerId });
            const resp = await timeoutPromise(
              fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(apiKey ? { "X-API-Key": apiKey } : {}),
                },
                body: JSON.stringify(body),
              }),
              20000,
              "POST import-session",
            );
            const text = await resp.text();
            try { backendResult = JSON.parse(text); } catch { backendResult = { raw: text }; }
            if (!resp.ok) {
              throw new Error(`Backend ${resp.status}: ${text.slice(0, 200)}`);
            }
            log("IMPORT_ZALO_SESSION: backend ok", backendResult);
          } catch (e) {
            importZaloInProgress = false;
            stopKeepAlive();
            await chrome.storage.session.set({ importZaloInProgress: false });
            sendResponse({ success: false, error: `Backend error: ${e.message}`, cookies_count: cookies.length });
            break;
          }

          // ── 5. Close Zalo tab + respond ────────────────────────────────
          if (zaloTabId && isExtInitiated) {
            chrome.tabs.remove(zaloTabId).catch(() => {});
            zaloTabId = null;
          }
          loginStatus = "idle";
          isExtInitiated = false;
          importZaloInProgress = false;
          stopKeepAlive();
          await chrome.storage.session.set({
            importZaloInProgress: false,
            bridgeUrl: null,
            accountId: null,
            ownerId: null,
            isExtInitiated: false,
            zaloTabId: null
          });

          sendResponse({
            success: true,
            zaloId: backendResult?.zaloId,
            backend: backendResult,
            cookies_count: cookies.length,
          });
          break;
        }

        case "IMPORT_VIA_EXTENSION": {
          // Frontend gọi qua bridge với { account_id, user_id?, owner_id? } → extension tự extract + sync backend
          const params = msg.params || {};
          if (!params.account_id) {
            sendResponse({ status: 400, error: "Missing account_id" });
            break;
          }
          try {
            const cookies = await waitForCookies();
            const { backendUrl, apiKey } = await getSettings();
            // Đọc theo đúng account_id đang import (không phải key global —
            // xem getStoredImei), tránh dùng nhầm imei của account khác.
            const imei = await getStoredImei(params.account_id);
            const cookiesPayload = cookiesToZcaFormat(cookies); // ARRAY (not stringified)
            const url = `${backendUrl}/api/all-platform/zalo/auth/import-session`;
            const body = {
              account_id: params.account_id,
              user_id: params.user_id || params.owner_id,
              cookies: cookiesPayload,  // ARRAY
              source: "extension",
              user_agent: navigator.userAgent,
              imei,
            };
            const resp = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-Key": apiKey,
                ...(params.user_id ? { "X-User-ID": params.user_id } : {}),
              },
              body: JSON.stringify(body),
            });
            const text = await resp.text();
            let backend = null;
            try { backend = JSON.parse(text); } catch { backend = { raw: text }; }
            sendResponse({
              status: resp.status,
              backend,
              cookies_count: cookies.length,
              keys: cookies.map((c) => c.name),
            });
          } catch (e) {
            sendResponse({ status: 500, error: e.message || String(e) });
          }
          break;
        }

        case 'RESET': {
          loginStatus = 'idle';
          lastQrDataUrl = '';
          zaloTabId = null;
          syncInProgress = false;
          isExtInitiated = false;
          stopPolling();
          broadcastState();
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (e) {
      console.error("[Zalo Ext] Message handler error:", e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep message channel open for async response
});

// ─── Tab Close Listener ──────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === zaloTabId) {
    zaloTabId = null;
    if (loginStatus !== "confirmed") {
      loginStatus = "idle";
      lastQrDataUrl = "";
      stopPolling();
      broadcastState({ message: "Zalo tab closed" });
    }
  }
});

console.log("[Zalo QR Login Extension] Service worker started");
