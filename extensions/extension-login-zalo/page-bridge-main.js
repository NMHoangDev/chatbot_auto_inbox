/**
 * page-bridge-main.js — runs in MAIN world (page script context).
 *
 * Why this file exists:
 *   Chrome MV3 content scripts run in an ISOLATED world, so anything they
 *   assign to `window` is NOT visible to the page's normal JavaScript.
 *   We expose `window.__zaloExtension` (and the `__zaloExtensionAvailable`
 *   flag) from this file instead, so the page can detect + call the bridge.
 *
 * Protocol:
 *   page -> isolated: window.postMessage({ __zaloExt: true, type, requestId, data }, "*")
 *   isolated -> page: window.postMessage({ __zaloExt: true, type: "RESPONSE", requestId, success, data|error }, "*")
 *
 * This file ONLY handles the page side. The actual chrome.runtime.sendMessage
 * relay lives in content-script-bridge.js (isolated world).
 */

(function () {
  "use strict";

  // Mark available as early as possible so detection logic can read it
  // synchronously even before the listeners are wired.
  try {
    window.__zaloExtensionAvailable = true;
  } catch (e) {}

  // Idempotency guard — the file may be injected twice if both the
  // content-script reload AND a dynamic re-injection happen.
  if (window.__zaloPageBridgeInstalled) return;
  window.__zaloPageBridgeInstalled = true;

  const pending = new Map();

  function genRequestId() {
    return "zr_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function callBridge(type, data, timeoutMs) {
    const requestId = genRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          reject(new Error("Bridge timeout after " + timeoutMs + "ms (" + type + ")"));
        }
      }, timeoutMs);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      try {
        window.postMessage({ __zaloExt: true, type: type, requestId: requestId, data: data || {} }, "*");
      } catch (e) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(e);
      }
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__zaloExt !== true) return;
    if (msg.type !== "RESPONSE") return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    clearTimeout(entry.timer);
    if (msg.success) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error || "Extension error"));
  });

  try {
    window.__zaloExtension = {
      isAvailable: function () { return true; },
      ping: function () { return callBridge("PING", undefined, 5000); },
      checkLogin: function () { return callBridge("CHECK_ZALO_LOGIN", undefined, 10000); },
      getCookies: function () { return callBridge("GET_ZALO_COOKIES", undefined, 15000); },
      importSession: function (opts) { return callBridge("IMPORT_ZALO_SESSION", opts || {}, 180000); },
    };
  } catch (e) {
    // Page-side helper is best-effort; isolated bridge still works.
  }

  try {
    console.log("[Zalo Ext Bridge Main] Loaded on", location.href);
  } catch (e) {}
})();