/**
 * Zalo QR Login Extension — Content Script
 * Injected into chat.zalo.me pages
 *
 * Responsibilities:
 * 1. Detect and capture QR code from canvas/img elements
 * 2. Detect login success by checking DOM selectors
 * 3. Detect QR expiration
 * 4. Respond to background script polling
 */

(function () {
  "use strict";

  // Prevent double injection
  if (window.__zaloExtContentLoaded) return;
  window.__zaloExtContentLoaded = true;

  console.log("[Zalo Ext Content] Loaded on", location.href);

  // ─── Auto-Configuration from URL Params ──────────────────────────
  let isConfiguring = false;
  const urlParams = new URLSearchParams(window.location.search);
  const extUserId = urlParams.get('zaloExtUserId');
  const extApiKey = urlParams.get('zaloExtApiKey');
  const extBackendUrl = urlParams.get('zaloExtBackendUrl');
  const extInboxId = urlParams.get('zaloExtInboxId');
  let isLoginFlowActive = Boolean(extUserId || extApiKey || extBackendUrl || extInboxId);

  if (extUserId || extApiKey || extBackendUrl || extInboxId) {
    isConfiguring = true;
    console.log("[Zalo Ext Content] Auto-configuring from URL params...");
    const config = {};
    if (extUserId) config.userId = extUserId;
    if (extApiKey) config.apiKey = extApiKey;
    if (extBackendUrl) config.backendUrl = extBackendUrl;
    if (extInboxId) config.inboxId = extInboxId;

    chrome.storage.local.set(config, () => {
      console.log("[Zalo Ext Content] Auto-configuration saved successfully.");
      isConfiguring = false;
      // Force background script to reset state so it extracts cookies again
      chrome.runtime.sendMessage({ type: "RESET_STATE" }).catch(() => {});
    });

    // Clean up URL so the user doesn't see the API Key
    const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }

  function refreshLoginFlowActive(callback) {
    try {
      chrome.storage.session.get(['importZaloInProgress', 'isExtInitiated'], (state) => {
        isLoginFlowActive = Boolean(
          isLoginFlowActive ||
          state?.importZaloInProgress ||
          state?.isExtInitiated
        );
        if (callback) callback(isLoginFlowActive);
      });
    } catch (_) {
      if (callback) callback(isLoginFlowActive);
    }
  }

  // ─── Selectors (mirrored from backend qr_login.py) ─────────────────

  const CANVAS_SELECTORS = [
    "canvas.qr-img",
    ".qr-panel canvas",
    "canvas[class*=qr]",
    "[class*=qr-code] canvas",
    "[class*=QRCode] canvas",
    "[class*=login] canvas",
  ];

  const IMG_SELECTORS = [
    "img[class*=qr]",
    "img[class*=QR]",
    "[class*=qr] img",
    "[class*=QR] img",
    "[class*=login] img",
  ];

  const LOGGED_IN_SELECTORS = [
    "#chatView",
    "#messageView",
    "#chatInput",
    "#messageViewScroll",
    '[data-component="message-content-view"]',
    '[data-id="div_SentMsg_Text"]',
    '[data-id="div_ReceivedMsg_Text"]',
    ".message-view",
    ".chat-box-input-container",
    "#contact-search-input",
    ".nav__tabs",
    "#main-tab",
    "#conversationListId",
    "div.nav__tabs__bottom",
    ".zalo-sidebar",
    '[id="global-search"]'
  ];

  const APP_SELECTORS = [
    "[class*=contact]",
    "[class*=Contact]",
    "[class*=conv]",
    "[class*=Conv]",
    "[class*=sidebar]",
    "[class*=Sidebar]",
    "[class*=friend]",
    "[class*=Friend]",
    "[class*=chatList]",
    "[class*=msgList]",
    "[class*=userList]",
    '[contenteditable="true"]',
    "textarea",
    "input",
  ];

  const CONV_SELECTORS = [
    ".conv-list-item",
    ".contact-item",
    "[class*=ConvItem]",
    "[class*=conversation-item]",
  ];

  // ─── Utility Functions ─────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    )
      return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 50 && rect.height > 50;
  }

  function isSquarish(el, minSize = 100) {
    const rect = el.getBoundingClientRect();
    if (rect.width < minSize || rect.height < minSize) return false;
    const ratio = rect.width / rect.height;
    return ratio > 0.75 && ratio < 1.25;
  }

  // ─── QR Capture ────────────────────────────────────────────────────

  function captureQrFromCanvas() {
    for (const sel of CANVAS_SELECTORS) {
      try {
        const canvas = document.querySelector(sel);
        if (!canvas) continue;
        const visible = isVisible(canvas);
        const squarish = isSquarish(canvas, 80);
        console.log(`[Zalo Ext Content] Canvas found matching "${sel}":`, {
          width: canvas.width,
          height: canvas.height,
          rectWidth: canvas.getBoundingClientRect().width,
          rectHeight: canvas.getBoundingClientRect().height,
          visible,
          squarish
        });
        if (!visible || !squarish) continue;
        if (canvas.width < 80 || canvas.height < 80) continue;
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl && dataUrl.length > 2000) return dataUrl;
      } catch (e) {
        console.warn(`[Zalo Ext Content] Canvas extraction failed for ${sel}:`, e);
      }
    }
    return null;
  }

  function captureQrFromImg() {
  for (const sel of IMG_SELECTORS) {
    try {
      const img = document.querySelector(sel);
      if (!img) continue;
      if (!isVisible(img) || !isSquarish(img, 80)) continue;
      if (img.naturalWidth < 80 || img.naturalHeight < 80) continue;

      // Ưu tiên data URL trực tiếp — không cần canvas, tránh CORS taint
      if (img.src && img.src.startsWith('data:')) return img.src;

      // Thử blob URL hoặc same-origin URL
      if (img.src) {
        try {
          const cvs = document.createElement('canvas');
          cvs.width = img.naturalWidth;
          cvs.height = img.naturalHeight;
          const ctx = cvs.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const dataUrl = cvs.toDataURL('image/png');
          if (dataUrl && dataUrl.length > 2000) return dataUrl;
        } catch (corsErr) {
          // Canvas tainted (cross-origin) — thử trả src gốc để popup hiển thị trực tiếp
          console.warn('[Zalo Ext Content] Canvas CORS taint, dùng src gốc:', img.src.substring(0, 60));
          if (img.src.startsWith('http')) return img.src; // popup sẽ dùng <img src> bình thường
        }
      }
    } catch (e) {
      console.warn(`[Zalo Ext Content] Img extraction failed for ${sel}:`, e);
    }
  }
  return null;
}

  function captureQr() {
    const qr = captureQrFromCanvas() || captureQrFromImg();
    if (qr) {
      console.log("[Zalo Ext Content] Successfully captured QR code data URL!");
    }
    return qr;
  }

  // ─── Login Status Detection ────────────────────────────────────────

  function checkLoginStatus() {
    const url = location.href;
    if (!url.includes("chat.zalo.me") && !url.includes("zalo.me")) {
      return "waiting_scan";
    }

    // 1. If we are on the Zalo identity portal (id.zalo.me), we are definitely not logged in yet.
    if (url.includes("id.zalo.me")) {
      const rawText = (document.body?.innerText || "").toLowerCase();
      const text = rawText
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

      // Check for QR expiration strictly on the identity portal
      const isExpired = (
        text.includes("da het han") ||
        text.includes("ma qr da het han") ||
        (text.includes("het han") && !text.includes("het han sau") && !text.includes("het han con")) ||
        (text.includes("lay ma moi") && !text.includes("het han sau")) ||
        text.includes("refresh qr") ||
        text.includes("reload qr")
      );

      if (isExpired) {
        console.log("[Zalo Ext Content] QR expired on id.zalo.me");
        return "qr_expired";
      }

      // Check for account continue screen
      if (url.includes("id.zalo.me/account")) {
        tryClickContinue();
      }

      return "waiting_scan";
    }

    // 2. If we are on chat.zalo.me, we can verify if we are logged in.
    if (url.includes("chat.zalo.me")) {
      // Check for chat DOM elements
      for (const sel of LOGGED_IN_SELECTORS) {
        if (document.querySelector(sel)) return "confirmed";
      }

      // Check for conversation list
      const convCount = document.querySelectorAll(CONV_SELECTORS.join(",")).length;
      if (convCount > 0) return "confirmed";

      // Check for chat composer
      const composer = document.querySelector('[contenteditable="true"], textarea');
      if (composer) return "confirmed";

      // If the URL contains chat.zalo.me but we don't see logged in elements yet, we might be loading.
      return "waiting_scan";
    }

    return "waiting_scan";
  }

  function tryClickContinue() {
    const continueTexts = ["Tiếp tục", "Tiep tuc", "Continue"];
    const buttons = document.querySelectorAll(
      'button, a, [role="button"]'
    );
    for (const btn of buttons) {
      const txt = (btn.innerText || btn.textContent || "").trim();
      if (continueTexts.some((t) => txt.includes(t))) {
        btn.click();
        console.log("[Zalo Ext Content] Clicked continue button");
        return;
      }
    }
  }

  // ─── Periodic QR/Login Observer ────────────────────────────────────

  let lastQrSent = "";
  let loginConfirmedSent = false;
  let overlayEl = null;

  function initOverlay() {
    if (document.getElementById("zalo-crawler-ext-overlay")) return;
    overlayEl = document.createElement("div");
    overlayEl.id = "zalo-crawler-ext-overlay";
    overlayEl.style.cssText = `
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      background: #E3000F; color: white; padding: 10px 20px; border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px; font-weight: bold; z-index: 999999; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      pointer-events: none; transition: all 0.3s ease;
    `;
    overlayEl.innerText = "🤖 Extension: Đang chờ bạn quét QR đăng nhập...";
    document.body.appendChild(overlayEl);
  }

  function updateOverlay(text, color = "#E3000F") {
    if (!overlayEl) initOverlay();
    if (overlayEl) {
      overlayEl.innerText = text;
      overlayEl.style.background = color;
    }
  }

  function observe() {
    if (!isLoginFlowActive) {
      refreshLoginFlowActive((active) => {
        if (active) observe();
      });
      return;
    }

    if (isConfiguring) {
      console.log("[Zalo Ext Content] Postponing observe because auto-configuration is in progress...");
      return;
    }
    if (!document.getElementById("zalo-crawler-ext-overlay")) {
      initOverlay();
    }
    const status = checkLoginStatus();

    if (status === "confirmed" && !loginConfirmedSent) {
      loginConfirmedSent = true;
      updateOverlay("✅ Đăng nhập thành công! Đang lấy Cookie và đồng bộ...", "#00c853");
      console.log("[Zalo Ext Content] Login detected!");
      const z_uuid = window.localStorage ? window.localStorage.getItem("z_uuid") : "";
      chrome.runtime.sendMessage({
        type: "LOGIN_DETECTED",
        imei: z_uuid
      }).catch(() => {});
      return;
    }

    if (status === "qr_expired") {
      chrome.runtime.sendMessage({ type: "QR_EXPIRED" }).catch(() => {});
      return;
    }

    if (status === "waiting_scan") {
      const qr = captureQr();
      if (qr && qr !== lastQrSent) {
        lastQrSent = qr;
        chrome.runtime
          .sendMessage({ type: "QR_CAPTURED", qrDataUrl: qr })
          .catch(() => {});
      }
    }
  }
// Theo dõi URL thay đổi (SPA navigation: id.zalo.me → chat.zalo.me)
let lastUrl = location.href;
const urlObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    console.log('[Zalo Ext Content] URL changed to:', location.href);
    // Nếu vừa navigate về chat.zalo.me thì check login ngay
    if (location.href.includes('chat.zalo.me')) {
      setTimeout(observe, 800);
    }
  }
});
urlObserver.observe(document.body, { childList: true, subtree: true });
  // Run observer every 1.5 seconds
  const observerInterval = setInterval(observe, 1500);
  // Also run immediately
  setTimeout(observe, 500);

  // ─── Message Listener (from background script polling) ─────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "CHECK_STATUS") {
      isLoginFlowActive = true;
      const status = checkLoginStatus();
      const qr = status === "waiting_scan" ? captureQr() : null;
      const z_uuid = window.localStorage ? window.localStorage.getItem("z_uuid") : "";
      sendResponse({
        loginStatus: status,
        qrDataUrl: qr || lastQrSent || null,
        url: location.href,
        imei: z_uuid || "",
      });
    }
    return false;
  });

  // Cleanup on unload
  window.addEventListener("beforeunload", () => {
    clearInterval(observerInterval);
    urlObserver.disconnect();
  });
})();
