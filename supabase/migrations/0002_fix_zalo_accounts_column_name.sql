-- Fix: 0001 originally named this column `zalo_id`, but every piece of copied
-- application code (services/zalo-bridge/src/services/accountRegistry.js,
-- sessionManager.js, routes/accounts.js, and app/api/zalo/accounts/route.ts's
-- mirrorToSupabase()) writes/reads it as `zalo_user_id` directly against the
-- base table. That mismatch made every mirror-to-Supabase write silently
-- fail (PostgREST rejects unknown columns, and the mirror call never checks
-- the response), leaving `zalo_accounts` without a row for any account that
-- was connected outside the "create account" UI flow — which then broke
-- `zalo_forward_rules`' foreign key on `account_id`.
--
-- Safe to run even if the column was already renamed (checks first).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'zalo_accounts' AND column_name = 'zalo_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'zalo_accounts' AND column_name = 'zalo_user_id'
  ) THEN
    ALTER TABLE public.zalo_accounts RENAME COLUMN zalo_id TO zalo_user_id;
  END IF;
END $$;

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
