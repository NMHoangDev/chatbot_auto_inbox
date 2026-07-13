# Zalo Forward Demo

Standalone demo of the "Zalo messaging + auto-forward" feature, extracted from
`InvoiceFlowManager` into its own Next.js project. Two processes, one Supabase
project:

1. **Next.js app** (this folder, port **3000**) — UI: inbox (`/thong-bao-zalo`),
   account management (`/zalo/accounts`), auto-forward rules
   (`/zalo/forward-rules`). Reads/writes Supabase directly via `app/api/zalo/*`.
2. **`services/zalo-bridge`** (Express + `zca-js`, port **3001**) — logs into a
   real personal Zalo account, exposes REST + SSE, and writes messages/
   conversations straight into Supabase (independent of whether the Next.js
   tab is open).

Chatwoot integration from the source project has been stubbed out (see
`services/zalo-bridge/src/services/chatwootService.js`) — not used here.
Staff password login has been intentionally left out; every request runs as
an implicit system admin (`lib/zalo/auth.ts#getCurrentStaff` fallback).

## Setup

1. **Supabase project.** Create one (or use an existing empty one), then copy
   `.env.local.example` to `.env.local` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`

2. **Run the migration.** Open the Supabase SQL editor and run
   `supabase/migrations/0001_zalo_forwarding_init.sql` once. This creates
   every table the app needs from scratch (staff, zalo_accounts,
   zalo_messages, zalo_conversations_ui, forward rules/targets/logs) and
   seeds one admin row.

3. **Install dependencies** (two separate `package.json`s):
   ```
   npm install
   cd services/zalo-bridge && npm install && cd ../..
   ```

4. **Start the bridge** (from `services/zalo-bridge`):
   ```
   npm run dev
   ```
   It reads the root `.env.local` automatically. Check `http://localhost:3001/health`.

5. **Start the Next.js app** (from the repo root):
   ```
   npm run dev
   ```
   Open `http://localhost:3000`.

## Connecting a Zalo account

1. Go to `/zalo/accounts`, click "Thêm tài khoản" to register a new
   `account_id` (any short slug, e.g. `shop-owner`).
2. Scan the QR code either at the bridge's own page
   (`http://localhost:3001/connect`) or via the Chrome extension in
   `extensions/extension-login-zalo` (`chrome://extensions` → enable
   *Developer mode* → *Load unpacked* → select that folder → open Zalo Web,
   log in, the extension imports the session automatically).
3. Once connected, the bridge automatically catches up on recent
   conversations and persists them to `zalo_conversations_ui` — no need to
   open the chat page for groups to show up.

## Configuring auto-forward

1. Go to `/zalo/forward-rules`.
2. Click "Tạo luật mới", pick one **master group** and one or more **target
   groups**, save.
3. Send a message into the master group from your phone. Within a few
   seconds it should be forwarded to every target group (text is forwarded
   immediately; images are batched ~1.2s to preserve albums; there's a ~10s
   delay between successive targets/rules to stay under Zalo's rate limits).
4. Expand "Log" under a rule to see the forward history / errors per target.

## Notes

- `services/zalo-bridge/data/` holds session credentials once you log in —
  it's gitignored; don't commit it.
- `BRIDGE_API_KEY` in `.env.local` is optional — set the same value in both
  the Next.js env and leave it in the bridge's own env to require an API key
  on non-public bridge routes.
- The forward engine, session listener, and Supabase sync
  (`services/zalo-bridge/src/services/{forwardEngine,sessionManager,
  supabaseSync}.js`) are copied unmodified from the source project.
