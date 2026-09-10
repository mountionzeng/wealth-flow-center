begin;
select plan(4);

update public.cloud_rollout_controls
set enabled = true
where gate_name in ('write', 'deletion');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

select is(
  (select status from public.cloud_delete_account_data('44444444-4444-4444-8444-444444444444', 1)),
  'deleted',
  'cloud-data deletion returns a receipt'
);

select is(
  (select generation from public.cloud_read_account_state()),
  2::bigint,
  'deletion advances the generation boundary'
);

select throws_ok(
  $$select * from public.cloud_write_snapshot(
    '55555555-5555-4555-8555-555555555555', 0, 1, 1,
    jsonb_build_object('schema_version', 1, 'player', '{}'::jsonb, 'next_id', 1, 'quests', '[]'::jsonb, 'daily_balance', '{}'::jsonb, 'knowledge_base', '{}'::jsonb),
    encode(extensions.digest(jsonb_build_object('schema_version', 1, 'player', '{}'::jsonb, 'next_id', 1, 'quests', '[]'::jsonb, 'daily_balance', '{}'::jsonb, 'knowledge_base', '{}'::jsonb)::text, 'sha256'), 'hex'),
    'write'
  )$$,
  'P0001',
  'a queue from the deleted generation cannot restore data'
);

select is(
  (select status from public.cloud_delete_account_data('44444444-4444-4444-8444-444444444444', 1)),
  'replayed',
  'repeating a deletion request is safe'
);

reset role;
select * from finish();
rollback;
