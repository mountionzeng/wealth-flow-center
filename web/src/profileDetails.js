export const PROFILE_DETAIL_DEFINITIONS = Object.freeze({
  gender: { label: '性别', placeholder: '例如：女' },
  solar_birth: { label: '公历出生', placeholder: '例如：1994-08-31 05:45' },
  lunar_birth: { label: '农历出生', placeholder: '例如：甲戌年七月廿五卯时' },
  true_solar_time: { label: '真太阳时', placeholder: '例如：1994-08-31 05:31' },
  birth_place: { label: '出生地点', placeholder: '例如：四川成都' },
  zodiac: { label: '生肖', placeholder: '例如：狗' },
  day_master: { label: '日主', placeholder: '例如：己土' },
  five_elements: { label: '五行摘要', placeholder: '按图片原文填写' },
  nayin: { label: '纳音', placeholder: '按图片原文填写' },
  fate_palace: { label: '命宫', placeholder: '按图片原文填写' },
  body_palace: { label: '身宫', placeholder: '按图片原文填写' },
  start_luck: { label: '起运信息', placeholder: '按图片原文填写' },
});

const CONFIDENCE = new Set(['high', 'medium', 'low']);

export const normalizeProfileDetails = value => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 24).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const key = String(item.key || '').trim();
    const definition = PROFILE_DETAIL_DEFINITIONS[key];
    const fieldValue = String(item.value || '').trim().slice(0, 160);
    if (!definition || !fieldValue || seen.has(key)) return [];
    seen.add(key);
    const confidence = String(item.confidence || 'medium').toLowerCase();
    return [{ key, label: definition.label, value: fieldValue, confidence: CONFIDENCE.has(confidence) ? confidence : 'medium' }];
  });
};

export const confirmedProfilePayload = value => normalizeProfileDetails(value)
  .map(({ key, value }) => ({ key, value }));
