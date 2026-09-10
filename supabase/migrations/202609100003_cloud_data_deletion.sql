create table public.cloud_deletion_operations (
  owner_id uuid not null references public.cloud_owner_generations(owner_id) on delete cascade,
  operation_id uuid not null,
  deleted_generation bigint not null check (deleted_generation >= 1),
  next_generation bigint not null check (next_generation > deleted_generation),
  receipt uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (owner_id, operation_id)
);

alter table public.cloud_deletion_operations enable row level security;
revoke all on table public.cloud_deletion_operations from public, anon, authenticated;

create or replace function public.cloud_delete_account_data(
  p_operation_id uuid,
  p_expected_generation bigint
)
returns table (
  status text,
  generation bigint,
  receipt uuid
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner uuid := public.cloud_require_authenticated_owner();
  v_owner_generation public.cloud_owner_generations%rowtype;
  v_previous public.cloud_deletion_operations%rowtype;
  v_receipt uuid := extensions.gen_random_uuid();
begin
  if p_operation_id is null or p_expected_generation < 1 then
    raise exception 'invalid cloud deletion precondition' using errcode = '22023';
  end if;
  if not public.cloud_rollout_gate_enabled('deletion') then
    raise exception 'cloud deletion is currently disabled' using errcode = 'P0001';
  end if;
  select * into v_previous
  from public.cloud_deletion_operations
  where owner_id = v_owner and operation_id = p_operation_id;
  if found then
    if v_previous.deleted_generation <> p_expected_generation then
      raise exception 'deletion operation id was reused with a different generation' using errcode = '22023';
    end if;
    return query select 'replayed', v_previous.next_generation, v_previous.receipt;
    return;
  end if;

  insert into public.cloud_owner_generations (owner_id)
  values (v_owner)
  on conflict (owner_id) do nothing;
  select * into v_owner_generation
  from public.cloud_owner_generations
  where owner_id = v_owner
  for update;
  if v_owner_generation.current_generation <> p_expected_generation then
    raise exception 'stale cloud generation' using errcode = 'P0001';
  end if;

  delete from public.cloud_account_states where owner_id = v_owner;
  delete from public.cloud_sync_conflicts where owner_id = v_owner;
  delete from public.cloud_sync_operations where owner_id = v_owner;
  update public.cloud_owner_generations
  set current_generation = current_generation + 1,
    deleted_at = timezone('utc', now()),
    deletion_receipt = v_receipt,
    updated_at = timezone('utc', now())
  where owner_id = v_owner;
  insert into public.cloud_deletion_operations (owner_id, operation_id, deleted_generation, next_generation, receipt)
  values (v_owner, p_operation_id, p_expected_generation, p_expected_generation + 1, v_receipt);
  return query select 'deleted', p_expected_generation + 1, v_receipt;
end;
$$;

revoke all on function public.cloud_delete_account_data(uuid, bigint) from public, anon;
grant execute on function public.cloud_delete_account_data(uuid, bigint) to authenticated;
