begin;
select plan(6);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

select is(
  (select status from public.cloud_read_account_state()),
  'empty',
  'a first-time authenticated identity receives an empty state through the RPC'
);

select throws_ok(
  $$insert into public.cloud_owner_generations (owner_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$,
  '42501',
  'authenticated clients cannot write owner-generation rows directly'
);

select throws_ok(
  $$insert into public.cloud_account_states (owner_id, generation, schema_version, revision, snapshot, content_hash) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 1, 1, '{}'::jsonb, 'test')$$,
  '42501',
  'authenticated clients cannot write account snapshots directly'
);

select throws_ok(
  $$select * from public.cloud_account_states$$,
  '42501',
  'authenticated clients cannot read canonical snapshots outside the RPC'
);

select throws_ok(
  $$select public.cloud_rollout_gate_enabled('write')$$,
  '42501',
  'internal rollout controls are not executable by authenticated clients'
);

reset role;
select * from finish();
rollback;
