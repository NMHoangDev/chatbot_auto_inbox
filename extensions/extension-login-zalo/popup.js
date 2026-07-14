/**
 * Zalo QR Login Extension — Popup Script
 */

document.addEventListener("DOMContentLoaded", async () => {
  // ─── DOM Elements ────────────────────────────────────────────────
  const statusDot = document.getElementById("statusDot");
  const statusLabel = document.getElementById("statusLabel");
  const settingsToggle = document.getElementById("settingsToggle");
  const settingsChevron = document.getElementById("settingsChevron");
  const settingsBody = document.getElementById("settingsBody");
  const backendUrlInput = document.getElementById("backendUrl");
  const apiKeyInput = document.getElementById("apiKey");
  const userIdInput = document.getElementById("userId");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const qrSection = document.getElementById("qrSection");
  const qrImage = document.getElementById("qrImage");
  const qrPlaceholder = document.getElementById("qrPlaceholder");
  const openZaloBtn = document.getElementById("openZaloBtn");
  const manualSyncBtn = document.getElementById("manualSyncBtn");
  const resetBtn = document.getElementById("resetBtn");
  const logSection = document.getElementById("logSection");
  const logBody = document.getElementById("logBody");

  // ─── Settings Toggle ────────────────────────────────────────────
  let settingsOpen = true;

  settingsToggle.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    settingsBody.classList.toggle("collapsed", !settingsOpen);
    settingsChevron.classList.toggle("collapsed", !settingsOpen);
  });

  // ─── Load Settings ──────────────────────────────────────────────
  const stored = await chrome.storage.local.get([
    "backendUrl",
    "apiKey",
    "userId",
  ]);
  // Domain của project markee KHÁC từng bị lưu nhầm (dùng chung 1 bản
  // extension để test nhiều project trên cùng máy) — rewrite ngay khi hiển
  // thị, không đợi background.js migrateLegacyBackendUrl() (chạy async lúc
  // service worker khởi động, có thể chưa kịp xong khi popup vừa mở).
  const OTHER_PROJECT_BACKEND_RE = /(^|\/\/|@)(mabuu|timetech|seeding)\.markeeai\.com/i;
  const THIS_PROJECT_BACKEND_URL = "https://chatbot-inbox.markeeai.com/zalo-bridge";
  let storedBackendUrl = stored.backendUrl;
  if (storedBackendUrl && OTHER_PROJECT_BACKEND_RE.test(storedBackendUrl)) {
    storedBackendUrl = THIS_PROJECT_BACKEND_URL;
    chrome.storage.local.set({ backendUrl: storedBackendUrl }).catch(() => {});
  }
  if (storedBackendUrl) backendUrlInput.value = storedBackendUrl;
  if (stored.apiKey) apiKeyInput.value = stored.apiKey;
  if (stored.userId) userIdInput.value = stored.userId;

  // Collapse settings if already configured
  if (stored.backendUrl && stored.apiKey) {
    settingsOpen = false;
    settingsBody.classList.add("collapsed");
    settingsChevron.classList.add("collapsed");
  }

  // ─── Save Settings ─────────────────────────────────────────────
  saveSettingsBtn.addEventListener("click", async () => {
    const backendUrl = backendUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const userId = userIdInput.value.trim() || "default";

    if (!backendUrl) return alert("Vui lòng nhập Backend URL!");
    if (!apiKey) return alert("Vui lòng nhập API Key!");

    await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      backendUrl,
      apiKey,
      userId,
    });

    addLog("💾 Đã lưu cấu hình");
    saveSettingsBtn.textContent = "✅ Đã lưu!";
    setTimeout(() => {
      saveSettingsBtn.textContent = "💾 Lưu cấu hình";
    }, 1500);

    // Collapse after save
    settingsOpen = false;
    settingsBody.classList.add("collapsed");
    settingsChevron.classList.add("collapsed");
  });

  // ─── Open Zalo Button ──────────────────────────────────────────
  openZaloBtn.addEventListener("click", async () => {
    const apiKey = apiKeyInput.value.trim();
    const backendUrl = backendUrlInput.value.trim();
    if (!apiKey || !backendUrl) {
      alert("Vui lòng cấu hình Backend URL và API Key trước!");
      settingsOpen = true;
      settingsBody.classList.remove("collapsed");
      settingsChevron.classList.remove("collapsed");
      return;
    }

    // Auto-save
    await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      backendUrl,
      apiKey,
      userId: userIdInput.value.trim() || "default",
    });

    openZaloBtn.disabled = true;
    openZaloBtn.textContent = "⏳ Đang mở Zalo...";
    addLog("🔗 Mở tab Zalo chat...");

    try {
      await chrome.runtime.sendMessage({ type: "OPEN_ZALO" });
      // if (qrSection) qrSection.style.display = ""; // Commented out
      resetBtn.style.display = "";
      openZaloBtn.textContent = "🔗 Mở tab Zalo đăng nhập";
      addLog("✅ Tab Zalo đã mở. Hãy quét mã QR trực tiếp trên trình duyệt, sau đó quay lại đây bấm 'Đồng bộ session thủ công'.");
    } catch (e) {
      addLog(`❌ Lỗi: ${e.message}`, "error");
    } finally {
      openZaloBtn.disabled = false;
    }
  });

  // ─── Manual Sync Button ────────────────────────────────────────
manualSyncBtn.addEventListener('click', async () => {
  // Kiểm tra trước xem có tab Zalo đang mở không
  const tabs = await chrome.tabs.query({ url: ['https://chat.zalo.me/*', 'https://*.zalo.me/*'] });
  if (tabs.length === 0) {
    addLog('⚠️ Không tìm thấy tab Zalo nào đang mở. Hãy mở chat.zalo.me trước.', 'error');
    return;
  }

  manualSyncBtn.disabled = true;
  manualSyncBtn.textContent = '⏳ Đang đồng bộ...';
  addLog('🔄 Bắt đầu đồng bộ thủ công...');

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'MANUAL_SYNC' });
    if (resp.ok) {
      addLog('✅ Đồng bộ thành công!', 'success');
      updateStatus('confirmed');
      showConfirmedUI();
      if (resp.result) {
        addLog(`📊 ${JSON.stringify(resp.result).slice(0, 200)}`, 'success');
      }
    } else {
      addLog(`❌ ${resp.error || 'Unknown error'}`, 'error');
      updateStatus('error');
    }
  } catch (e) {
    addLog(`❌ Lỗi: ${e.message}`, 'error');
  } finally {
    manualSyncBtn.disabled = false;
    manualSyncBtn.textContent = '🔄 Đồng bộ session thủ công';
  }
});

  // ─── Reset Button ──────────────────────────────────────────────
  resetBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "RESET" });
    // if (qrSection) qrSection.style.display = "none"; // Commented out
    resetBtn.style.display = "none";
    // if (qrImage) qrImage.style.display = "none"; // Commented out
    // if (qrPlaceholder) qrPlaceholder.style.display = ""; // Commented out
    openZaloBtn.textContent = "🔗 Mở tab Zalo đăng nhập";
    updateStatus("idle");
    addLog("🗑️ Đã reset");
  });

  // ─── State Updates ─────────────────────────────────────────────

  function updateStatus(status, message) {
    statusDot.className = "status-dot";

    switch (status) {
      case "waiting_scan":
      case "opening":
        statusDot.classList.add("waiting");
        statusLabel.textContent = "Chờ quét QR";
        break;
      case "confirmed":
        statusDot.classList.add("connected");
        statusLabel.textContent = "Đã kết nối";
        break;
      case "qr_expired":
        statusDot.classList.add("error");
        statusLabel.textContent = "QR hết hạn";
        break;
      case "error":
        statusDot.classList.add("error");
        statusLabel.textContent = "Lỗi";
        break;
      default:
        statusLabel.textContent = "Chưa kết nối";
    }
  }

  function showConfirmedUI() {
    // Hide QR section when confirmed
    // if (qrSection) qrSection.style.display = "none"; // Commented out
    openZaloBtn.textContent = "✅ Đã kết nối Zalo";
    resetBtn.style.display = "";
  }

  function updateQr(dataUrl) {
    if (!qrImage || !qrPlaceholder) return;
    if (!dataUrl) {
      qrImage.style.display = 'none';
      qrPlaceholder.style.display = '';
      return;
    }
    // Hỗ trợ: data URL, http URL (CORS fallback), hoặc raw base64
    if (dataUrl.startsWith('data:') || dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
      qrImage.src = dataUrl;
    } else {
      qrImage.src = `data:image/png;base64,${dataUrl}`;
    }
    qrImage.style.display = 'block';
    qrPlaceholder.style.display = 'none';
  }

  function addLog(text, type = "") {
    logSection.style.display = "";
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    entry.innerHTML = `<span class="log-time">${time}</span>${text}`;
    logBody.insertBefore(entry, logBody.firstChild);

    // Keep only last 30 entries
    while (logBody.children.length > 30) {
      logBody.removeChild(logBody.lastChild);
    }
  }

  // ─── Listen for Background State Updates ───────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "STATE_UPDATE") {
      updateStatus(msg.loginStatus);

      /* Commented out QR Display
      if (
        msg.loginStatus === "waiting_scan" ||
        msg.loginStatus === "opening" ||
        msg.loginStatus === "qr_expired"
      ) {
        if (qrSection) qrSection.style.display = "";
        resetBtn.style.display = "";
      }

      if (msg.qrDataUrl) {
        updateQr(msg.qrDataUrl);
      } else if (msg.loginStatus === "waiting_scan" || msg.loginStatus === "opening") {
        updateQr(null); // Show spinner placeholder
      }
      */

      // Still show reset button if we are not idle
      if (msg.loginStatus !== "idle") {
        resetBtn.style.display = "";
      }

      if (msg.loginStatus === "confirmed") {
        showConfirmedUI();
      }

      if (msg.message) {
        const type = msg.error
          ? "error"
          : msg.message.startsWith("✅")
            ? "success"
            : "";
        addLog(msg.message, type);
      }
    }
  });

  // ─── Initial State Load ────────────────────────────────────────
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (state) {
      updateStatus(state.loginStatus);

      /* Commented out QR Display
      if (
        state.loginStatus === "waiting_scan" ||
        state.loginStatus === "opening" ||
        state.loginStatus === "qr_expired"
      ) {
        if (qrSection) qrSection.style.display = "";
        resetBtn.style.display = "";
      }

      if (state.qrDataUrl) {
        updateQr(state.qrDataUrl);
      }
      */

      if (state.loginStatus !== "idle") {
        resetBtn.style.display = "";
      }

      if (state.loginStatus === "confirmed") {
        showConfirmedUI();
      }
      if (state.zaloTabId) {
        openZaloBtn.textContent = "🔗 Mở tab Zalo đăng nhập";
      }
    }
  } catch (e) {
    console.debug("Could not get initial state:", e);
  }
});
