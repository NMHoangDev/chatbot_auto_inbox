# =============================================================================
# Zalo Bridge — Express server (Node 22)
# Bridge login vào 1 tài khoản Zalo cá nhân qua zca-js, expose REST + SSE, tự
# ghi trực tiếp vào Supabase. Cần `sharp` (native) nên dùng đầy đủ build
# toolchain ở stage deps.
#
# Node 22+ bắt buộc: @supabase/realtime-js (dep của @supabase/supabase-js,
# dùng trong supabaseSync.js) eager-resolve global WebSocket ngay khi
# createClient() được gọi (kể cả không dùng .channel()/realtime) — Node 20
# không có global WebSocket nên mọi lần gọi getClient() throw ngay, khiến
# forward-rules (forwardEngine.js) và persistIncomingMessage luôn fail.
# =============================================================================
FROM node:22-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy toàn bộ bridge trước để giải quyết `file:./zca-js` (local file ref).
COPY services/zalo-bridge ./

RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# =============================================================================
# Runtime stage
# =============================================================================
FROM node:22-alpine AS runner

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0

WORKDIR /app

RUN addgroup -g 1001 -S nodejs \
    && adduser -S bridge -u 1001

COPY --from=deps --chown=bridge:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=bridge:nodejs /app/src ./src
COPY --from=deps --chown=bridge:nodejs /app/zca-js ./zca-js
COPY --from=deps --chown=bridge:nodejs /app/package.json ./package.json

# Thư mục data/sessions cần ghi được (mounted volume ở compose)
RUN mkdir -p /app/data/sessions \
    && chown -R bridge:nodejs /app

USER bridge

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3001/health >/dev/null 2>&1 || exit 1

CMD ["node", "src/index.js"]
