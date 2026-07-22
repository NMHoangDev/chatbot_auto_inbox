// Chạy trong MAIN world (cùng ngữ cảnh JS với trang Shopee thật) TRƯỚC khi
// trang tải xong, để "nghe lén" response của các request mà chính JS của
// Shopee tự phát ra khi cuộn/mở trang — thay vì tự dựng request (sẽ thiếu
// header ký số af-ac-enc-dat/x-sap-sec do SDK chống bot của Shopee tự tính).
//
// Bắt 2 loại response:
//   - search_items / rcmd_items  -> danh sách sản phẩm khi mở trang shop
//     (window.__crawledItems / __crawledMeta, dùng bởi runCrawl()).
//   - pdp/get_pc (trang chi tiết 1 sản phẩm) -> mô tả đầy đủ, không có trong
//     danh sách trên (window.__productDetail, dùng bởi runEnrichDescriptions()).
(function () {
  if (window.__shopeeInterceptorInstalled) return;
  window.__shopeeInterceptorInstalled = true;
  window.__crawledItems = window.__crawledItems || [];
  // Metadata "còn hàng hay hết" lấy trực tiếp từ response Shopee — dùng để
  // background.js biết chính xác khi nào dừng phân trang, thay vì đoán qua
  // số lượng item (trang vượt quá trang cuối Shopee trả lại y hệt trang cuối,
  // không trả rỗng, nên đếm-số-item-rỗng sẽ không bao giờ dừng đúng).
  window.__crawledMeta = window.__crawledMeta || { total: null, noMore: false };
  window.__productDetail = null;

  const ITEM_URL_RE = /search_items|rcmd_items/;
  const DETAIL_URL_RE = /pdp\/get_pc|\/get_pc[?/]/;

  function extractItems(data) {
    if (!data) return { items: [], total: null, noMore: false };
    if (Array.isArray(data.items)) {
      return { items: data.items, total: data.total ?? data.total_count ?? null, noMore: !!(data.no_more ?? data.nomore) };
    }
    if (data.data && Array.isArray(data.data.items)) {
      const d = data.data;
      return { items: d.items, total: d.total ?? d.total_count ?? null, noMore: !!(d.no_more ?? d.nomore) };
    }
    // rcmd_items (tab "Phổ biến" mặc định của shop hiện nay) lồng item ở đây,
    // không phải data.items — thiếu nhánh này thì bắt được response nhưng ra 0 sản phẩm.
    if (
      data.data &&
      data.data.centralize_item_card &&
      Array.isArray(data.data.centralize_item_card.item_cards)
    ) {
      const d = data.data;
      return { items: d.centralize_item_card.item_cards, total: d.total ?? null, noMore: !!d.no_more };
    }
    return { items: [], total: null, noMore: false };
  }

  function recordItems(parsed) {
    const { items, total, noMore } = extractItems(parsed);
    if (items.length) window.__crawledItems.push(...items);
    if (total !== null) window.__crawledMeta.total = total;
    if (noMore) window.__crawledMeta.noMore = true;
  }

  function recordDetail(parsed) {
    const item = parsed && parsed.data && parsed.data.item;
    if (!item) return;
    window.__productDetail = {
      itemid: item.itemid,
      shopid: item.shopid,
      description: item.description || item.desc || null
    };
  }

  function handle(url, parsed) {
    try {
      if (ITEM_URL_RE.test(url)) recordItems(parsed);
      if (DETAIL_URL_RE.test(url)) recordDetail(parsed);
    } catch (e) {
      /* ignore — response không đúng shape mong đợi, không làm gì cả */
    }
  }

  // Patch XMLHttpRequest (request thật của Shopee dùng XHR, thấy rõ trong header x-requested-with: XMLHttpRequest)
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__interceptUrl = url;
    return OrigOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      const url = this.__interceptUrl;
      if (!url || !(ITEM_URL_RE.test(url) || DETAIL_URL_RE.test(url))) return;
      try {
        handle(url, JSON.parse(this.responseText));
      } catch (e) {
        /* ignore parse errors từ response không liên quan */
      }
    });
    return OrigSend.apply(this, arguments);
  };

  // Phòng trường hợp Shopee đổi sang dùng fetch() ở phiên bản khác
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const p = origFetch.apply(this, arguments);
    if (url && (ITEM_URL_RE.test(url) || DETAIL_URL_RE.test(url))) {
      p.then((r) => r.clone().json())
        .then((data) => handle(url, data))
        .catch(() => {});
    }
    return p;
  };
})();
