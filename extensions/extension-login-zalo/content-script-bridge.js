/**
 * Zalo Extension ↔ Web Bridge (ISOLATED world).
 *
 * Why this file exists:
 *   Chrome MV3 content scripts run in an ISOLATED world. Anything they
 *   assign to `window` is NOT visible to page scripts. So we cannot
 *   expose `window.__zaloExtension` from here.
 *
 *   Instead, this file:
 *     1. Injects `page-bridge-main.js` (declared in web_accessible_resources)
 *        into the MAIN world via a <script src=chrome.runtime.getURL>. That
 *        MAIN-world script is what creates `window.__zaloExtension`.
 *     2. Relays `window.postMessage({ __zaloExt: true, ... })` from the
 *        page to `chrome.runtime.sendMessage` to background.js, and posts
 *        the response back to the page.
 *
 * Protocol:
 *   page -> isolated: window.postMessage({ __zaloExt: true, type, requestId, data }, "*")
 *   isolated -> page: window.postMessage({ __zaloExt: true, type: "RESPONSE", requestId, success, data|error }, "*")
 */

(function () {
  "use strict";

  if (window.__zaloIsolatedBridgeInstalled) return;
  window.__zaloIsolatedBridgeInstalled = true;

  // ─── Inject MAIN-world script so the page can see window.__zaloExtension ───
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("page-bridge-main.js");
    s.async = false;
    s.onload = function () { try { s.remove(); } catch (e) {} };
    s.onerror = function () {
      try {
        console.warn("[Zalo Ext Bridge] failed to inject MAIN-world script");
      } catch (e) {}
    };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    try { console.warn("[Zalo Ext Bridge] inject error:", e); } catch (_) {}
  }

  // ─── Helpers ─────────────────────────────────────────────────────────
  function postToWeb(payload) {
    try {
      window.postMessage({ __zaloExt: true, ...payload }, "*");
    } catch (e) {
      try { console.warn("[Zalo Ext Bridge] postMessage to web failed:", e); } catch (_) {}
    }
  }

  function respond(requestId, success, dataOrError) {
    if (success) {
      postToWeb({ type: "RESPONSE", requestId: requestId, success: true, data: dataOrError });
    } else {
      postToWeb({
        type: "RESPONSE",
        requestId: requestId,
        success: false,
        error: typeof dataOrError === "string"
          ? dataOrError
          : (dataOrError && dataOrError.message) || "Unknown error",
      });
    }
  }

  // ─── Message handlers ────────────────────────────────────────────────

  async function handlePing(requestId) {
    respond(requestId, true, { installed: true, version: "1.1.2" });
  }

  async function handleGetCookies(requestId) {
    try {
      const cookies = await chrome.runtime.sendMessage({ type: "EXTRACT_COOKIES_ONLY" });
      respond(requestId, true, cookies);
    } catch (e) {
      respond(requestId, false, e.message || String(e));
    }
  }

  async function handleCheckLogin(requestId) {
    try {
      const cookies = await chrome.runtime.sendMessage({ type: "EXTRACT_COOKIES_ONLY" });
      const keys = (cookies?.cookies || cookies || []).map((c) => c.key || c.name);
      const required = ["zpw_sek", "zpsid"];
      const missing = required.filter((k) => !keys.includes(k));
      respond(requestId, true, {
        is_logged_in: missing.length === 0 && keys.length > 0,
        cookies_count: keys.length,
        missing: missing,
        keys: keys,
      });
    } catch (e) {
      respond(requestId, false, e.message || String(e));
    }
  }

  async function handleImportSession(requestId, data) {
    /**
     * Relay IMPORT_ZALO_SESSION to background.js which will:
     *  1. Open Zalo Web tab
     *  2. Wait for login confirmation (polling content-script)
     *  3. Extract cookies
     *  4. POST to data.backend_url (zalo-bridge) with data.owner_id as inboxId
     *  5. Return { success, zaloId, backend }
     */
    try {
      const timeoutMs = (data && data.login_timeout_ms) || 60000 + 15000;
      const result = await Promise.race([
        chrome.runtime.sendMessage({
          type: "IMPORT_ZALO_SESSION",
          data: data || {},
        }),
        new Promise(function (_resolve, reject) {
          setTimeout(function () { reject(new Error("Bridge timeout after " + timeoutMs + "ms")); }, timeoutMs);
        }),
      ]);
      if (result && result.success) {
        respond(requestId, true, result);
      } else {
        respond(requestId, false, (result && result.error) || "Import failed");
      }
    } catch (e) {
      respond(requestId, false, (e && e.message) || String(e));
    }
  }

  // ─── Message listener ────────────────────────────────────────────────
  window.addEventListener("message", function (event) {
    if (event.source !== window) return; // ignore cross-origin postMessage
    const msg = event.data;
    if (!msg || msg.__zaloExt !== true) return;
    // Skip responses published by the MAIN-world bridge itself.
    if (msg.type === "RESPONSE" || msg.type === "STATE_UPDATE") return;
    if (!msg.requestId) return;

    switch (msg.type) {
      case "PING":
        handlePing(msg.requestId);
        break;
      case "GET_ZALO_COOKIES":
        handleGetCookies(msg.requestId);
        break;
      case "CHECK_ZALO_LOGIN":
        handleCheckLogin(msg.requestId);
        break;
      case "IMPORT_ZALO_SESSION":
        handleImportSession(msg.requestId, msg.data);
        break;
      default:
        respond(msg.requestId, false, "Unknown bridge message type: " + msg.type);
    }
  });

  try {
    console.log("[Zalo Ext Bridge] Loaded on", location.href);
  } catch (e) {}
})();