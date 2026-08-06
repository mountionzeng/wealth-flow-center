export const createSpringWindInputState = (text = '') => ({
  mode: String(text || '').trim() ? 'text' : 'idle',
  text: String(text || ''),
  previousText: String(text || ''),
  fileName: '',
  error: '',
  operationId: 0,
});

export const springWindInputReducer = (state, action) => {
  const operationMatches = action?.operationId == null || action.operationId === state.operationId;
  switch (action?.type) {
    case 'typed':
      return {
        ...state,
        mode: String(action.value || '').length ? 'text' : 'idle',
        text: String(action.value || ''),
        previousText: String(action.value || ''),
        fileName: '',
        error: '',
        operationId: state.operationId + 1,
      };
    case 'import_started':
      return {
        ...state,
        mode: 'importing',
        previousText: state.text,
        fileName: String(action.fileName || ''),
        error: '',
        operationId: action.operationId ?? state.operationId + 1,
      };
    case 'recognition_started':
      if (!operationMatches) return state;
      return { ...state, mode: 'recognizing', error: '' };
    case 'import_succeeded':
      if (!operationMatches) return state;
      return {
        ...state,
        mode: 'editable_result',
        text: String(action.text || ''),
        previousText: String(action.text || ''),
        error: '',
      };
    case 'import_failed':
      if (!operationMatches) return state;
      return {
        ...state,
        mode: 'error',
        text: state.previousText,
        error: String(action.error || '素材处理失败'),
      };
    case 'clear_error':
      return {
        ...state,
        mode: state.text ? 'text' : 'idle',
        error: '',
      };
    default:
      return state;
  }
};
