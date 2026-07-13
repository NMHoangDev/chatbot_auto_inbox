# Zalo Forward Demo — Docker deploy guide

Stack gồm 3 service chạy cùng Docker Compose:

| Service        | Port (container) | Lệnh                       | Vai trò                            |
|----------------|-------------------|----------------------------|-------------------------------------|
| `frontend`     | 3000              | `next start`               | Next.js UI + API (accounts/forward-rules) |
| `zalo-bridge`  | 3001              | `node src/index.js`        | Express: login Zalo + forward + SSE |
| `router`       | 8080              | `nginx`                    | Reverse proxy + SSE no-buffering    |

> Trên máy ảo mặc định `http://<IP_VM>:8080` (đổi `ROUTER_HTTP_PORT` nếu muốn host khác).
> **TODO:** khi có domain + máy ảo thật, cập nhật `ZALO_BRIDGE_PUBLIC_URL`, `ALLOWED_ORIGINS`,
> và (nếu cần) đổi port router sang `80:8080` / đặt Caddy-Cloudflare cấp TLS trước.

---

## 1. Chuẩn bị

```bash
cp .env.example .env
```

Sửa trong `.env` (KHÔNG commit file này):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `BRIDGE_API_KEY` — chọn một chuỗi ngẫu nhiên đủ mạnh
- `ZALO_BRIDGE_PUBLIC_URL=http://YOUR_DOMAIN/zalo-bridge` (khi đã có domain)
- `ALLOWED_ORIGINS=http://YOUR_DOMAIN,http://localhost:8080`

Chạy migration Supabase (`supabase/migrations/0001_...sql` rồi `0002_...sql`) trong SQL Editor
**trước khi** khởi động container, nếu chưa chạy.

---

## 2. Build & run

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f frontend
docker compose logs -f zalo-bridge
docker compose logs -f router
```

Healthcheck:
- `curl http://localhost:8080/` → render UI Next.js
- `curl http://localhost:8080/zalo-bridge/health` → `{"status":"ok",...}`

---

## 3. Cập nhật sau khi sửa code

```bash
git pull
docker compose build frontend            # chỉ rebuild service đã đổi
docker compose up -d --no-deps frontend
```

Rebuild bridge:
```bash
docker compose build zalo-bridge
docker compose up -d --no-deps zalo-bridge
```

> Đổi bất kỳ biến `NEXT_PUBLIC_*` nào trong `.env` → PHẢI rebuild `frontend`
> (không chỉ restart) vì các biến này được bake vào JS bundle lúc build, xem
> comment trong `frontend.Dockerfile`.

---

## 4. Volumes (dữ liệu persist)

| Volume          | Mount trong container | Nội dung                |
|-----------------|------------------------|--------------------------|
| `zalo-sessions` | `/app/data` (bridge)   | session zca-js đã login  |

Backup định kỳ:
```bash
docker run --rm -v zalo-forward-demo_zalo-sessions:/data -v $(pwd):/backup \
    alpine tar czf /backup/zalo-sessions-$(date +%F).tar.gz /data
```

---

## 5. Mapping URL với domain thật

Mặc định nginx nghe port 8080. Khi đã có domain + máy ảo (**TODO — bạn cung cấp sau**):

```yaml
# docker-compose.yml
ports:
  - "80:8080"     # chỉ HTTP, nên dùng Caddy/Cloudflare đứng trước cho TLS
```

Rồi rebuild `frontend` với `NEXT_PUBLIC_ZALO_BRIDGE_URL`/`ZALO_BRIDGE_PUBLIC_URL` trỏ đúng
domain thật trong `.env` (xem mục 3 — bắt buộc rebuild, không chỉ restart).

---

## 6. Biến môi trường quan trọng

| Biến                          | Mặc định                              | Mô tả                                  |
|-------------------------------|----------------------------------------|------------------------------------------|
| `NEXT_PUBLIC_SUPABASE_URL`    | (bắt buộc)                             | supabase JS client                      |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | (bắt buộc)                            | supabase JS client (anon key)            |
| `SUPABASE_SERVICE_ROLE_KEY`   | (bắt buộc)                             | server-side writes (API routes + bridge) |
| `BRIDGE_API_KEY`              | `change_me`                             | API key cho bridge (đặt đủ mạnh)        |
| `ZALO_BRIDGE_URL`             | `http://zalo-bridge:3001` (compose set) | URL frontend server-side → bridge (nội bộ) |
| `NEXT_PUBLIC_ZALO_BRIDGE_URL` | build-arg từ `ZALO_BRIDGE_PUBLIC_URL`   | URL bridge mà TRÌNH DUYỆT gọi (phải public) |
| `ZALO_BRIDGE_PUBLIC_URL`      | `http://localhost:8080/zalo-bridge`     | URL bridge browser thấy (extension-install/config) |
| `ALLOWED_ORIGINS`             | `http://localhost:3000,...`             | CORS bridge (nhớ thêm domain public khi có) |
| `ROUTER_HTTP_PORT`            | `8080`                                   | Port máy ảo mở ra ngoài                  |

---

## 7. Xử lý lỗi thường gặp

**`docker compose build` fail với "Could not resolve package zca-js"**
→ Đảm bảo `services/zalo-bridge/zca-js/` tồn tại và có `dist/` (đã commit).

**`curl http://localhost:8080/` trả 502**
→ Frontend chưa sẵn sàng. Đợi healthcheck pass (`docker compose ps`), hoặc xem
`docker compose logs frontend`.

**SSE không nhận event / trình duyệt không kết nối được bridge**
→ Kiểm tra `NEXT_PUBLIC_ZALO_BRIDGE_URL` (build-arg) trỏ đúng domain public +
prefix `/zalo-bridge`, không phải hostname nội bộ docker (`zalo-bridge:3001`
chỉ resolve được TRONG mạng compose, trình duyệt không gọi được).

**Volume permission**
→ user non-root (`nextjs:1001`, `bridge:1001`) đã được chown. Nếu host mount
volume từ NFS/CIFS có UID khác, `chown -R 1001:1001` trên host.

---

## 8. Local dev (không dùng Docker)

```bash
# Terminal 1 — bridge
cd services/zalo-bridge
npm install
npm run dev      # port 3001

# Terminal 2 — frontend (đứng ở root)
npm install
npm run dev      # port 3000

# Frontend dev đọc .env.local (KHÔNG phải .env dùng cho Docker) — xem
# .env.local.example.
```
