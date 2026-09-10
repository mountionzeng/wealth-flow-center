begin;
select plan(7);

update public.cloud_rollout_controls
set enabled = true
where gate_name in ('migration', 'write');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

with candidate as (
  select jsonb_build_object(
    'schema_version', 1,
    'player', jsonb_build_object('level', 1),
    'next_id', 1,
    'quests', '[]'::jsonb,
    'daily_balance', '{}'::jsonb,
    'knowledge_base', '{}'::jsonb
  ) as snapshot
)
select is(
  (select status from public.cloud_write_snapshot(
    '11111111-1111-4111-8111-111111111111', 0, 1, 1, snapshot,
    encode(extensions.digest(snapshot::text, 'sha256'), 'hex'), 'migration'
  ) from candidate),
  'applied',
  'the first migration initializes revision one'
);

with candidate as (
  select jsonb_build_object(
    'schema_version', 1,
    'player', jsonb_build_object('level', 2),
    'next_id', 1,
    'quests', '[]'::jsonb,
    'daily_balance', '{}'::jsonb,
    'knowledge_base', '{}'::jsonb
  ) as snapshot
)
select is(
  (select status from public.cloud_write_snapshot(
    '22222222-2222-4222-8222-222222222222', 1, 1, 1, snapshot,
    encode(extensions.digest(snapshot::text, 'sha256'), 'hex'), 'write'
  ) from candidate),
  'applied',
  'a matching revision applies exactly once'
);

with candidate as (
  select jsonb_build_object(
    'schema_version', 1,
    'player', jsonb_build_object('level', 3),
    'next_id', 1,
    'quests', '[]'::jsonb,
    'daily_balance', '{}'::jsonb,
    'knowledge_base', '{}'::jsonb
  ) as snapshot
)
select is(
  (select status from public.cloud_write_snapshot(
    '33333333-3333-4333-8333-333333333333', 1, 1, 1, snapshot,
    encode(extensions.digest(snapshot::text, 'sha256'), 'hex'), 'write'
  ) from candidate),
  'conflict',
  'a stale revision creates a preserved conflict instead of overwriting'
);

select is(
  (select count(*)::integer from public.cloud_list_sync_conflicts()),
  1,
  'the stale candidate is persisted for later resolution'
);

with candidate as (
  select jsonb_build_object(
    'schema_version', 1,
    'player', jsonb_build_object('level', 2),
    'next_id', 1,
    'quests', '[]'::jsonb,
    'daily_balance', '{}'::jsonb,
    'knowledge_base', '{}'::jsonb
  ) as snapshot
)
select is(
  (select status from public.cloud_write_snapshot(
    '22222222-2222-4222-8222-222222222222', 1, 1, 1, snapshot,
    encode(extensions.digest(snapshot::text, 'sha256'), 'hex'), 'write'
  ) from candidate),
  'replayed',
  'repeating an operation returns the original result'
);

select throws_ok(
  $$select * from public.cloud_write_snapshot(
    '22222222-2222-4222-8222-222222222222', 2, 1, 1,
    jsonb_build_object('schema_version', 1, 'player', jsonb_build_object('level', 99), 'next_id', 1, 'quests', '[]'::jsonb, 'daily_balance', '{}'::jsonb, 'knowledge_base', '{}'::jsonb),
    encode(extensions.digest(jsonb_build_object('schema_version', 1, 'player', jsonb_build_object('level', 99), 'next_id', 1, 'quests', '[]'::jsonb, 'daily_balance', '{}'::jsonb, 'knowledge_base', '{}'::jsonb)::text, 'sha256'), 'hex'),
    'write'
  )$$,
  '22023',
  'reusing an operation id with different content is rejected'
);

reset role;
select * from finish();
rollback;
