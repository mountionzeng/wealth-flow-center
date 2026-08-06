const required = (value, field) => {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Calendar ${field} 缺失`);
  return text;
};

export const resolveCalendarProjection = async (bridge, projection) => {
  const operationId = required(projection?.operation_id, 'operation_id');
  const kind = required(projection?.kind, 'kind');
  const checked = await bridge.reconcileCalendar({ kind, operation_id: operationId });
  const canWrite = checked.status === 'retryable_failure'
    && checked.matches === 0
    && projection.state !== 'ambiguous';

  if (!canWrite) return { checked, result: checked, wrote: false };

  const result = await bridge.writeCalendar({
    kind,
    title: required(projection.title, 'title'),
    start: required(projection.start, 'start'),
    end: required(projection.end, 'end'),
    operation_id: operationId,
  });
  return { checked, result, wrote: true };
};
