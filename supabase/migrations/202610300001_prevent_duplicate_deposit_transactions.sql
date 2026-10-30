-- Prevent the same blockchain transaction from being linked to multiple deposits.
-- Apply only after reviewing duplicate rows; the current read-only check found none.
create unique index if not exists deposits_payment_reference_lower_uidx
  on public.deposits (lower(payment_reference))
  where payment_reference is not null;
