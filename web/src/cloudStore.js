const rpcResult = async (client, name, args) => {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const failure = new Error(error.message || '云端操作失败');
    failure.code = /stale cloud generation/i.test(error.message || '') ? 'stale_generation' : error.code || 'cloud_error';
    throw failure;
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result || typeof result !== 'object') throw new Error('云端返回了无效结果');
  return result;
};

export const createCloudStore = client => {
  if (!client?.rpc) throw new Error('缺少 Supabase 云端客户端');
  return {
    read: () => rpcResult(client, 'cloud_read_account_state'),
    write: ({ operationId, expectedRevision, generation, schemaVersion = 1, snapshot, payloadHash, mode = 'write' }) => rpcResult(client, 'cloud_write_snapshot', {
      p_operation_id: operationId,
      p_expected_revision: expectedRevision,
      p_generation: generation,
      p_schema_version: schemaVersion,
      p_snapshot: snapshot,
      p_payload_hash: payloadHash,
      p_mode: mode,
    }),
    conflicts: () => rpcResult(client, 'cloud_list_sync_conflicts'),
    deleteData: ({ operationId, generation }) => rpcResult(client, 'cloud_delete_account_data', {
      p_operation_id: operationId,
      p_expected_generation: generation,
    }),
  };
};
