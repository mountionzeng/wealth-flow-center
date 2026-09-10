const STORE_NAME = 'account_state';
const DB_VERSION = 1;

const clone = value => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
});

const transactionResult = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
  transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
});

const validateUserId = value => {
  const userId = String(value || '').trim();
  if (!userId) throw new Error('缺少 Google 用户标识');
  return userId;
};

const validateRecord = raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('账户资料无效');
  if (!Array.isArray(raw.outbox)) throw new Error('outbox 必须是数组');
  const revision = Number(raw.revision ?? 0);
  const generation = Number(raw.generation ?? 1);
  if (!Number.isInteger(revision) || revision < 0 || !Number.isInteger(generation) || generation < 1) {
    throw new Error('云端版本信息无效');
  }
  return {
    snapshot: clone(raw.snapshot ?? null),
    overlay: clone(raw.overlay ?? {}),
    outbox: clone(raw.outbox),
    revision,
    generation,
  };
};

export const createIndexedDbAccountStore = ({ indexedDB = globalThis.indexedDB, dbName = 'berich-cloud-account-v1' } = {}) => {
  if (!indexedDB?.open) throw new Error('当前浏览器不支持 IndexedDB');
  let databasePromise;
  const database = () => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'user_id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开 IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB 正被另一页面占用，请关闭旧页面后重试'));
    });
    return databasePromise;
  };

  return {
    async read(rawUserId) {
      const userId = validateUserId(rawUserId);
      const db = await database();
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const row = await requestResult(transaction.objectStore(STORE_NAME).get(userId));
      await transactionResult(transaction);
      if (!row) return null;
      const { user_id, ...record } = row;
      return validateRecord(record);
    },
    async commit(rawUserId, rawRecord) {
      const userId = validateUserId(rawUserId);
      const record = validateRecord(rawRecord);
      const db = await database();
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ user_id: userId, ...record });
      await transactionResult(transaction);
      return record;
    },
    async clear(rawUserId) {
      const userId = validateUserId(rawUserId);
      const db = await database();
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(userId);
      await transactionResult(transaction);
    },
  };
};
