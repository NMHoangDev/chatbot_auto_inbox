-- ============================================================================
-- 0004_zalo_forward_rules_auto_off.sql
--
-- Supports in-chat "/fwon" / "/fwoff" commands (services/zalo-bridge
-- forwardEngine.js): a rule turned on via /fwon gets a 5-minute (default,
-- ZALO_FORWARD_AUTO_OFF_MS) deadline so forwarding doesn't stay on forever if
-- the user forgets to send /fwoff. NULL means "no scheduled auto-off" — rules
-- enabled via the dashboard toggle stay on indefinitely, exactly as before.
-- ============================================================================

ALTER TABLE public.zalo_forward_rules
  ADD COLUMN IF NOT EXISTS auto_off_at TIMESTAMPTZ;

COMMENT ON COLUMN public.zalo_forward_rules.auto_off_at IS
  'Deadline for /fwon auto-disable. NULL = no scheduled auto-off (e.g. enabled via dashboard).';

-- Re-create to expose auto_off_at to forwardEngine.js's loadRulesByMaster()
-- restart-safety backstop (needs to see the deadline to reap expired rows).
-- auto_off_at MUST be appended LAST — Postgres only allows CREATE OR REPLACE
-- VIEW to add new trailing columns; inserting it earlier shifts the position
-- of target_thread_id/target_thread_name and errors with 42P16 ("cannot
-- change name of view column").
CREATE OR REPLACE VIEW public.v_zalo_forward_rules_active AS
SELECT
  r.id AS rule_id,
  r.account_id,
  r.master_thread_id,
  r.master_thread_name,
  r.name,
  t.target_thread_id,
  t.target_thread_name,
  r.auto_off_at
FROM public.zalo_forward_rules r
JOIN public.zalo_forward_targets t ON t.rule_id = r.id
WHERE r.is_enabled AND t.is_enabled;

GRANT SELECT ON public.v_zalo_forward_rules_active TO anon, authenticated;
