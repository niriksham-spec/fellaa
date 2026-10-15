create table if not exists public.shared_state (
  id text primary key check (id = 'global'),
  state jsonb,
  revision bigint not null default 0
);

alter table public.shared_state enable row level security;
