-- SSHO STORE: referential integrity and transaction-hash uniqueness
-- Applied to production Supabase through the Supabase migration API.
-- Safe to re-run: named foreign keys and indexes are created only if absent.
-- Preflight on 2026-10-30: zero orphans in all five FK targets and zero duplicate
-- hashes in public.payments / hash-shaped public.deposits.payment_reference.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wallets_telegram_user_id_users_fkey' and conrelid = 'public.wallets'::regclass) then
    alter table public.wallets add constraint wallets_telegram_user_id_users_fkey
      foreign key (telegram_user_id) references public.users(telegram_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wallet_transactions_telegram_user_id_users_fkey' and conrelid = 'public.wallet_transactions'::regclass) then
    alter table public.wallet_transactions add constraint wallet_transactions_telegram_user_id_users_fkey
      foreign key (telegram_user_id) references public.users(telegram_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deposits_telegram_user_id_users_fkey' and conrelid = 'public.deposits'::regclass) then
    alter table public.deposits add constraint deposits_telegram_user_id_users_fkey
      foreign key (telegram_user_id) references public.users(telegram_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'binance_gift_card_submissions_telegram_user_id_users_fkey' and conrelid = 'public.binance_gift_card_submissions'::regclass) then
    alter table public.binance_gift_card_submissions add constraint binance_gift_card_submissions_telegram_user_id_users_fkey
      foreign key (telegram_user_id) references public.users(telegram_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'binance_gift_card_submissions_reviewed_by_users_fkey' and conrelid = 'public.binance_gift_card_submissions'::regclass) then
    alter table public.binance_gift_card_submissions add constraint binance_gift_card_submissions_reviewed_by_users_fkey
      foreign key (reviewed_by) references public.users(telegram_id) on update cascade on delete restrict not valid;
  end if;
end $$;

alter table public.wallets validate constraint wallets_telegram_user_id_users_fkey;
alter table public.wallet_transactions validate constraint wallet_transactions_telegram_user_id_users_fkey;
alter table public.deposits validate constraint deposits_telegram_user_id_users_fkey;
alter table public.binance_gift_card_submissions validate constraint binance_gift_card_submissions_telegram_user_id_users_fkey;
alter table public.binance_gift_card_submissions validate constraint binance_gift_card_submissions_reviewed_by_users_fkey;

create unique index if not exists payments_txid_case_insensitive_uidx
  on public.payments (lower(txid));

create unique index if not exists deposits_payment_reference_hash_uidx
  on public.deposits (lower(payment_reference))
  where payment_reference is not null
    and btrim(payment_reference) <> ''
    and lower(payment_reference) ~ '^(0x)?[0-9a-f]{64}$';
