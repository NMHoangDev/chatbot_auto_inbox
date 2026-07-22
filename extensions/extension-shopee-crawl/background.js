// Chạy toàn bộ tiến trình crawl ở đây (service worker), KHÔNG ở popup.js,
// vì Chrome tự đóng popup khi nó mất focus (ví dụ khi mở tab mới active:true)
// — làm chết mọi script async đang chạy dở trong popup. Tiến trình + kết quả
// được lưu vào chrome.storage.local để popup đọc lại bất cứ lúc nào (kể cả
// sau khi đóng mở lại popup).
//
// Cấu hình (backendUrl/apiKey) đọc từ chrome.storage.local — nhập 1 lần ở
// popup, không cần file config.js riêng (giống extension-login-zalo).

const MAX_PAGES = 40; // an toàn: ~40 trang, dừng sớm hơn nếu hết sản phẩm
const MAX_CONSECUTIVE_EMPTY = 2;
const ENRICH_FLUSH_EVERY = 20; // gửi lên server theo lô, tránh mất dữ liệu nếu dừng giữa chừng

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getConfig() {
  const { backendUrl, apiKey, accountId } = await chrome.storage.local.get([
    "backendUrl",
    "apiKey",
    "accountId"
  ]);
  return {
    backendUrl: (backendUrl || "http://localhost:3000").replace(/\/$/, ""),
    apiKey: apiKey || "",
    accountId: accountId || ""
  };
}

function buildPageUrl(username, page) {
  return `https://shopee.vn/${username}?page=${page}&sortBy=pop&tab=0`;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Chạy trong MAIN world của tab — đọc dữ liệu mà interceptor.js đã "nghe lén"
// được từ request thật của Shopee khi trang này load, cuộn thêm 1 chút để
// kích hoạt lazy-load nếu trang dùng infinite scroll trong 1 page.
async function collectFromCurrentPage() {
  for (let i = 0; i < 3; i++) {
    window.scrollBy(0, 1200);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { items: window.__crawledItems || [], meta: window.__crawledMeta || null };
}

async function collectDetailFromCurrentPage() {
  await new Promise((r) => setTimeout(r, 500));
  return window.__productDetail || null;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const b = raw.item_basic || raw;
    const key = b.itemid;
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(raw);
    }
  }
  return out;
}

/**
 * Chuẩn hoá 1 item thô Shopee trả về (search_items/rcmd_items) thành hàng
 * để lưu vào bảng products. Field mapping dựa trên quan sát thực tế response
 * search_items/rcmd_items hiện tại (2026) — Shopee có thể đổi shape bất cứ
 * lúc nào, nếu thấy imported=0 hoặc thiếu ảnh/giá thì kiểm tra lại đây.
 */
function extractProductRow(raw) {
  const b = raw.item_basic || raw;
  const itemId = b.itemid ?? b.item_id ?? null;
  const shopId = b.shopid ?? b.shop_id ?? null;
  if (!itemId || !shopId) return null;

  const name = b.name || (b.item_card_displayed_asset && b.item_card_displayed_asset.name) || "";
  const rawPrice =
    b.price ?? (b.item_card_display_price && b.item_card_display_price.price) ?? null;
  const price = rawPrice != null ? Math.round(Number(rawPrice) / 100000) : null;

  const imageHash =
    b.image ||
    (Array.isArray(b.images) && b.images[0]) ||
    (b.item_card_displayed_asset && b.item_card_displayed_asset.image) ||
    null;
  const imageUrl = imageHash ? `https://cf.shopee.vn/file/${imageHash}` : null;

  const sold = b.historical_sold ?? b.sold ?? null;
  const ratingStar = (b.item_rating && b.item_rating.rating_star) ?? b.rating_star ?? null;

  return {
    shopee_item_id: String(itemId),
    shopee_shop_id: String(shopId),
    name,
    price,
    image_url: imageUrl,
    sold_count: sold != null ? Number(sold) : null,
    rating: ratingStar != null ? Number(ratingStar) : null,
    shopee_url: `https://shopee.vn/product/${shopId}/${itemId}`,
    raw: raw
  };
}

async function setStatus(status) {
  await chrome.storage.local.set({ crawlStatus: status });
  chrome.action.setBadgeText({ text: status.badge || "" });
}

async function setEnrichStatus(status) {
  await chrome.storage.local.set({ enrichStatus: status });
}

async function pushImport(shopUsername, accountId, mode, items) {
  const { backendUrl, apiKey } = await getConfig();
  const res = await fetch(`${backendUrl}/api/shopee/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {})
    },
    body: JSON.stringify({ shop_username: shopUsername, account_id: accountId || null, mode, items })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function runCrawl(shopUsername) {
  await setStatus({ state: "running", message: "Đang mở tab...", total: 0, badge: "..." });

  let tab;
  let allItems = [];
  const seenIds = new Set();
  try {
    tab = await chrome.tabs.create({ url: buildPageUrl(shopUsername, 0), active: true });

    let page = 0;
    let consecutiveEmpty = 0; // không bắt được response nào (bị chặn / lỗi mạng)
    let consecutiveStagnant = 0; // bắt được response nhưng toàn sản phẩm đã thấy (đã qua trang cuối)

    while (page < MAX_PAGES && consecutiveEmpty < MAX_CONSECUTIVE_EMPTY && consecutiveStagnant < 1) {
      if (page > 0) {
        await chrome.tabs.update(tab.id, { url: buildPageUrl(shopUsername, page) });
      }
      await waitForTabComplete(tab.id);
      await sleep(3000); // để SDK chống bot + JS trang khởi tạo xong

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectFromCurrentPage,
        world: "MAIN"
      });

      const pageItems = result?.items || [];
      const meta = result?.meta || null;

      if (pageItems.length === 0) {
        consecutiveEmpty++;
        consecutiveStagnant = 0;
      } else {
        consecutiveEmpty = 0;
        let newCount = 0;
        for (const raw of pageItems) {
          const b = raw.item_basic || raw;
          const key = b.itemid;
          if (key && !seenIds.has(key)) {
            seenIds.add(key);
            allItems.push(raw);
            newCount++;
          }
        }
        // Trang này không đóng góp sản phẩm mới nào -> Shopee đang trả lại
        // y hệt trang cuối (đã vượt quá số trang thật của shop) -> dừng.
        consecutiveStagnant = newCount === 0 ? consecutiveStagnant + 1 : 0;
      }

      await setStatus({
        state: "running",
        message: `Đã crawl trang ${page + 1} — tổng ${allItems.length} sản phẩm`,
        total: allItems.length,
        badge: String(allItems.length)
      });

      if (meta && (meta.noMore || (meta.total !== null && allItems.length >= meta.total))) {
        break;
      }

      page++;
      await sleep(1000 + Math.random() * 800);
    }
  } finally {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }

  const unique = dedupe(allItems);
  if (unique.length === 0) {
    await setStatus({
      state: "error",
      message: "Không thu được sản phẩm nào — shop trống, URL sai, hoặc vẫn bị chặn.",
      total: 0,
      badge: "✗"
    });
    return;
  }

  const rows = unique.map(extractProductRow).filter(Boolean);

  await setStatus({
    state: "running",
    message: `Đang đồng bộ ${rows.length} sản phẩm vào kho tri thức...`,
    total: rows.length,
    badge: "..."
  });

  try {
    const { accountId } = await getConfig();
    const d = await pushImport(shopUsername, accountId, "upsert", rows);
    await chrome.storage.local.set({ lastShopUsername: shopUsername, lastShopId: d.shop_id || null });
    await setStatus({
      state: "done",
      message: `Hoàn tất — ${d.imported ?? rows.length}/${rows.length} sản phẩm đã lưu (tổng shop: ${d.total ?? "?"})`,
      total: d.total ?? rows.length,
      shopId: d.shop_id || null,
      badge: "OK"
    });
  } catch (e) {
    await setStatus({
      state: "error",
      message: "Crawl xong nhưng gửi lên server lỗi: " + e.message,
      total: rows.length,
      badge: "✗"
    });
  }
}

/**
 * Bước 2 (tuỳ chọn, chậm hơn & rủi ro anti-bot cao hơn crawl danh sách): mở
 * lại TỪNG trang sản phẩm trong 1 tab thật để lấy mô tả đầy đủ (không có
 * trong response danh sách search_items/rcmd_items). Xử lý tuần tự, delay
 * ~2.5-3.5s/sản phẩm, gửi cập nhật lên server theo lô 20 sản phẩm để không
 * mất dữ liệu nếu bị dừng giữa chừng.
 */
async function runEnrichDescriptions(shopUsername) {
  await setEnrichStatus({ state: "running", message: "Đang lấy danh sách sản phẩm cần bổ sung mô tả...", done: 0, total: 0 });

  const { backendUrl, apiKey, accountId } = await getConfig();
  let products;
  try {
    const { lastShopId } = await chrome.storage.local.get(["lastShopId"]);
    const url = lastShopId
      ? `${backendUrl}/api/shopee/products?shop_id=${encodeURIComponent(lastShopId)}&limit=2000`
      : `${backendUrl}/api/shopee/products?account_id=${encodeURIComponent(accountId)}&limit=2000`;
    const res = await fetch(url, { headers: apiKey ? { "X-API-Key": apiKey } : {} });
    const d = await res.json();
    products = (d.products || []).filter((p) => !p.description && p.shopee_url);
  } catch (e) {
    await setEnrichStatus({ state: "error", message: "Không lấy được danh sách sản phẩm: " + e.message });
    return;
  }

  if (products.length === 0) {
    await setEnrichStatus({ state: "done", message: "Không có sản phẩm nào cần bổ sung mô tả (đã đủ hoặc chưa crawl)." });
    return;
  }

  await setEnrichStatus({ state: "running", message: `Bắt đầu lấy mô tả cho ${products.length} sản phẩm...`, done: 0, total: products.length });

  let tab;
  let pending = [];
  async function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      await pushImport(shopUsername, accountId, "patch", batch);
    } catch (e) {
      // Không dừng cả tiến trình vì 1 lô lỗi — log lại, tiếp tục sản phẩm sau.
      console.warn("[Shopee Crawler] flush patch lỗi:", e.message);
    }
  }

  try {
    tab = await chrome.tabs.create({ url: products[0].shopee_url, active: true });
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (i > 0) await chrome.tabs.update(tab.id, { url: p.shopee_url });
      await waitForTabComplete(tab.id);
      await sleep(2500 + Math.random() * 1000);

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectDetailFromCurrentPage,
        world: "MAIN"
      });

      if (result && result.description) {
        pending.push({ shopee_item_id: p.shopee_item_id, description: result.description });
      }

      await setEnrichStatus({
        state: "running",
        message: `Đã xử lý ${i + 1}/${products.length} sản phẩm`,
        done: i + 1,
        total: products.length
      });

      if (pending.length >= ENRICH_FLUSH_EVERY) await flush();
    }
  } finally {
    await flush();
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }

  await setEnrichStatus({ state: "done", message: "Hoàn tất lấy mô tả sản phẩm." });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_CRAWL") {
    runCrawl(msg.shopUsername).catch((e) => {
      setStatus({ state: "error", message: "Lỗi: " + e.message, total: 0, badge: "✗" });
    });
    sendResponse({ ok: true });
  }
  if (msg.type === "START_ENRICH") {
    runEnrichDescriptions(msg.shopUsername).catch((e) => {
      setEnrichStatus({ state: "error", message: "Lỗi: " + e.message });
    });
    sendResponse({ ok: true });
  }
  return true;
});
