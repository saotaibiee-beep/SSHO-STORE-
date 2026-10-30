-- Atomic review for Binance gift-card submissions.
-- Approval/rejection updates the submission and its linked deposit together,
-- and records an admin audit event. It intentionally does not credit a balance:
-- the current schema has no wallet balance or ledger table.
create or replace function public.review_binance_gift_card_submission(
  p_submission_id bigint,
  p_status text,
  p_admin_note text,
  p_reviewed_by bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission public.binance_gift_card_submissions%rowtype;
  v_deposit public.deposits%rowtype;
begin
  if p_status not in ('approved', 'rejected', 'pending_review') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select * into v_submission
  from public.binance_gift_card_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'submission_not_found' using errcode = 'P0002';
  end if;

  if v_submission.status = p_status then
    return jsonb_build_object('ok', true, 'idempotent', true, 'status', v_submission.status);
  end if;

  if v_submission.status <> 'pending_review' or p_status = 'pending_review' then
    raise exception 'submission_already_reviewed' using errcode = '40001';
  end if;

  select * into v_deposit
  from public.deposits
  where id = v_submission.deposit_id
    and telegram_user_id = v_submission.telegram_user_id
    and method = 'Binance Gift Card'
  for update;

  if not found then
    raise exception 'linked_deposit_not_found' using errcode = 'P0002';
  end if;

  if v_deposit.status not in ('awaiting_payment', 'pending_verification', 'pending_review') then
    raise exception 'linked_deposit_not_reviewable' using errcode = '40001';
  end if;

  update public.binance_gift_card_submissions
  set status = p_status,
      admin_note = left(coalesce(p_admin_note, ''), 1000),
      reviewed_by = p_reviewed_by,
      reviewed_at = now(),
      updated_at = now()
  where id = p_submission_id;

  update public.deposits
  set status = p_status, updated_at = now()
  where id = v_submission.deposit_id
    and telegram_user_id = v_submission.telegram_user_id;

  insert into public.admin_audit_log(actor_telegram_id, action, entity_type, entity_id, details)
  values (
    p_reviewed_by,
    case when p_status = 'approved' then 'gift_card_approved' else 'gift_card_rejected' end,
    'binance_gift_card_submission',
    p_submission_id::text,
    jsonb_build_object('deposit_id', v_submission.deposit_id, 'previous_status', v_submission.status, 'new_status', p_status)
  );

  return jsonb_build_object('ok', true, 'idempotent', false, 'status', p_status,
    'deposit_id', v_submission.deposit_id, 'balance_credited', false);
end;
$$;

revoke all on function public.review_binance_gift_card_submission(bigint, text, text, bigint) from public, anon, authenticated;
grant execute on function public.review_binance_gift_card_submission(bigint, text, text, bigint) to service_role;
