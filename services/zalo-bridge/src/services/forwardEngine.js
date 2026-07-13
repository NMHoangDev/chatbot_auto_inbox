/**
 * forwardEngine.js
 *
 * "Nhóm chính" auto-forward: khi có tin nhắn mới trong 1 group được cấu hình
 * làm master_thread_id (bảng zalo_forward_rules, xem migration
 * 2026-07-09_zalo_forward_rules.sql), tự động chuyển tiếp sang các group
 * đích (zalo_forward_targets).
 *
 * Được gọi (fire-and-forget, KHÔNG await) từ sessionManager.js ngay khi nhận
 * message trong 1 group — không phụ thuộc isSelf, vì user muốn forward TẤT
 * CẢ tin nhắn trong nhóm chính (không riêng tin của chủ tài khoản).
 *
 * Content type hỗ trợ:
 *   - text    → dùng api.forwardMessage() gốc của zca-js, fan-out 1 lệnh tới
 *               tất cả target cùng lúc (nhanh, giữ tag "đã chuyển tiếp").
 *   - image/file → tải file từ Zalo CDN (resolveImageUrls) rồi gửi lại từng
 *               target qua api.sendMessage({attachments}) — zca-js không hỗ
 *               trợ forward-by-reference cho media. Nhiều ảnh gửi cùng lúc
 *               (1 "album") tới TỪ CÙNG 1 người trong TỪNG group nguồn được
 *               gom lại (xem IMAGE_BATCH_MS/queueImageForBatch) rồi forward
 *               trong 1 lệnh sendMessage({attachments: [...]}) duy nhất —
 *               BẮT BUỘC phải gom vì zca-js chỉ gắn metadata nhóm ảnh
 *               (groupLayoutId/idInGroup) khi `attachments` có >1 phần tử
 *               trong CÙNG 1 lệnh gọi; Zalo lại luôn gửi mỗi ảnh trong 1
 *               album như 1 sự kiện WS tin nhắn RIÊNG BIỆT (không phải 1 tin
 *               kèm nhiều ảnh) nên nếu forward ngay theo từng sự kiện, mỗi
 *               ảnh sẽ ra 1 tin nhắn tách rời ở phía nhận thay vì gộp thành
 *               1 khối ảnh như bản gốc (bug quan sát được 2026-07-13).
 *   - sticker → gửi lại bằng api.sendSticker({id, cateId, type}).
 *   - loại khác (link share, video call, ...) → log 'unsupported', bỏ qua.
 *
 * An toàn / ổn định:
 *   - Loop-guard: nhớ id các message do chính engine này vừa gửi (60s) để
 *     không xử lý lại khi chính tài khoản nhận lại tin đó qua listener.
 *   - Validation cấu trúc (master != target) được enforce ở API route
 *     (app/api/zalo/forward-rules) khi tạo/sửa rule — đây chỉ là lớp phòng
 *     vệ runtime bổ sung.
 *   - Rate limit đơn giản theo account (mặc định 60 lượt forward/phút) để
 *     tránh spam group / bị Zalo rate-limit khi cấu hình sai.
 *   - Delay ~10s (FORWARD_DELAY_MS, override qua env ZALO_FORWARD_DELAY_MS)
 *     giữa mỗi lượt gửi (target/rule kế tiếp) để tránh chạm rate-limit phía
 *     Zalo — media/sticker luôn tuần tự + delay; text cũng delay giữa các
 *     rule (nếu 1 master có nhiều rule) dù trong 1 rule vẫn fan-out 1 lệnh.
 *   - Retry 1 lần (withRetry, cách nhau ~1.5s) cho download ảnh và cho lệnh
 *     gửi (sendMessage/sendSticker/forwardMessage) — Zalo API đôi khi lỗi
 *     tạm thời (timeout, "Lỗi không xác định"...), retry giúp ảnh/tin không
 *     bị rớt oan chỉ vì 1 lần gọi API flaky.
 *   - Mọi lỗi đều bị bắt + log vào zalo_forward_logs, không throw ngược lên
 *     listener (tránh crash / block xử lý message khác).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { ThreadType } from 'zca-js';
import { logger } from '../utils/logger.js';
import { getClient, resolveImageUrls } from './supabaseSync.js';

const TEMP_DIR = process.env.ZALO_FORWARD_TEMP_DIR || '/app/data/temp_attachments';
try {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
} catch (_) {
  /* ignore — best effort, download sẽ tự fail nếu dir không ghi được */
}

const RULES_CACHE_TTL_MS = 8000;
// Delay giữa các lượt gửi liên tiếp (target/rule kế tiếp) — tăng từ 3s lên
// 10s theo yêu cầu để tránh chạm rate-limit của Zalo khi 1 rule có nhiều
// target hoặc 1 master có nhiều rule. Override qua env nếu cần tinh chỉnh.
const FORWARD_DELAY_MS = Number(process.env.ZALO_FORWARD_DELAY_MS || 10000);
const RETRY_DELAY_MS = 1500;
const MAX_PER_MIN = Number(process.env.ZALO_FORWARD_MAX_PER_MIN || 60);
// Cửa sổ chờ gom nhiều ảnh gửi cùng lúc (1 "album") thành 1 lượt forward.
// Zalo bắn mỗi ảnh trong 1 album như 1 message event riêng, cách nhau vài
// chục-vài trăm ms tuỳ tốc độ upload/mạng — 1200ms đủ rộng để gom hết ảnh
// trong 1 lần gửi thực tế, mà không làm ảnh đơn lẻ (không thuộc album nào)
// bị trễ đáng kể khi forward.
const IMAGE_BATCH_MS = Number(process.env.ZALO_FORWARD_IMAGE_BATCH_MS || 1200);

const rulesCacheByAccount = new Map(); // accountId -> { fetchedAt, rulesByMaster: Map<threadId, rule[]> }
const forwardedIds = new Set(); // `${accountId}_${msgId}` — id do chính engine gửi
const processedSource = new Set(); // `${accountId}:${threadId}:${msgId}` — chống xử lý trùng 1 nguồn
const rateState = new Map(); // accountId -> { windowStart, count }
// Gom ảnh cùng batch — key `${accountId}:${threadId}:${senderUid}`, value
// { imageUrls, sourceMsgIds, rules, api, timer }. Chỉ sống trong bộ nhớ,
// không cần persist (mất khi restart bridge là chấp nhận được, ảnh đang dở
// dang batch cùng lắm bị forward rời — không mất dữ liệu).
const imageBatches = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry đơn giản 1 lần cho các lệnh gọi hay flaky (download ảnh, gửi tin) —
// Zalo API/CDN đôi khi lỗi tạm thời, retry 1 lần sau RETRY_DELAY_MS thường đủ
// để không mất ảnh/tin oan. Không retry vô hạn để tránh spam khi lỗi thật.
async function withRetry(fn, { attempts = 2, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        logger.warn(`[forward] ${label} failed (attempt ${i + 1}/${attempts}), retry sau ${RETRY_DELAY_MS}ms: ${err.message}`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

function markForwarded(accountId, ids) {
  for (const id of ids) {
    if (id == null) continue;
    const key = `${accountId}_${id}`;
    forwardedIds.add(key);
    setTimeout(() => forwardedIds.delete(key), 60000);
  }
}

function isAlreadyForwarded(accountId, ids) {
  return ids.some((id) => id != null && forwardedIds.has(`${accountId}_${id}`));
}

function markSourceProcessed(key) {
  processedSource.add(key);
  setTimeout(() => processedSource.delete(key), 60000);
}

function consumeRateBudget(accountId) {
  const now = Date.now();
  const s = rateState.get(accountId);
  if (!s || now - s.windowStart >= 60000) {
    rateState.set(accountId, { windowStart: now, count: 1 });
    return true;
  }
  if (s.count >= MAX_PER_MIN) return false;
  s.count += 1;
  return true;
}

async function loadRulesByMaster(accountId) {
  const cached = rulesCacheByAccount.get(accountId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < RULES_CACHE_TTL_MS) return cached.rulesByMaster;

  const rulesByMaster = new Map();
  const sb = getClient();
  if (!sb) {
    rulesCacheByAccount.set(accountId, { fetchedAt: now, rulesByMaster });
    return rulesByMaster;
  }
  try {
    const { data, error } = await sb
      .from('v_zalo_forward_rules_active')
      .select('rule_id, master_thread_id, target_thread_id')
      .eq('account_id', accountId);
    if (!error && Array.isArray(data)) {
      const byRule = new Map();
      for (const row of data) {
        if (!byRule.has(row.rule_id)) {
          byRule.set(row.rule_id, {
            rule_id: row.rule_id,
            master_thread_id: row.master_thread_id,
            targets: [],
          });
        }
        byRule.get(row.rule_id).targets.push({ target_thread_id: row.target_thread_id });
      }
      for (const rule of byRule.values()) {
        const list = rulesByMaster.get(rule.master_thread_id) || [];
        list.push(rule);
        rulesByMaster.set(rule.master_thread_id, list);
      }
    } else if (error) {
      logger.warn(`[forward] [${accountId}] load rules err: ${error.message}`);
    }
  } catch (err) {
    logger.error(`[forward] [${accountId}] load rules failed: ${err.message}`);
  }
  rulesCacheByAccount.set(accountId, { fetchedAt: now, rulesByMaster });
  return rulesByMaster;
}

async function getRulesForMaster(accountId, threadId) {
  const map = await loadRulesByMaster(accountId);
  return map.get(threadId) || [];
}

async function logForward(entry) {
  try {
    const sb = getClient();
    if (!sb) return;
    await sb.from('zalo_forward_logs').insert({
      rule_id: entry.rule_id ?? null,
      account_id: entry.account_id,
      source_thread_id: entry.source_thread_id,
      source_msg_id: entry.source_msg_id ?? null,
      target_thread_id: entry.target_thread_id,
      content_type: entry.content_type,
      status: entry.status,
      error: entry.error ?? null,
    });
  } catch (err) {
    logger.error(`[forward] logForward failed: ${err.message}`);
  }
}

async function downloadToTemp(url) {
  try {
    return await withRetry(
      async () => {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
        const buf = Buffer.from(res.data);
        const urlParts = url.split('/');
        const lastPart = (urlParts[urlParts.length - 1] || '').split('?')[0];
        const filename = lastPart && lastPart.includes('.') ? lastPart : 'file';
        const tempPath = path.join(TEMP_DIR, `${crypto.randomUUID()}_${filename}`);
        fs.writeFileSync(tempPath, buf);
        return tempPath;
      },
      { label: `download url=${url}` }
    );
  } catch (err) {
    logger.error(`[forward] download failed url=${url}: ${err.message}`);
    return null;
  }
}

// ── Text: 1 lệnh forwardMessage() native fan-out tới tất cả target của rule ──
// Delay FORWARD_DELAY_MS giữa các rule (nếu 1 master có nhiều rule) — trong
// cùng 1 rule vẫn gửi 1 lệnh fan-out tới mọi target (không cần delay nội bộ).
async function forwardText({ accountId, api, rules, threadId, sourceMsgId, msg, text }) {
  const ts = Number(msg.data?.ts) || Date.now();
  let isFirstRule = true;
  for (const rule of rules) {
    const targetIds = rule.targets.map((t) => t.target_thread_id);
    if (targetIds.length === 0) continue;
    if (!isFirstRule) await sleep(FORWARD_DELAY_MS);
    isFirstRule = false;
    const targetSummary = targetIds.join(',');
    try {
      const resp = await withRetry(
        () =>
          api.forwardMessage(
            {
              message: text,
              reference: sourceMsgId
                ? { id: String(sourceMsgId), ts, logSrcType: 1, fwLvl: 1 }
                : undefined,
            },
            targetIds,
            ThreadType.Group
          ),
        { label: `forwardText rule=${rule.rule_id}` }
      );
      const successCount = resp?.success?.length || 0;
      const failCount = resp?.fail?.length || 0;
      markForwarded(
        accountId,
        (resp?.success || []).map((s) => s.msgId).filter((x) => x != null)
      );
      await logForward({
        rule_id: rule.rule_id,
        account_id: accountId,
        source_thread_id: threadId,
        source_msg_id: sourceMsgId,
        target_thread_id: targetSummary,
        content_type: 'text',
        status: failCount === 0 ? 'success' : successCount > 0 ? 'partial' : 'failed',
        error: failCount > 0 ? JSON.stringify(resp.fail) : null,
      });
    } catch (err) {
      logger.error(`[forward] [${accountId}] forwardText rule=${rule.rule_id} failed: ${err.message}`);
      await logForward({
        rule_id: rule.rule_id,
        account_id: accountId,
        source_thread_id: threadId,
        source_msg_id: sourceMsgId,
        target_thread_id: targetSummary,
        content_type: 'text',
        status: 'failed',
        error: err.message,
      });
    }
  }
}

// ── Media (ảnh/file): tải 1 lần, gửi lại tuần tự từng target (delay FORWARD_DELAY_MS) ──
async function forwardMedia({ accountId, api, rules, threadId, sourceMsgId, imageUrls }) {
  const localPaths = [];
  try {
    for (const url of imageUrls) {
      const p = await downloadToTemp(url);
      if (p) localPaths.push(p);
    }
    if (localPaths.length === 0) {
      for (const rule of rules) {
        for (const target of rule.targets) {
          await logForward({
            rule_id: rule.rule_id,
            account_id: accountId,
            source_thread_id: threadId,
            source_msg_id: sourceMsgId,
            target_thread_id: target.target_thread_id,
            content_type: 'media',
            status: 'failed',
            error: 'download_failed',
          });
        }
      }
      return;
    }

    let isFirst = true;
    for (const rule of rules) {
      for (const target of rule.targets) {
        if (!isFirst) await sleep(FORWARD_DELAY_MS);
        isFirst = false;
        try {
          const result = await withRetry(
            () =>
              api.sendMessage(
                { msg: '', attachments: localPaths.length === 1 ? localPaths[0] : localPaths },
                target.target_thread_id,
                ThreadType.Group
              ),
            { label: `forwardMedia rule=${rule.rule_id} target=${target.target_thread_id}` }
          );
          markForwarded(accountId, [
            result?.message?.msgId,
            ...(result?.attachment || []).map((a) => a?.msgId),
          ]);
          await logForward({
            rule_id: rule.rule_id,
            account_id: accountId,
            source_thread_id: threadId,
            source_msg_id: sourceMsgId,
            target_thread_id: target.target_thread_id,
            content_type: 'media',
            status: 'success',
          });
        } catch (err) {
          logger.error(
            `[forward] [${accountId}] forwardMedia rule=${rule.rule_id} target=${target.target_thread_id} failed: ${err.message}`
          );
          await logForward({
            rule_id: rule.rule_id,
            account_id: accountId,
            source_thread_id: threadId,
            source_msg_id: sourceMsgId,
            target_thread_id: target.target_thread_id,
            content_type: 'media',
            status: 'failed',
            error: err.message,
          });
        }
      }
    }
  } finally {
    for (const p of localPaths) {
      try {
        fs.unlinkSync(p);
      } catch (_) {
        /* ignore cleanup error */
      }
    }
  }
}

// ── Gom ảnh cùng 1 batch (1 người, 1 group nguồn) trước khi forward ─────────
// Mỗi ảnh trong 1 "album" Zalo gửi tới như 1 message event riêng — reset timer
// mỗi khi có ảnh mới thuộc cùng batch, chỉ thực sự forward khi im lặng đủ
// IMAGE_BATCH_MS (không còn ảnh nào tới thêm) → gộp toàn bộ ảnh gom được vào
// 1 lệnh forwardMedia() duy nhất (nhiều attachments → zca-js tự gắn metadata
// nhóm ảnh, xem sendMessage.js#handleAttachment isMultiFile).
function queueImageForBatch({ accountId, api, rules, threadId, sourceMsgId, senderUid, imageUrls }) {
  const key = `${accountId}:${threadId}:${senderUid || 'unknown'}`;
  let batch = imageBatches.get(key);
  if (!batch) {
    batch = { imageUrls: [], sourceMsgIds: [], timer: null };
    imageBatches.set(key, batch);
  }
  batch.imageUrls.push(...imageUrls);
  if (sourceMsgId) batch.sourceMsgIds.push(sourceMsgId);
  // rules/api có thể lệch nhẹ giữa các ảnh trong cùng batch (rules cache
  // refresh, session reconnect...) — luôn dùng bản mới nhất khi flush.
  batch.accountId = accountId;
  batch.api = api;
  batch.rules = rules;
  batch.threadId = threadId;
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    imageBatches.delete(key);
    forwardMedia({
      accountId: batch.accountId,
      api: batch.api,
      rules: batch.rules,
      threadId: batch.threadId,
      sourceMsgId: batch.sourceMsgIds[0] || null,
      imageUrls: batch.imageUrls,
    }).catch((err) => {
      logger.error(`[forward] [${batch.accountId}] forwardMedia batch flush failed: ${err.message}`);
    });
  }, IMAGE_BATCH_MS);
}

// ── Sticker: gửi lại qua sendSticker({id, cateId, type}) từng target ────────
async function forwardSticker({ accountId, api, rules, threadId, sourceMsgId, sticker }) {
  const payload = {
    id: Number(sticker.id),
    cateId: Number(sticker.cateId),
    type: Number(sticker.type) || 1,
  };
  let isFirst = true;
  for (const rule of rules) {
    for (const target of rule.targets) {
      if (!isFirst) await sleep(FORWARD_DELAY_MS);
      isFirst = false;
      try {
        const result = await withRetry(
          () => api.sendSticker(payload, target.target_thread_id, ThreadType.Group),
          { label: `forwardSticker rule=${rule.rule_id} target=${target.target_thread_id}` }
        );
        markForwarded(accountId, [result?.msgId]);
        await logForward({
          rule_id: rule.rule_id,
          account_id: accountId,
          source_thread_id: threadId,
          source_msg_id: sourceMsgId,
          target_thread_id: target.target_thread_id,
          content_type: 'sticker',
          status: 'success',
        });
      } catch (err) {
        logger.error(
          `[forward] [${accountId}] forwardSticker rule=${rule.rule_id} target=${target.target_thread_id} failed: ${err.message}`
        );
        await logForward({
          rule_id: rule.rule_id,
          account_id: accountId,
          source_thread_id: threadId,
          source_msg_id: sourceMsgId,
          target_thread_id: target.target_thread_id,
          content_type: 'sticker',
          status: 'failed',
          error: err.message,
        });
      }
    }
  }
}

/**
 * Entry point — gọi fire-and-forget từ sessionManager listener khi nhận
 * message trong 1 group (isGroupMsg === true), bất kể isSelf.
 *
 * @param {object} args
 * @param {string} args.accountId
 * @param {object} args.api        — zca-js API instance của session hiện tại
 * @param {object} args.msg        — raw message object từ listener
 * @param {string} args.threadId   — group threadId (= master_thread_id cần khớp)
 */
export async function handleIncomingGroupMessage({ accountId, api, msg, threadId }) {
  try {
    if (!threadId || !api || !accountId) return;

    const ids = [msg.data?.cliMsgId, msg.data?.msgId, msg.data?.globalMsgId].filter(
      (x) => x != null
    );
    if (isAlreadyForwarded(accountId, ids)) return;

    const sourceMsgId = ids[0] != null ? String(ids[0]) : null;
    const sourceKey = `${accountId}:${threadId}:${sourceMsgId || msg.data?.ts || ''}`;
    if (processedSource.has(sourceKey)) return;
    markSourceProcessed(sourceKey);

    const rules = await getRulesForMaster(accountId, threadId);
    if (rules.length === 0) return;

    if (!consumeRateBudget(accountId)) {
      logger.warn(`[forward] [${accountId}] rate limit (${MAX_PER_MIN}/min) exceeded, skip master=${threadId}`);
      return;
    }

    const rawContent = msg.data?.content;
    const text = typeof rawContent === 'string' ? rawContent.trim() : '';

    if (text) {
      await forwardText({ accountId, api, rules, threadId, sourceMsgId, msg, text });
      return;
    }

    const imageUrls = resolveImageUrls(msg);
    if (imageUrls.length > 0) {
      queueImageForBatch({ accountId, api, rules, threadId, sourceMsgId, senderUid: msg.data?.uidFrom || null, imageUrls });
      return;
    }

    if (
      rawContent &&
      typeof rawContent === 'object' &&
      Number.isFinite(Number(rawContent.id)) &&
      Number.isFinite(Number(rawContent.cateId))
    ) {
      await forwardSticker({ accountId, api, rules, threadId, sourceMsgId, sticker: rawContent });
      return;
    }

    for (const rule of rules) {
      await logForward({
        rule_id: rule.rule_id,
        account_id: accountId,
        source_thread_id: threadId,
        source_msg_id: sourceMsgId,
        target_thread_id: rule.targets.map((t) => t.target_thread_id).join(',') || 'N/A',
        content_type: 'unsupported',
        status: 'skipped',
        error: 'unsupported_content_type',
      });
    }
  } catch (err) {
    logger.error(
      `[forward] [${accountId}] handleIncomingGroupMessage error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
