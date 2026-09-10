create or replace function public.cloud_require_authenticated_owner()
returns uuid
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  return v_owner;
end;
$$;

create or replace function public.cloud_json_depth(p_value jsonb)
returns integer
language sql
immutable
set search_path = public
as $$
  with recursive walk(value, depth) as (
    select p_value, 1
    union all
    select child.value, walk.depth + 1
    from walk
    cross join lateral (
      select value from jsonb_array_elements(case when jsonb_typeof(walk.value) = 'array' then walk.value else '[]'::jsonb end)
      union all
      select value from jsonb_each(case when jsonb_typeof(walk.value) = 'object' then walk.value else '{}'::jsonb end)
    ) as child
  )
  select coalesce(max(depth), 0) from walk;
$$;

create or replace function public.cloud_validate_snapshot(p_snapshot jsonb, p_schema_version integer)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  v_allowed_keys constant text[] := array['schema_version', 'player', 'next_id', 'quests', 'daily_balance', 'knowledge_base'];
begin
  if p_schema_version <> 1 then
    raise exception 'unsupported cloud schema version' using errcode = '22023';
  end if;
  if jsonb_typeof(p_snapshot) <> 'object' or coalesce((p_snapshot ->> 'schema_version')::integer, 0) <> p_schema_version then
    raise exception 'cloud snapshot must be a versioned object' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_snapshot) as key where key <> all(v_allowed_keys)) then
    raise exception 'cloud snapshot contains unsupported keys' using errcode = '22023';
  end if;
  if not (p_snapshot ?& array['player', 'next_id', 'quests', 'daily_balance', 'knowledge_base']) then
    raise exception 'cloud snapshot is missing required keys' using errcode = '22023';
  end if;
  if jsonb_typeof(p_snapshot -> 'player') <> 'object'
    or jsonb_typeof(p_snapshot -> 'quests') <> 'array'
    or jsonb_typeof(p_snapshot -> 'daily_balance') <> 'object'
    or jsonb_typeof(p_snapshot -> 'knowledge_base') <> 'object' then
    raise exception 'cloud snapshot has invalid collection types' using errcode = '22023';
  end if;
  if octet_length(p_snapshot::text) > 524288
    or jsonb_array_length(p_snapshot -> 'quests') > 10000
    or public.cloud_json_depth(p_snapshot) > 32 then
    raise exception 'cloud snapshot exceeds resource limits' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_path_query(p_snapshot, '$.** ? (@.type() == "string")') as string_value
    where char_length(string_value #>> '{}') > 10000
  ) then
    raise exception 'cloud snapshot contains an oversized string' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.cloud_read_account_state()
returns table (
  status text,
  generation bigint,
  revision bigint,
  schema_version integer,
  snapshot jsonb,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner uuid := public.cloud_require_authenticated_owner();
begin
  return query
  select
    case when state.owner_id is null then 'empty' else 'ready' end,
    coalesce(owner.current_generation, 1),
    state.revision,
    state.schema_version,
    state.snapshot,
    owner.deleted_at
  from (select v_owner as owner_id) requested
  left join public.cloud_owner_generations owner on owner.owner_id = requested.owner_id
  left join public.cloud_account_states state on state.owner_id = requested.owner_id;
end;
$$;

create or replace function public.cloud_list_sync_conflicts()
returns table (
  id uuid,
  generation bigint,
  base_revision bigint,
  cloud_revision bigint,
  local_snapshot jsonb,
  cloud_snapshot jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select id, generation, base_revision, cloud_revision, local_snapshot, cloud_snapshot, created_at
  from public.cloud_sync_conflicts
  where owner_id = public.cloud_require_authenticated_owner()
    and resolved_at is null
  order by created_at asc;
$$;

create or replace function public.cloud_write_snapshot(
  p_operation_id uuid,
  p_expected_revision bigint,
  p_generation bigint,
  p_schema_version integer,
  p_snapshot jsonb,
  p_payload_hash text,
  p_mode text default 'write'
)
returns table (
  status text,
  revision bigint,
  generation bigint,
  conflict_id uuid,
  snapshot jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner uuid := public.cloud_require_authenticated_owner();
  v_owner_generation public.cloud_owner_generations%rowtype;
  v_state public.cloud_account_states%rowtype;
  v_operation public.cloud_sync_operations%rowtype;
  v_conflict_id uuid;
  v_revision bigint;
  v_result jsonb;
  v_gate text;
begin
  if p_operation_id is null or p_expected_revision < 0 or p_generation < 1 then
    raise exception 'invalid cloud operation precondition' using errcode = '22023';
  end if;
  if p_mode not in ('write', 'migration') then
    raise exception 'unsupported cloud operation mode' using errcode = '22023';
  end if;
  v_gate := case when p_mode = 'migration' then 'migration' else 'write' end;
  if not public.cloud_rollout_gate_enabled(v_gate) then
    raise exception 'cloud % operations are currently disabled', v_gate using errcode = 'P0001';
  end if;
  if p_schema_version < public.cloud_minimum_writable_schema(v_gate) then
    raise exception 'cloud schema version is no longer writable' using errcode = 'P0001';
  end if;
  perform public.cloud_validate_snapshot(p_snapshot, p_schema_version);
  if p_payload_hash <> encode(extensions.digest(p_snapshot::text, 'sha256'), 'hex') then
    raise exception 'cloud payload hash does not match snapshot' using errcode = '22023';
  end if;

  insert into public.cloud_owner_generations (owner_id)
  values (v_owner)
  on conflict (owner_id) do nothing;
  select * into v_owner_generation
  from public.cloud_owner_generations
  where owner_id = v_owner
  for update;

  if v_owner_generation.current_generation <> p_generation then
    raise exception 'stale cloud generation' using errcode = 'P0001';
  end if;

  select * into v_operation
  from public.cloud_sync_operations
  where owner_id = v_owner and operation_id = p_operation_id;
  if found then
    if v_operation.payload_hash <> p_payload_hash then
      raise exception 'operation id was reused with different content' using errcode = '22023';
    end if;
    return query select 'replayed',
      nullif(v_operation.result ->> 'revision', '')::bigint,
      v_owner_generation.current_generation,
      nullif(v_operation.result ->> 'conflict_id', '')::uuid,
      null;
    return;
  end if;

  if v_owner_generation.deleted_at is not null and p_expected_revision <> 0 then
    raise exception 'cloud data was deleted; start from the current empty generation' using errcode = 'P0001';
  end if;

  select * into v_state
  from public.cloud_account_states
  where owner_id = v_owner
  for update;

  if found and v_state.revision <> p_expected_revision then
    if (select count(*) from public.cloud_sync_conflicts where owner_id = v_owner and generation = p_generation and resolved_at is null) >= 20 then
      raise exception 'too many unresolved cloud conflicts' using errcode = '22023';
    end if;
    insert into public.cloud_sync_conflicts (owner_id, generation, base_revision, cloud_revision, local_snapshot, cloud_snapshot)
    values (v_owner, p_generation, p_expected_revision, v_state.revision, p_snapshot, v_state.snapshot)
    returning id into v_conflict_id;
    v_result := jsonb_build_object('status', 'conflict', 'revision', v_state.revision, 'conflict_id', v_conflict_id);
    insert into public.cloud_sync_operations (owner_id, operation_id, generation, payload_hash, result)
    values (v_owner, p_operation_id, p_generation, p_payload_hash, v_result);
    return query select 'conflict', v_state.revision, p_generation, v_conflict_id, v_state.snapshot;
    return;
  end if;

  if not found and p_expected_revision <> 0 then
    raise exception 'cloud state revision does not exist' using errcode = 'P0001';
  end if;

  v_revision := coalesce(v_state.revision, 0) + 1;
  insert into public.cloud_account_states (owner_id, generation, schema_version, revision, snapshot, content_hash)
  values (v_owner, p_generation, p_schema_version, v_revision, p_snapshot, p_payload_hash)
  on conflict (owner_id) do update set
    generation = excluded.generation,
    schema_version = excluded.schema_version,
    revision = excluded.revision,
    snapshot = excluded.snapshot,
    content_hash = excluded.content_hash,
    updated_at = timezone('utc', now());
  update public.cloud_owner_generations
  set deleted_at = null, deletion_receipt = null, updated_at = timezone('utc', now())
  where owner_id = v_owner;
  v_result := jsonb_build_object('status', 'applied', 'revision', v_revision);
  insert into public.cloud_sync_operations (owner_id, operation_id, generation, payload_hash, result)
  values (v_owner, p_operation_id, p_generation, p_payload_hash, v_result);
  return query select 'applied', v_revision, p_generation, null::uuid, p_snapshot;
end;
$$;

create or replace function public.cloud_resolve_sync_conflict(
  p_conflict_id uuid,
  p_operation_id uuid,
  p_expected_revision bigint,
  p_choice text
)
returns table (
  status text,
  revision bigint,
  generation bigint,
  conflict_id uuid,
  snapshot jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner uuid := public.cloud_require_authenticated_owner();
  v_conflict public.cloud_sync_conflicts%rowtype;
  v_snapshot jsonb;
begin
  if p_choice not in ('local', 'cloud') then
    raise exception 'conflict choice must be local or cloud' using errcode = '22023';
  end if;
  select * into v_conflict
  from public.cloud_sync_conflicts
  where id = p_conflict_id and owner_id = v_owner and resolved_at is null
  for update;
  if not found then
    raise exception 'cloud conflict is unavailable' using errcode = 'P0001';
  end if;
  v_snapshot := case when p_choice = 'local' then v_conflict.local_snapshot else v_conflict.cloud_snapshot end;
  return query
  select * from public.cloud_write_snapshot(
    p_operation_id,
    p_expected_revision,
    v_conflict.generation,
    coalesce((v_snapshot ->> 'schema_version')::integer, 1),
    v_snapshot,
    encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex'),
    'write'
  );
  update public.cloud_sync_conflicts
  set resolved_at = timezone('utc', now()), resolved_with = p_choice
  where id = p_conflict_id and resolved_at is null;
end;
$$;

revoke all on function public.cloud_require_authenticated_owner() from public, anon, authenticated;
revoke all on function public.cloud_json_depth(jsonb) from public, anon, authenticated;
revoke all on function public.cloud_validate_snapshot(jsonb, integer) from public, anon, authenticated;
revoke all on function public.cloud_read_account_state() from public, anon;
revoke all on function public.cloud_list_sync_conflicts() from public, anon;
revoke all on function public.cloud_write_snapshot(uuid, bigint, bigint, integer, jsonb, text, text) from public, anon;
revoke all on function public.cloud_resolve_sync_conflict(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.cloud_read_account_state() to authenticated;
grant execute on function public.cloud_list_sync_conflicts() to authenticated;
grant execute on function public.cloud_write_snapshot(uuid, bigint, bigint, integer, jsonb, text, text) to authenticated;
grant execute on function public.cloud_resolve_sync_conflict(uuid, uuid, bigint, text) to authenticated;
