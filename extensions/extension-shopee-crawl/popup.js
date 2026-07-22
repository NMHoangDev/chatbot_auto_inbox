const backendUrlEl = document.getElementById("backendUrl");
const apiKeyEl = document.getElementById("apiKey");
const accountIdEl = document.getElementById("accountId");
const configStatusEl = document.getElementById("configStatus");

async function loadConfig() {
  const { backendUrl, apiKey, accountId } = await chrome.storage.local.get([
    "backendUrl",
    "apiKey",
    "accountId"
  ]);
  backendUrlEl.value = backendUrl || "http://localhost:3000";
  apiKeyEl.value = apiKey || "";
  accountIdEl.value = accountId || "";
}

async function saveConfig() {
  await chrome.storage.local.set({
    backendUrl: backendUrlEl.value.trim() || "http://localhost:3000",
    apiKey: apiKeyEl.value.trim(),
    accountId: accountIdEl.value.trim()
  });
  configStatusEl.textContent = "✓ Đã lưu cấu hình";
  setTimeout(() => (configStatusEl.textContent = ""), 2000);
}

document.getElementById("saveConfigBtn").addEventListener("click", saveConfig);
loadConfig();

// ---------- Crawl shop trong tab thật ----------

const crawlBtn = document.getElementById("crawlBtn");
const crawlStatus = document.getElementById("crawlStatus");

function extractUsername(input) {
  const trimmed = input.trim();
  const m = trimmed.match(/shopee\.vn\/([^/?#]+)/);
  return m ? m[1] : trimmed;
}

const STATE_LABEL = { running: "Đang chạy", done: "Xong", error: "Lỗi" };
const STATE_CLASS = { running: "running", done: "ok", error: "err" };

function renderStatusBox(el, status) {
  el.innerHTML = "";
  if (!status) return;

  const badge = document.createElement("span");
  badge.className = `mini-badge ${STATE_CLASS[status.state] || "running"}`;
  badge.innerHTML = "<span class=\"dot\"></span>";
  badge.appendChild(document.createTextNode(STATE_LABEL[status.state] || status.state));

  const msg = document.createElement("span");
  msg.textContent = status.message || "";

  el.appendChild(badge);
  el.appendChild(msg);
}

function renderCrawlStatus(status) {
  renderStatusBox(crawlStatus, status);
  crawlBtn.disabled = !!status && status.state === "running";
}

function renderEnrichStatus(status) {
  renderStatusBox(enrichStatus, status);
  enrichBtn.disabled = !!status && status.state === "running";
}

async function loadStatuses() {
  const { crawlStatus: cs, enrichStatus: es } = await chrome.storage.local.get([
    "crawlStatus",
    "enrichStatus"
  ]);
  renderCrawlStatus(cs);
  renderEnrichStatus(es);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.crawlStatus) renderCrawlStatus(changes.crawlStatus.newValue);
  if (changes.enrichStatus) renderEnrichStatus(changes.enrichStatus.newValue);
});

async function startCrawl() {
  const rawInput = document.getElementById("shopUrl").value;
  const shopUsername = extractUsername(rawInput);

  if (!shopUsername) {
    crawlStatus.textContent = "✗ Nhập link hoặc username shop";
    return;
  }

  crawlBtn.disabled = true;
  crawlStatus.textContent = "Đang gửi lệnh crawl cho background...";

  // Chạy trong background.js (service worker) — KHÔNG chạy ở đây, vì popup
  // sẽ bị Chrome tự đóng khi tab mới giành focus, làm chết script đang chạy
  // dở. Có thể đóng popup ngay sau khi bấm; tiến trình vẫn tiếp tục, mở lại
  // popup bất cứ lúc nào để xem tiếp (badge trên icon cũng hiện số sản phẩm).
  await chrome.runtime.sendMessage({ type: "START_CRAWL", shopUsername });
  crawlStatus.textContent = "Đã bắt đầu — có thể đóng popup, mở lại để xem tiến trình.";
  await chrome.storage.local.set({ lastShopUsername: shopUsername });
}

crawlBtn.addEventListener("click", startCrawl);

// ---------- Bổ sung mô tả chi tiết ----------

const enrichBtn = document.getElementById("enrichBtn");
const enrichStatus = document.getElementById("enrichStatus");

async function startEnrich() {
  const { lastShopUsername } = await chrome.storage.local.get(["lastShopUsername"]);
  const shopUsername = lastShopUsername || extractUsername(document.getElementById("shopUrl").value);
  if (!shopUsername) {
    enrichStatus.textContent = "✗ Chưa có shop nào vừa crawl — chạy bước 2 trước.";
    return;
  }
  enrichBtn.disabled = true;
  enrichStatus.textContent = "Đang gửi lệnh cho background...";
  await chrome.runtime.sendMessage({ type: "START_ENRICH", shopUsername });
  enrichStatus.textContent = "Đã bắt đầu — có thể mất vài phút, mở lại popup để xem tiến trình.";
}

enrichBtn.addEventListener("click", startEnrich);

loadStatuses();
