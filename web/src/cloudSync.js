import { cloudContentHash, validateCloudSnapshot } from './cloudData.js';

const clone = value => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const defaultOperationId = () => globalThis.crypto.randomUUID();

export const createCloudSync = ({ repository, remote, createOperationId = defaultOperationId, onStateChange = () => {} }) => {
  if (!repository?.load || !repository?.saveLocalChange || !repository?.confirmCloudWrite || !repository?.quarantine) {
    throw new Error('缺少本地同步资料仓库');
  }
  if (!remote?.write) throw new Error('缺少云端同步接口');
  let current = { status: 'idle', lastSyncedAt: '', conflictId: '', error: '' };
  const update = next => {
    current = { ...current, ...next };
    onStateChange(clone(current));
    return current;
  };

  return {
    state: () => clone(current),
    async queueSnapshot(rawSnapshot, overlay) {
      const snapshot = validateCloudSnapshot(rawSnapshot);
      const local = await repository.load();
      const operation = {
        id: createOperationId(),
        base_revision: local.revision,
        generation: local.generation,
        schema_version: snapshot.schema_version,
        payload_hash: await cloudContentHash(snapshot),
      };
      await repository.saveLocalChange({ snapshot, overlay, operation });
      update({ status: 'pending', conflictId: '', error: '' });
      return operation;
    },
    async flush() {
      const local = await repository.load();
      const operation = local.outbox[0];
      if (!operation) return update({ status: 'synced', error: '' });
      update({ status: 'syncing', error: '' });
      try {
        const result = await remote.write({
          operationId: operation.id,
          expectedRevision: operation.base_revision,
          generation: operation.generation,
          schemaVersion: operation.schema_version,
          snapshot: local.snapshot,
          payloadHash: operation.payload_hash,
          mode: operation.base_revision === 0 ? 'migration' : 'write',
        });
        if (result.status === 'applied' || result.status === 'replayed') {
          await repository.confirmCloudWrite({
            operationId: operation.id,
            revision: Number(result.revision),
            generation: Number(result.generation),
          });
          return update({ status: 'synced', lastSyncedAt: new Date().toISOString(), conflictId: '', error: '' });
        }
        if (result.status === 'conflict') {
          return update({ status: 'conflict', conflictId: String(result.conflict_id || ''), error: '' });
        }
        throw new Error('云端没有确认这次同步');
      } catch (error) {
        if (error?.code === 'stale_generation') {
          await repository.quarantine();
          return update({ status: 'quarantined', error: '这台设备保留的是删除前的资料，已停止自动上传。' });
        }
        return update({ status: 'failed', error: error?.message || '云端同步失败，资料仍保留在本机。' });
      }
    },
  };
};
