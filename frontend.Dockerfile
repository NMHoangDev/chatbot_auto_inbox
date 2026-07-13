# =============================================================================
# Stage 1 — build: compile Next.js output
#
# NEXT_PUBLIC_* biến được Next.js "bake" thẳng vào JS bundle gửi cho trình
# duyệt NGAY LÚC BUILD (next build), không phải lúc container chạy — nên
# PHẢI truyền qua --build-arg (ARG + ENV dưới đây), không thể chỉ set ở
# `environment:` của docker-compose (compose env chỉ áp dụng lúc container
# RUN, next build đã chạy xong từ trước trong stage builder). Thiếu bước
# này, mọi trình duyệt sẽ nhận bundle với giá trị fallback hard-code trong
# lib/zalo-api.ts (http://localhost:3001) — chỉ chạy được trên máy dev, sai
# hoàn toàn khi deploy thật.
# =============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_ZALO_BRIDGE_URL
ARG NEXT_PUBLIC_ZALO_ACCOUNT_ID
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_PUBLIC_ZALO_BRIDGE_URL=${NEXT_PUBLIC_ZALO_BRIDGE_URL} \
    NEXT_PUBLIC_ZALO_ACCOUNT_ID=${NEXT_PUBLIC_ZALO_ACCOUNT_ID}

RUN npm run build

# =============================================================================
# Stage 2 — runtime: chỉ giữ package.json + .next + public đã build
# =============================================================================
FROM node:22-alpine AS runner

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN addgroup -g 1001 -S nodejs \
    && adduser -S nextjs -u 1001

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=25s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1

CMD ["npm", "run", "start"]
