create table public.cloud_rollout_controls (
  gate_name text primary key check (gate_name in ('write', 'migration', 'deletion')),
  enabled boolean not null default false,
  minimum_writable_schema integer not null default 1 check (minimum_writable_schema >= 1),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.cloud_rollout_controls (gate_name, enabled, minimum_writable_schema)
values ('write', false, 1), ('migration', false, 1), ('deletion', false, 1);

alter table public.cloud_rollout_controls enable row level security;
revoke all on table public.cloud_rollout_controls from public, anon, authenticated;

create or replace function public.cloud_rollout_gate_enabled(p_gate_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  return coalesce((
    select enabled
    from public.cloud_rollout_controls
    where gate_name = p_gate_name
  ), false);
end;
$$;

revoke all on function public.cloud_rollout_gate_enabled(text) from public, anon, authenticated;

create or replace function public.cloud_minimum_writable_schema(p_gate_name text)
returns integer
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  return coalesce((
    select minimum_writable_schema
    from public.cloud_rollout_controls
    where gate_name = p_gate_name
  ), 2147483647);
end;
$$;

revoke all on function public.cloud_minimum_writable_schema(text) from public, anon, authenticated;
