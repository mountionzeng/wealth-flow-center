const clone = value => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const emptyState = () => ({ snapshot: null, overlay: {}, outbox: [], revision: 0, generation: 1 });
const operationId = operation => String(operation?.id || '').trim();

export const createGoogleAccountRepository = ({ userId, store }) => {
  const owner = String(userId || '').trim();
  if (!owner) throw new Error('缺少 Google 用户标识');
  if (!store?.read || !store?.commit) throw new Error('缺少 Google 资料存储');
  const load = async () => (await store.read(owner)) || emptyState();

  return {
    load,
    async saveLocalChange({ snapshot, overlay, operation }) {
      const id = operationId(operation);
      if (!id) throw new Error('待同步操作缺少 ID');
      const current = await load();
      const next = {
        ...current,
        snapshot: clone(snapshot),
        overlay: clone(overlay || {}),
        outbox: [{ ...clone(operation), id }],
      };
      return store.commit(owner, next);
    },
    async replaceFromCloud({ snapshot, overlay, revision, generation }) {
      const current = await load();
      if (current.outbox.length) throw new Error('仍有待同步修改，不能直接覆盖本机资料');
      return store.commit(owner, {
        ...current,
        snapshot: clone(snapshot),
        overlay: clone(overlay || {}),
        revision: Number(revision),
        generation: Number(generation),
      });
    },
    async confirmCloudWrite({ operationId: confirmedId, revision, generation }) {
      const current = await load();
      if (!current.outbox.some(operation => operation.id === confirmedId)) throw new Error('找不到对应的待同步操作');
      return store.commit(owner, {
        ...current,
        outbox: current.outbox.filter(operation => operation.id !== confirmedId),
        revision: Number(revision),
        generation: Number(generation),
      });
    },
    async quarantine() {
      const current = await load();
      return store.commit(owner, { ...current, outbox: [] });
    },
    clear: () => store.clear(owner),
  };
};
