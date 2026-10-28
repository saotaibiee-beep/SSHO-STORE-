
-- SSHO STORE: migration for the existing database
begin;

create extension if not exists pgcrypto;

create table if not exists public.users (
  telegram_id bigint primary key check (telegram_id > 0),
  first_name text,
  last_name text,
  username text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.admin_roles (
  telegram_id bigint primary key
    references public.users(telegram_id) on delete restrict,
  role text not null
    check (role in ('owner', 'admin', 'support', 'fulfillment')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by bigint references public.users(telegram_id)
);

create unique index if not exists orders_telegram_id_idempotency_key_uidx
  on public.orders(telegram_id, idempotency_key);

create unique index if not exists payments_network_txid_uidx
  on public.payments(network, txid);

create unique index if not exists deliveries_order_id_uidx
  on public.deliveries(order_id);

alter table public.users enable row level security;
alter table public.admin_roles enable row level security;

create or replace function public.create_store_order(
  p_telegram_id bigint,
  p_product_id uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products%rowtype;
  v_order public.orders%rowtype;
  v_existing public.orders%rowtype;
begin
  if p_telegram_id is null or p_telegram_id <= 0
     or p_idempotency_key is null
     or length(p_idempotency_key) < 16
     or length(p_idempotency_key) > 100 then
    raise exception 'invalid_order_request';
  end if;

  insert into public.users(telegram_id)
  values (p_telegram_id)
  on conflict (telegram_id) do nothing;

  select * into v_existing
  from public.orders
  where telegram_id = p_telegram_id
    and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'duplicate', true,
      'order_number', v_existing.order_number
    );
  end if;

  select * into v_product
  from public.products
  where id = p_product_id
  for update;

  if not found
     or not v_product.active
     or not v_product.available
     or (v_product.stock_count is not null
         and v_product.stock_count < 1) then
    raise exception 'product_unavailable';
  end if;

  if v_product.stock_count is not null then
    update public.products
    set stock_count = stock_count - 1,
        updated_at = now()
    where id = v_product.id
      and stock_count > 0;

    if not found then
      raise exception 'product_unavailable';
    end if;
  end if;

  insert into public.orders (
    telegram_id,
    product_id,
    product_name,
    unit_price,
    currency,
    status,
    idempotency_key
  )
  values (
    p_telegram_id,
    v_product.id,
    v_product.name,
    v_product.price,
    v_product.currency,
    'awaiting_payment',
    p_idempotency_key
  )
  returning * into v_order;

  insert into public.deliveries(order_id, status)
  values (v_order.id, 'not_started');

  return jsonb_build_object(
    'duplicate', false,
    'order_number', v_order.order_number
  );
end;
$$;

revoke all on function public.create_store_order(bigint, uuid, text)
  from public, anon, authenticated;

grant execute on function public.create_store_order(bigint, uuid, text)
  to service_role;

commit;
