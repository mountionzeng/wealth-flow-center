begin;
select plan(3);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);

select throws_ok(
  $$update public.cloud_rollout_controls set enabled = true where gate_name = 'write'$$,
  '42501',
  'authenticated clients cannot enable a rollout gate'
);

select throws_ok(
  $$select * from public.cloud_write_snapshot('66666666-6666-4666-8666-666666666666', 0, 1, 1, '{}'::jsonb, 'hash', 'write')$$,
  'P0001',
  'writes fail closed while the server gate is disabled'
);

select is(
  (select status from public.cloud_read_account_state()),
  'empty',
  'disabling writes does not make reads look like an empty identity transition'
);

reset role;
select * from finish();
rollback;
