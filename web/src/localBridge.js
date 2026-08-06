const CAPABILITY_HEADER = 'X-Berich-Capability';
const CALENDAR_STATUSES = new Set(['succeeded', 'permission_denied', 'unavailable', 'retryable_failure', 'ambiguous']);

export const readBridgeCapability = (documentRef = globalThis.document) => {
  try { return documentRef?.querySelector('meta[name="berich-capability"]')?.content || ''; }
  catch { return ''; }
};

const errorFromPayload = (payload, status) => {
  const code = String(payload?.error || payload?.status || `http_${status}`);
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
};

export const createLocalBridge = ({
  capability = readBridgeCapability(),
  fetchImpl = globalThis.fetch?.bind(globalThis),
  baseUrl = '',
} = {}) => {
  const request = async (path, { method = 'GET', body, contentType = 'application/json', preserveCalendarStatus = false } = {}) => {
    if (!capability || !fetchImpl) throw errorFromPayload({ error: 'bridge_unavailable' }, 0);
    const headers = { [CAPABILITY_HEADER]: capability };
    if (body != null && contentType) headers['Content-Type'] = contentType;
    let payloadBody = body;
    if (body != null && contentType === 'application/json') payloadBody = JSON.stringify(body);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: payloadBody, credentials: 'same-origin' });
    } catch {
      throw errorFromPayload({ error: 'bridge_unavailable' }, 0);
    }
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { throw errorFromPayload({ error: 'invalid_bridge_response' }, response.status); }
    if (!response.ok || payload.ok === false) {
      if (preserveCalendarStatus && CALENDAR_STATUSES.has(payload.status)) return payload;
      throw errorFromPayload(payload, response.status);
    }
    return payload;
  };

  return {
    capability: () => request('/api/capability'),
    listCalendars: () => request('/api/calendar/calendars', { preserveCalendarStatus: true }),
    calendarHistory: calendars => request('/api/calendar/history', { method: 'POST', body: { calendars } }),
    writeCalendar: event => request('/api/calendar/events', { method: 'POST', body: event, preserveCalendarStatus: true }),
    reconcileCalendar: input => request('/api/calendar/reconcile', { method: 'POST', body: input, preserveCalendarStatus: true }),
    aiDisclosure: () => request('/api/ai/disclosure'),
    environmentDisclosure: () => request('/api/environment/disclosure'),
    searchCity: input => request('/api/environment/search', { method: 'POST', body: input }),
    dailyAdvice: input => request('/api/ai/daily-advice', { method: 'POST', body: input }),
    springWind: input => request('/api/ai/spring-wind', { method: 'POST', body: input }),
    recognizeBazi: (bytes, mediaType) => request('/api/ai/recognize-bazi', { method: 'POST', body: bytes, contentType: mediaType }),
  };
};
