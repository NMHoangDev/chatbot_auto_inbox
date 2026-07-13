-- ============================================================================
-- 0001_zalo_forwarding_init.sql
--
-- Consolidated, from-scratch schema for the Zalo messaging + auto-forward
-- demo (ported out of InvoiceFlowManager's services/zalo-bridge + Next.js
-- API routes — see ZALO_FEATURE_REFERENCE.md in that repo for the full code
-- map). Unlike the source repo's incremental migrations, this file creates
-- every table from scratch: the source repo's `zalo_accounts`/`zalo_messages`
-- tables predate its migrations folder (no CREATE TABLE for them exists
-- there), so a fresh Supabase project needs one full definition instead of a
-- chain of ALTER TABLE statements assuming pre-existing tables.
--
-- Convention (matches the source repo):
--   - account_id / thread_id are TEXT (bridge/Zalo raw ids, not UUID)
--   - RLS is ON everywhere but permissive ("USING (true)") — real
--     authorization happens in the Next.js API layer (lib/zalo/auth.ts),
--     not in Postgres RLS. Do not treat these tables as safe for a
--     browser-exposed anon key in a multi-tenant deployment.
--   - Run this once in the Supabase SQL editor (or `psql $DATABASE_URL -f`)
--     before starting services/zalo-bridge or the Next.js app.
-- ============================================================================

-- ── 0. Helper: updated_at trigger ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 1. staff ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  password_hash TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_role_active ON public.staff(role, is_active);

DROP TRIGGER IF EXISTS trg_staff_updated ON public.staff;
CREATE TRIGGER trg_staff_updated
  BEFORE UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_staff" ON public.staff;
CREATE POLICY "anon_all_staff" ON public.staff FOR ALL USING (true) WITH CHECK (true);

-- Seed 1 admin so getCurrentStaff()'s no-cookie fallback (lib/zalo/auth.ts)
-- always resolves to a real admin row instead of a null id.
INSERT INTO public.staff (email, full_name, role, is_active)
  SELECT 'admin@local', 'System Admin', 'admin', TRUE
  WHERE NOT EXISTS (SELECT 1 FROM public.staff);

-- ── 2. zalo_accounts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.zalo_accounts (
  account_id TEXT PRIMARY KEY,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  avatar_url TEXT,
  zalo_user_id TEXT,
  zalo_display_name TEXT,
  owner_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  phone TEXT,
  last_seen_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zalo_accounts_owner ON public.zalo_accounts(owner_staff_id);
CREATE INDEX IF NOT EXISTS idx_zalo_accounts_status ON public.zalo_accounts(status);

DROP TRIGGER IF EXISTS trg_zalo_accounts_updated ON public.zalo_accounts;
CREATE TRIGGER trg_zalo_accounts_updated
  BEFORE UPDATE ON public.zalo_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.zalo_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_zalo_accounts" ON public.zalo_accounts;
CREATE POLICY "anon_all_zalo_accounts" ON public.zalo_accounts FOR ALL USING (true) WITH CHECK (true);

-- ── 3. staff_zalo_assignments — RBAC staff <-> account ────────────────────
CREATE TABLE IF NOT EXISTS public.staff_zalo_assignments (
  staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES public.zalo_accounts(account_id) ON DELETE CASCADE,
  can_view BOOLEAN NOT NULL DEFAULT TRUE,
  can_send BOOLEAN NOT NULL DEFAULT TRUE,
  can_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (staff_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_assignments_account ON public.staff_zalo_assignments(account_id);

ALTER TABLE public.staff_zalo_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_staff_assignments" ON public.staff_zalo_assignments;
CREATE POLICY "anon_all_staff_assignments" ON public.staff_zalo_assignments FOR ALL USING (true) WITH CHECK (true);

-- Auto-assign admin <-> any account they own (view/send/broadcast all true).
CREATE OR REPLACE FUNCTION public.zalo_accounts_assign_admin()
RETURNS TRIGGER AS $$
DECLARE
  v_staff_role TEXT;
BEGIN
  IF NEW.owner_staff_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT role INTO v_staff_role FROM public.staff WHERE id = NEW.owner_staff_id;
  IF v_staff_role = 'admin' THEN
    INSERT INTO public.staff_zalo_assignments (staff_id, account_id, can_view, can_send, can_broadcast)
      VALUES (NEW.owner_staff_id, NEW.account_id, TRUE, TRUE, TRUE)
      ON CONFLICT (staff_id, account_id)
      DO UPDATE SET can_view = TRUE, can_send = TRUE, can_broadcast = TRUE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_zalo_accounts_assign_admin ON public.zalo_accounts;
CREATE TRIGGER trg_zalo_accounts_assign_admin
  AFTER INSERT OR UPDATE OF owner_staff_id ON public.zalo_accounts
  FOR EACH ROW EXECUTE FUNCTION public.zalo_accounts_assign_admin();

-- ── 4. zalo_messages ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.zalo_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,               -- account_id (backward-compat naming from source)
  account_id TEXT NOT NULL,
  group_id TEXT,                       -- = thread_id, kept for backward-compat
  thread_id TEXT NOT NULL,
  thread_type TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'group'
  source_message_id TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  content TEXT,
  ts BIGINT,                           -- epoch ms, used for sort
  "timestamp" TIMESTAMPTZ,
  type TEXT DEFAULT 'webchat',
  is_sent BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  image_urls JSONB DEFAULT '[]'::jsonb,
  attachments JSONB,
  reply_to_id TEXT,
  time_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_zalo_messages_ts ON public.zalo_messages(account_id, thread_id, ts ASC);

ALTER TABLE public.zalo_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_zalo_msgs" ON public.zalo_messages;
CREATE POLICY "anon_all_zalo_msgs" ON public.zalo_messages FOR ALL USING (true) WITH CHECK (true);

-- ── 5. zalo_conversations_ui — UI thread-list cache ───────────────────────
CREATE TABLE IF NOT EXISTS public.zalo_conversations_ui (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT 'shop-owner',
  thread_id TEXT NOT NULL,
  thread_type TEXT NOT NULL DEFAULT 'user',
  conversation_id TEXT NOT NULL,        -- = thread_id (no u:/g: prefix)
  conversation_name TEXT,
  avatar_url TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_ts BIGINT,
  latest_message_at TIMESTAMPTZ,
  latest_content TEXT,
  latest_sender_id TEXT,
  latest_is_self BOOLEAN NOT NULL DEFAULT FALSE,
  message_count INTEGER NOT NULL DEFAULT 0,
  has_messages BOOLEAN NOT NULL DEFAULT FALSE,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_zalo_conv_ui_account ON public.zalo_conversations_ui(account_id);
CREATE INDEX IF NOT EXISTS idx_zalo_conv_ui_last_ts
  ON public.zalo_conversations_ui(account_id, last_message_ts DESC NULLS LAST);

DROP TRIGGER IF EXISTS trg_zalo_conv_ui_updated ON public.zalo_conversations_ui;
CREATE TRIGGER trg_zalo_conv_ui_updated
  BEFORE UPDATE ON public.zalo_conversations_ui
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.zalo_conversations_ui ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_zalo_conv_ui" ON public.zalo_conversations_ui;
CREATE POLICY "anon_all_zalo_conv_ui" ON public.zalo_conversations_ui FOR ALL USING (true) WITH CHECK (true);

-- ── 6. Forward rules: master group -> target groups ───────────────────────
CREATE TABLE IF NOT EXISTS public.zalo_forward_rules (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES public.zalo_accounts(account_id) ON DELETE CASCADE,
  name TEXT,
  master_thread_id TEXT NOT NULL,
  master_thread_name TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, master_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_zalo_forward_rules_account ON public.zalo_forward_rules(account_id);
CREATE INDEX IF NOT EXISTS idx_zalo_forward_rules_master_enabled
  ON public.zalo_forward_rules(account_id, master_thread_id) WHERE is_enabled;

DROP TRIGGER IF EXISTS trg_zalo_forward_rules_updated ON public.zalo_forward_rules;
CREATE TRIGGER trg_zalo_forward_rules_updated
  BEFORE UPDATE ON public.zalo_forward_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.zalo_forward_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_zalo_forward_rules" ON public.zalo_forward_rules;
CREATE POLICY "anon_all_zalo_forward_rules" ON public.zalo_forward_rules FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.zalo_forward_targets (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT NOT NULL REFERENCES public.zalo_forward_rules(id) ON DELETE CASCADE,
  target_thread_id TEXT NOT NULL,
  target_thread_name TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_id, target_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_zalo_forward_targets_rule ON public.zalo_forward_targets(rule_id);

ALTER TABLE public.zalo_forward_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_zalo_forward_targets" ON public.zalo_forward_targets;
CREATE POLICY "anon_all_zalo_forward_targets" ON public.zalo_forward_targets FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.zalo_forward_logs (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT REFERENCES public.zalo_forward_rules(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  source_thread_id TEXT NOT NULL,
  source_msg_id TEXT,
  target_thread_id TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zalo_forward_logs_rule ON public.zalo_forward_logs(rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zalo_forward_logs_account ON public.zalo_forward_logs(account_id, created_at DESC);

ALTER TABLE public.zalo_forward_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_zalo_forward_logs" ON public.zalo_forward_logs;
CREATE POLICY "anon_all_zalo_forward_logs" ON public.zalo_forward_logs FOR ALL USING (true) WITH CHECK (true);

-- View forwardEngine.js reads (cached 8s) to know master -> targets per account.
CREATE OR REPLACE VIEW public.v_zalo_forward_rules_active AS
SELECT
  r.id AS rule_id,
  r.account_id,
  r.master_thread_id,
  r.master_thread_name,
  r.name,
  t.target_thread_id,
  t.target_thread_name
FROM public.zalo_forward_rules r
JOIN public.zalo_forward_targets t ON t.rule_id = r.id
WHERE r.is_enabled AND t.is_enabled;

GRANT SELECT ON public.v_zalo_forward_rules_active TO anon, authenticated;

-- ── 7. v_staff_zalo_accounts — flattened view for account/staff dashboards ─
CREATE OR REPLACE VIEW public.v_staff_zalo_accounts AS
SELECT
  a.account_id,
  a.display_name,
  a.phone,
  a.zalo_user_id,
  a.zalo_display_name,
  a.status,
  a.last_error,
  a.last_seen_at,
  a.owner_staff_id,
  s.email AS owner_email,
  s.full_name AS owner_full_name,
  s.role AS owner_role,
  asm.staff_id,
  asm.can_view,
  asm.can_send,
  asm.can_broadcast
FROM public.zalo_accounts a
LEFT JOIN public.staff s ON s.id = a.owner_staff_id
LEFT JOIN public.staff_zalo_assignments asm ON asm.account_id = a.account_id;

GRANT SELECT ON public.v_staff_zalo_accounts TO anon, authenticated;
