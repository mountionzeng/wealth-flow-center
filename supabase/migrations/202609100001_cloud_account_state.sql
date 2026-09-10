create extension if not exists pgcrypto with schema extensions;

create table public.cloud_owner_generations (
  owner_id uuid primary key,
  current_generation bigint not null default 1 check (current_generation >= 1),
  deleted_at timestamptz,
  deletion_receipt uuid,
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.cloud_account_states (
  owner_id uuid primary key references public.cloud_owner_generations(owner_id) on delete cascade,
  generation bigint not null check (generation >= 1),
  schema_version integer not null check (schema_version >= 1),
  revision bigint not null check (revision >= 1),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  content_hash text not null check (char_length(content_hash) = 64),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.cloud_sync_operations (
  owner_id uuid not null references public.cloud_owner_generations(owner_id) on delete cascade,
  operation_id uuid not null,
  generation bigint not null check (generation >= 1),
  payload_hash text not null check (char_length(payload_hash) = 64),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (owner_id, operation_id)
);

create table public.cloud_sync_conflicts (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references public.cloud_owner_generations(owner_id) on delete cascade,
  generation bigint not null check (generation >= 1),
  base_revision bigint not null check (base_revision >= 0),
  cloud_revision bigint not null check (cloud_revision >= 1),
  local_snapshot jsonb not null check (jsonb_typeof(local_snapshot) = 'object'),
  cloud_snapshot jsonb not null check (jsonb_typeof(cloud_snapshot) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  resolved_at timestamptz,
  resolved_with text check (resolved_with in ('local', 'cloud'))
);

create index cloud_sync_conflicts_owner_open_idx
  on public.cloud_sync_conflicts (owner_id, generation, created_at desc)
  where resolved_at is null;

alter table public.cloud_owner_generations enable row level security;
alter table public.cloud_account_states enable row level security;
alter table public.cloud_sync_operations enable row level security;
alter table public.cloud_sync_conflicts enable row level security;

revoke all on table public.cloud_owner_generations from public, anon, authenticated;
revoke all on table public.cloud_account_states from public, anon, authenticated;
revoke all on table public.cloud_sync_operations from public, anon, authenticated;
revoke all on table public.cloud_sync_conflicts from public, anon, authenticated;
