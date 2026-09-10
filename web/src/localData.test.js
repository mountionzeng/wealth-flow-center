import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { accountService, createLocalAPI, createDailyBalanceAPI, localDataKeys } from './localData.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class FakeLockManager {
  constructor() { this.calls = []; this.tails = new Map(); }
  request(name, options, callback) {
    this.calls.push({ name, options });
    const previous = this.tails.get(name) || Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    this.tails.set(name, current);
    return current.finally(() => { if (this.tails.get(name) === current) this.tails.delete(name); });
  }
}

test('registers and authenticates a browser-local account', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: 'Jane.Z', displayName: 'Jane', password: 'learn-more-2026' }, storage);

  assert.equal(account.username, 'jane.z');
  assert.equal((await accountService.login({ username: 'JANE.Z', password: 'learn-more-2026' }, storage)).id, account.id);
  await assert.rejects(accountService.login({ username: 'jane.z', password: 'wrong-pass' }, storage), /账号或密码不正确/);
});

test('accepts a simple Chinese name and a short local password', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: '小曾同学', password: '2026' }, storage);

  assert.equal(account.username, '小曾同学');
  assert.equal(account.display_name, '小曾同学');
  assert.equal((await accountService.login({ username: '小曾同学', password: '2026' }, storage)).id, account.id);
});

test('changes the password for the signed-in local account without changing its data', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: 'owner@example.com', password: 'before-2026' }, storage);
  const api = createLocalAPI(account.id, storage);
  await api.addQ({ title: 'Module 1', course_name: 'CS583', task_type: 'course', start: '2026-08-03 10:00', end: '2026-08-03 11:00' });

  await accountService.changePassword(account.id, 'after-2026', storage);

  await assert.rejects(accountService.login({ username: account.username, password: 'before-2026' }, storage), /账号或密码不正确/);
  assert.equal((await accountService.login({ username: account.username, password: 'after-2026' }, storage)).id, account.id);
  assert.equal((await api.state()).data.quests.length, 1);
});

test('keeps the chosen account signed in across browser restarts without storing a password', async () => {
  const storage = new MemoryStorage();
  const legacySession = new MemoryStorage();
  const account = await accountService.register({ username: '常用账户', password: '2026' }, storage);

  accountService.remember(account, storage, legacySession);

  assert.equal(accountService.restore(storage, new MemoryStorage()).id, account.id);
  assert.equal(storage.getItem(localDataKeys.SESSION_KEY), account.id);
  const savedAccount = JSON.parse(storage.getItem(localDataKeys.ACCOUNT_KEY))[0];
  assert.equal(savedAccount.password, undefined);
  assert.notEqual(savedAccount.password_hash, '2026');

  accountService.logout(storage, legacySession);
  assert.equal(accountService.restore(storage, legacySession), null);
});

test('migrates an active tab session into the persistent local session', async () => {
  const storage = new MemoryStorage();
  const legacySession = new MemoryStorage();
  const account = await accountService.register({ username: '旧会话', password: '2026' }, storage);
  legacySession.setItem(localDataKeys.SESSION_KEY, account.id);

  assert.equal(accountService.restore(storage, legacySession).id, account.id);
  assert.equal(storage.getItem(localDataKeys.SESSION_KEY), account.id);
  assert.equal(legacySession.getItem(localDataKeys.SESSION_KEY), null);
});

test('keeps task data isolated between accounts in the same browser', async () => {
  const storage = new MemoryStorage();
  const jane = await accountService.register({ username: 'jane', displayName: 'Jane', password: 'password-jane' }, storage);
  const friend = await accountService.register({ username: 'friend', displayName: 'Friend', password: 'password-friend' }, storage);
  const janeAPI = createLocalAPI(jane.id, storage);
  const friendAPI = createLocalAPI(friend.id, storage);

  await janeAPI.addQ({ title: 'Module 1', course_name: 'CS583', task_type: 'course', start: '2026-08-03 10:00', end: '2026-08-03 11:00' });

  assert.equal((await janeAPI.state()).data.quests.length, 1);
  assert.equal((await friendAPI.state()).data.quests.length, 0);
});

test('serializes account mutations through the same navigator lock', async () => {
  const storage = new MemoryStorage();
  const locks = new FakeLockManager();
  const account = await accountService.register({ username: 'two-tabs', password: '1234' }, storage);
  const quests = createLocalAPI(account.id, storage, locks);
  const daily = createDailyBalanceAPI(account.id, storage, locks);

  await Promise.all([
    quests.addQ({ title: '并发学习', task_type: 'course', start: '2026-08-05 10:00', end: '2026-08-05 10:30' }),
    daily.saveCheckIn({ date: '2026-08-05', sleep: 3, energy: 4, mood: 4, discomfort: '' }),
  ]);

  const saved = JSON.parse(storage.getItem(`${localDataKeys.DATA_PREFIX}${account.id}`));
  assert.equal(saved.quests.length, 1);
  assert.equal(saved.daily_balance.check_ins.length, 1);
  assert.equal(saved.revision, 2);
  assert.equal(locks.calls.length, 2);
  assert.equal(new Set(locks.calls.map(call => call.name)).size, 1);
  assert.equal(locks.calls.every(call => call.options.mode === 'exclusive'), true);
});

test('completes, exports, and imports local account data', async () => {
  const storage = new MemoryStorage();
  const source = await accountService.register({ username: 'source', displayName: 'Source', password: 'password-source' }, storage);
  const target = await accountService.register({ username: 'target', displayName: 'Target', password: 'password-target' }, storage);
  const sourceAPI = createLocalAPI(source.id, storage);
  const targetAPI = createLocalAPI(target.id, storage);

  await sourceAPI.addQ({ title: 'Local-first', course_name: 'Product', task_type: 'practice', start: '2026-08-03 10:00', end: '2026-08-03 11:00' });
  await sourceAPI.complQ(1);
  const sourceState = (await sourceAPI.state()).data;
  assert.equal(sourceState.player.total_done, 1);
  assert.equal(sourceState.player.total_minutes, 60);

  await targetAPI.importData(sourceAPI.exportData());
  const targetState = (await targetAPI.state()).data;
  assert.equal(targetState.quests[0].title, 'Local-first');
  assert.equal(targetState.player.total_done, 1);
});

test('keeps additive knowledge notes and Obsidian links inside the account backup', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: 'obsidian-user', password: '1234' }, storage);
  const api = createLocalAPI(account.id, storage);
  await api.createKnowledgeNote({ title: '系统思考', content: '反馈回路影响行为。' });
  await api.appendKnowledgeAddition(1, {
    source_label: 'Obsidian/系统思考',
    source_text: '延迟让反馈不易察觉。',
    source_link: 'obsidian://open?vault=Vault&file=系统思考',
    addition_markdown: '记录时间尺度，避免忽略延迟。',
    review_cards: [{ question: '为什么记录时间尺度？', answer: '延迟可能掩盖反馈。' }],
  });
  const note = api.knowledgeState().notes[0];
  assert.match(note.content, /^反馈回路影响行为。/);
  assert.equal(note.sources[0].link, 'obsidian://open?vault=Vault&file=系统思考');
  assert.equal(note.review_cards[0].source_link, 'obsidian://open?vault=Vault&file=系统思考');
  const backup = JSON.parse(api.exportData());
  assert.equal(backup.knowledge_base.notes[0].title, '系统思考');
});

test('stores one pending Obsidian task per note and removes it after scheduling', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: 'obsidian-task', password: '1234' }, storage);
  const api = createLocalAPI(account.id, storage);
  const input = {
    source_key: 'vault-1:CS520/Module 10.md', vault_id: 'vault-1', path: 'CS520/Module 10.md',
    course_name: 'CS520', title: 'Module 10', source_link: 'obsidian://open?vault=x&file=y', content_hash: 'hash-1',
  };

  await api.upsertObsidianTaskDraft(input);
  await api.upsertObsidianTaskDraft({ ...input, content_hash: 'hash-2' });
  assert.equal(api.knowledgeState().task_drafts.length, 1);
  assert.equal(api.knowledgeState().task_drafts[0].save_count, 2);

  await api.removeObsidianTaskDraft(input.source_key);
  assert.equal(api.knowledgeState().task_drafts.length, 0);
});

test('creates a confirmed local quest before tracking its Calendar result', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: 'obsidian-calendar', password: '1234' }, storage);
  const api = createLocalAPI(account.id, storage);

  const created = await api.addQ({
    title: 'Module 10', course_name: 'CS520', task_type: 'course',
    start: '2026-09-03 10:00', end: '2026-09-03 11:00', write_calendar: true,
  });
  assert.equal(created.quest.calendar_sync_status, 'pending');

  await api.updateQuestCalendar(created.quest.id, { status: 'done', event_id: 'calendar-event-1', operation_id: 'quest-plan-1' });
  const quest = (await api.state()).data.quests[0];
  assert.equal(quest.calendar_sync_status, 'done');
  assert.equal(quest.calendar_event_id, 'calendar-event-1');
  assert.equal(quest.calendar_operation_id, 'quest-plan-1');
});

test('migrates legacy quests without inventing actual time and freezes completed rewards', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: 'legacy', password: '1234' }, storage);
  storage.setItem(`${localDataKeys.DATA_PREFIX}${account.id}`, JSON.stringify({
    player: { level: 4, xp: 12, wealth: 99, total_done: 1, total_minutes: 35 },
    next_id: 3,
    quests: [
      { id: 1, title: 'todo', status: 'todo', duration_minutes: 40, reward_xp: 32, reward_wealth: 2 },
      { id: 2, title: 'done', status: 'done', duration_minutes: 35, reward_xp: 77, reward_wealth: 8, completed_at: '2026-08-01 10:00' },
    ],
  }));

  const state = (await createLocalAPI(account.id, storage).state()).data;
  const todo = state.quests.find(row => row.id === 1);
  const done = state.quests.find(row => row.id === 2);
  assert.equal(state.schema_version, 2);
  assert.equal(todo.planned_duration_minutes, 40);
  assert.equal(Object.hasOwn(todo, 'actual_duration_minutes'), false);
  assert.equal(done.actual_duration_minutes, 35);
  assert.equal(done.reward_xp, 77);
  assert.equal(done.reward_wealth, 8);
  assert.equal(done.reward_basis, 'legacy_frozen');
});

test('keeps all daily-balance fields isolated by account', async () => {
  const storage = new MemoryStorage();
  const jane = await accountService.register({ username: 'jane2', password: '1234' }, storage);
  const friend = await accountService.register({ username: 'friend2', password: '1234' }, storage);
  const api = createDailyBalanceAPI(jane.id, storage);
  await api.saveCheckIn({ date: '2026-08-05', sleep: 4, energy: 3, mood: 2, discomfort: '肩颈', note: '慢一点' });
  await api.storeAdvice({ date: '2026-08-05', suggestions: [{ id: 's-body', kind: 'body', title: '散步', planned_start: '2026-08-05 18:00', planned_duration_minutes: 20 }] });
  await api.confirmSuggestion('s-body');
  await api.recordCompletion({ source_id: 's-body', actual_duration_minutes: 12, feeling: '舒服', completed_at: '2026-08-05 18:30' });
  await api.saveSpringWind({ profile: { city: '上海' }, report: '# 春风', inputs: { question: '今日如何？' } });
  await api.setConsent('daily_advice', { granted: true, purpose: 'daily_advice', operation: 'text', provider_name: '302.ai', categories: ['body_check_in'], fields_version: 'daily-v1', terms_version: 'v1' });
  await api.setCalendarPreferences({ selected_calendars: ['cal-private'] });

  const janeState = api.state();
  const friendState = createDailyBalanceAPI(friend.id, storage).state();
  assert.equal(janeState.check_ins.length, 1);
  assert.equal(janeState.completions.length, 1);
  assert.equal(janeState.spring_wind.report, '# 春风');
  assert.equal(janeState.consent.purposes.daily_advice.provider_name, '302.ai');
  assert.equal(janeState.consent.purposes.spring_wind_text, null);
  assert.deepEqual(janeState.calendar_preferences.selected_calendars, ['cal-private']);
  assert.deepEqual(friendState.check_ins, []);
  assert.deepEqual(friendState.advice, []);
  assert.deepEqual(friendState.plans, []);
  assert.deepEqual(friendState.completions, []);
  assert.equal(friendState.spring_wind, null);
  assert.deepEqual(friendState.calendar_preferences.selected_calendars, []);
});

test('updates the saved spring-wind profile without erasing the previous report', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: '春风资料', password: '2026' }, storage);
  const api = createDailyBalanceAPI(account.id, storage);
  await api.saveSpringWind({ profile: { bazi: '旧八字', current_city: '旧城市', birth_city: '成都', profile_details: [{ key: 'gender', value: '女', confidence: 'high' }] }, report: { content: '旧报告' } });

  await api.saveSpringWindProfile({ bazi: '新八字', current_city: '上海' });

  assert.deepEqual(api.state().spring_wind, {
    profile: { bazi: '新八字', birth_city: '成都', current_city: '上海', question: '', profile_details: [{ key: 'gender', label: '性别', value: '女', confidence: 'high' }] },
    locations: { birth: null, current: null },
    report: { content: '旧报告' },
  });
});

test('explicitly clears stale normalized city selections', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: '地点清除', password: '2026' }, storage);
  const api = createDailyBalanceAPI(account.id, storage);
  const birth = { id: 'birth-1', name: '成都', query: '成都', provider_version: 'v1' };
  const current = { id: 'current-1', name: '北京', query: '北京', provider_version: 'v1' };

  await api.saveSpringWindLocations({ birth, current });
  await api.saveSpringWindLocations({ birth: null, current });

  assert.equal(api.state().spring_wind.locations.birth, null);
  assert.equal(api.state().spring_wind.locations.current.id, 'current-1');
});

test('portable import is atomic and removes device-local projection and consent state', async () => {
  const storage = new MemoryStorage();
  const source = await accountService.register({ username: 'portable-source', password: '1234' }, storage);
  const target = await accountService.register({ username: 'portable-target', password: '1234' }, storage);
  const sourceDaily = createDailyBalanceAPI(source.id, storage);
  await sourceDaily.saveCheckIn({ date: '2026-08-05', sleep: 3, energy: 3, mood: 3, discomfort: '' });
  await sourceDaily.storeAdvice({ date: '2026-08-05', suggestions: [{ id: 'portable-s', kind: 'learning', title: '阅读', planned_start: '2026-08-05 09:00', planned_duration_minutes: 40 }] });
  await sourceDaily.confirmSuggestion('portable-s');
  await sourceDaily.updateProjection('portable-s', { operation_id: 'op-1', attempt_id: 'try-1', state: 'succeeded', event_id: 'event-secret' });
  await sourceDaily.setCalendarPreferences({ selected_calendars: ['private-cal'] });
  await sourceDaily.setConsent('daily_advice', { granted: true, purpose: 'daily_advice', operation: 'text', provider_name: '302.ai', categories: ['body_check_in'], fields_version: 'daily-v1', terms_version: 'v1' });
  await sourceDaily.setConsent('image_recognition', { granted: true, purpose: 'image_recognition', operation: 'image', provider_name: '302.ai', categories: ['bazi_image'], fields_version: 'image-v1', terms_version: 'v1' });

  const targetAPI = createLocalAPI(target.id, storage);
  await targetAPI.importData(createLocalAPI(source.id, storage).exportData());
  const imported = createDailyBalanceAPI(target.id, storage).state();
  assert.equal(imported.plans[0].suggestion_id, 'portable-s');
  assert.deepEqual(imported.calendar_preferences.selected_calendars, []);
  assert.deepEqual(imported.consent, {
    purposes: { daily_advice: null, spring_wind_text: null, environment: null, image_recognition: null, knowledge_refine: null },
  });
  assert.equal(imported.projections[0].state, 'not_synced');
  assert.equal(imported.projections[0].event_id, null);
  assert.equal(imported.projections[0].attempt_id, null);

  const before = storage.getItem(`${localDataKeys.DATA_PREFIX}${target.id}`);
  await assert.rejects(targetAPI.importData('{bad json'), SyntaxError);
  assert.equal(storage.getItem(`${localDataKeys.DATA_PREFIX}${target.id}`), before);

  const duplicate = JSON.parse(createLocalAPI(source.id, storage).exportData());
  duplicate.daily_balance.advice.push({ ...duplicate.daily_balance.advice[0] });
  await assert.rejects(targetAPI.importData(duplicate), /重复/);
  assert.equal(storage.getItem(`${localDataKeys.DATA_PREFIX}${target.id}`), before);

  const originalSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => { if (key.endsWith(target.id)) throw new Error('QuotaExceededError'); originalSet(key, value); };
  await assert.rejects(targetAPI.importData(createLocalAPI(source.id, storage).exportData()), /QuotaExceeded/);
  storage.setItem = originalSet;
  assert.equal(storage.getItem(`${localDataKeys.DATA_PREFIX}${target.id}`), before);
});

test('new quest completion recalculates rewards and totals from actual duration', async () => {
  const storage = new MemoryStorage();
  const account = await accountService.register({ username: 'actual-reward', password: '1234' }, storage);
  const api = createLocalAPI(account.id, storage);
  await api.addQ({ title: '短时学习', task_type: 'course', start: '2026-08-05 10:00', end: '2026-08-05 10:40' });
  await api.complQ(1, { actual_duration_minutes: 25, feeling: '注意力一般', actual_start: '2026-08-05 10:05', actual_end: '2026-08-05 10:30' });

  const completed = (await api.state()).data;
  assert.equal(completed.quests[0].planned_duration_minutes, 40);
  assert.equal(completed.quests[0].actual_duration_minutes, 25);
  assert.equal(completed.quests[0].feeling, '注意力一般');
  assert.equal(completed.quests[0].variance_minutes, -15);
  assert.equal(completed.quests[0].reward_basis, 'actual');
  assert.equal(completed.quests[0].reward_xp, 20);
  assert.equal(completed.player.total_minutes, 25);

  const target = await accountService.register({ username: 'actual-reward-copy', password: '1234' }, storage);
  await createLocalAPI(target.id, storage).importData(api.exportData());
  const copied = (await createLocalAPI(target.id, storage).state()).data;
  assert.equal(copied.quests[0].reward_xp, 20);
  assert.equal(copied.player.total_minutes, 25);
});
