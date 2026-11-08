import { FIELD_LABELS } from './classify.js';

export const EVALUATION_STATUSES = ['一致', '不一致', '提示額次第', '要確認', '未調査'];
const fieldNames = Object.keys(FIELD_LABELS);
const priorities = { 除外: 0, ハード: 1, 職種: 2, 希望: 3, 注意: 4, 外部調査: 5 };

export function parseCriteria(preferences) {
  let category = '希望';
  let profileMode = false;
  const criteria = [],
    profile = [];
  for (const line of preferences
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)) {
    const heading = line
      .replace(/[【】#]/g, '')
      .replace(/[：:]$/, '')
      .trim();
    const section = [
      [/^除外条件$/, '除外'],
      [/^ハード条件$/, 'ハード'],
      [/^探す職種(?:（優先順位）)?$/, '職種'],
      [/^注意点(?:（.*）)?$/, '注意'],
      [/^評価・調査のルール$/, '外部調査'],
      [/^企業単位の指定$/, '除外'],
      [/^希望条件$/, '希望'],
    ].find(([pattern]) => pattern.test(heading));
    if (/^(?:あなたの)?プロフィール(?:として照合している内容)?$/.test(heading)) {
      profileMode = true;
      continue;
    }
    if (section) {
      category = section[1];
      profileMode = false;
      continue;
    }
    if (profileMode) {
      profile.push(line);
      continue;
    }
    const prefix = line.match(/^(除外|ハード|職種|希望|注意|外部調査)[：:]/)?.[1];
    const kind = prefix || category;
    const external = kind === '外部調査' || /口コミ|報道|5ch|企業回答|従業員数/.test(line);
    criteria.push({
      id: `c${criteria.length + 1}`,
      text: line,
      category: kind,
      priority: external ? priorities.外部調査 : priorities[kind],
      external,
    });
  }
  if (criteria.length > 40) throw new Error('希望条件は40行以内に整理してください。1行を1つの比較条件として扱います。');
  return { criteria, profile: profile.join('\n') };
}

export function analysisInput(values, preferences = '', record) {
  if (typeof preferences !== 'string' || preferences.length > 2000)
    throw new Error('希望条件は2,000文字以内で入力してください。');
  const fields = Object.fromEntries(fieldNames.map((key) => [key, String(values[key] ?? '')]));
  if (!fields.title || !fields.description)
    throw new Error('募集職種と仕事内容を確認・再判定してから分析してください。');
  if (Object.values(fields).join('').length + preferences.length > 6000)
    throw new Error('求人情報と希望条件は合計6,000文字以内にしてください。整理して再判定してください。');
  const provenance = Object.fromEntries(
    fieldNames.map((field) => {
      const original = record?.snapshot.fields[field];
      const modified = Object.hasOwn(record?.overrides || {}, field);
      const origin = record ? (modified ? '利用者修正' : '元ページ抽出') : '採用元未確認';
      if (record && fields[field] !== String(modified ? record.overrides[field] : (original?.value ?? '')))
        throw new Error('採用値と抽出値・修正値の対応を確認できません。再判定してください。');
      return [
        field,
        {
          origin,
          originalValue: original?.value ?? null,
          overrideValue: modified ? record.overrides[field] : null,
          adoptedValue: fields[field],
          source: original?.source ?? '未確認',
          extractionEvidence: original?.evidence ?? '',
        },
      ];
    }),
  );
  return {
    version: 2,
    recordId: record?.id ?? null,
    capturedAt: record?.snapshot.source.capturedAt ?? null,
    fields,
    preferences: preferences.trim(),
    provenance,
    ...parseCriteria(preferences.trim()),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const analysisSignature = (input) => JSON.stringify(canonical(input));

// Offsets count Unicode code points. Quotations always come from the saved adopted input.
export function evidenceSources(input) {
  return fieldNames.flatMap((field) => {
    const chars = Array.from(input.fields[field]);
    const sources = [];
    for (let start = 0; start < chars.length; start += 300) {
      const end = Math.min(start + 300, chars.length);
      sources.push({
        id: `${field}:${start / 300}`,
        field,
        start,
        end,
        evidence: chars.slice(start, end).join(''),
        origin: input.provenance[field].origin,
      });
    }
    return sources;
  });
}

export function verifyEvidence(source, input) {
  const expected = evidenceSources(input).find((item) => item.id === source?.id);
  if (
    !expected ||
    Object.keys(expected).some((key) => source[key] !== expected[key]) ||
    input.provenance[expected.field].adoptedValue !== input.fields[expected.field]
  )
    throw new Error('根拠IDまたは参照先が分析入力と一致しません。結果は採用できません。');
  return expected;
}

export function directInformation(input) {
  return fieldNames.map((field) => ({ field, value: input.fields[field], ...input.provenance[field] }));
}

export function ruleEvaluation(criterion, input) {
  const sources = evidenceSources(input);
  const make = (status, reason, selected = [], question = '') => ({
    status,
    reason,
    evidenceIds: selected.map((source) => source.id),
    question,
    method: 'ルール照合',
  });
  if (criterion.external)
    return make(
      '未調査',
      '必要な外部情報源への調査・照合は実施していません。',
      [],
      `外部情報源で確認：${criterion.text}`,
    );
  const text = criterion.text.normalize('NFKC');
  const excluding = criterion.category === '除外' || /除外|避けたい|希望しない/.test(text);
  if (excluding && /案件アサイン|客先常駐/.test(text)) {
    const phrase = '顧客先にて案件アサイン';
    const position = input.fields.description.indexOf(phrase);
    const start = Array.from(input.fields.description.slice(0, Math.max(position, 0))).length;
    const explicit =
      position < 0
        ? []
        : sources.filter(
            (source) =>
              source.field === 'description' && source.start < start + Array.from(phrase).length && source.end > start,
          );
    if (explicit.length)
      return make('不一致', '採用値に「顧客先にて案件アサイン」とあり、指定の除外条件に該当します。', explicit);
  }
  if (/納期/.test(text) && !/納期|締め切り|締切/.test(input.fields.description))
    return make(
      '要確認',
      '仕事内容の採用値を確認しましたが、納期の記載がなく判断できません。',
      [],
      '案件の納期と、短納期案件が業務の中心になるか確認してください。',
    );

  const salary = sources.filter((source) => source.field === 'salary');
  const annualMinimum = text.match(/年収[^\d]*(\d+(?:\.\d+)?)万円以上/);
  if (annualMinimum) {
    const raw = input.fields.salary.normalize('NFKC').replaceAll(',', '');
    const range =
      (raw.match(/年収/g) || []).length === 1
        ? raw.match(/年収\s*[:：]?\s*(\d+(?:\.\d+)?)万(?:円)?\s*[~〜～-]\s*(\d+(?:\.\d+)?)万円/)
        : null;
    if (!range)
      return make(
        '要確認',
        '給与の採用値から明示された年収範囲を確定できません。月給から年収は生成しません。',
        salary,
        '賞与を含む年収と提示額を確認してください。',
      );
    const [, low, high] = range.map(Number);
    if (low > high)
      return make('要確認', '年収範囲の上下限を確認してください。', salary, '年収範囲を確認してください。');
    const minimum = Number(annualMinimum[1]);
    const status = low >= minimum ? '一致' : high < minimum ? '不一致' : '提示額次第';
    return make(
      status,
      '給与の採用値に明記された年収範囲と希望下限を比較しました。月給換算や賞与の補完はしていません。',
      salary,
      status === '提示額次第' ? '実際の提示年収が希望下限を満たすか確認してください。' : '',
    );
  }
  const fixedLimit = text.match(/固定残業[^。\n]*?(\d+)時間/);
  if (fixedLimit && /以上|不一致|除外/.test(text)) {
    const hours = input.fields.salary.normalize('NFKC').match(/固定残業(?:代|手当)?[^。\n\d]{0,30}(\d+)時間/);
    if (hours)
      return make(
        Number(hours[1]) >= Number(fixedLimit[1]) ? '不一致' : '一致',
        '給与の採用値に明記された固定残業時間と指定の基準を比較しました。',
        salary,
      );
    return make(
      '要確認',
      '固定残業時間を確定できません。記載がないことを「固定残業なし」とは扱いません。',
      salary,
      '固定残業代の有無と対象時間を確認してください。',
    );
  }
  if (/残業/.test(text)) {
    const related = sources.filter((source) => /残業/.test(source.evidence));
    return make(
      '要確認',
      '残業の採用値は下の根拠で確認してください。平均・上限・固定残業の区別を自動確定しません。',
      related,
      '月の平均残業と繁忙期の残業、記載時間の意味を確認してください。',
    );
  }
  return null;
}

export function evaluationSchema(input) {
  const item = {
    type: 'object',
    additionalProperties: false,
    required: ['criterionId', 'status', 'reason', 'evidenceIds', 'question'],
    properties: {
      criterionId: { type: 'string', enum: input.criteria.map((criterion) => criterion.id) },
      status: { type: 'string', enum: EVALUATION_STATUSES },
      reason: { type: 'string', maxLength: 180 },
      evidenceIds: {
        type: 'array',
        maxItems: 4,
        items: { type: 'string', enum: evidenceSources(input).map((source) => source.id) },
      },
      question: { type: 'string', maxLength: 120 },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['evaluations'],
    properties: {
      evaluations: { type: 'array', minItems: input.criteria.length, maxItems: input.criteria.length, items: item },
    },
  };
}

export function validateAnalysis(data, input) {
  if (
    !data ||
    Object.keys(data).some((key) => key !== 'evaluations') ||
    !Array.isArray(data.evaluations) ||
    data.evaluations.length !== input.criteria.length
  )
    throw new Error('条件別評価の件数・形式が不正です。');
  const sources = new Map(evidenceSources(input).map((source) => [source.id, source]));
  const rows = new Map();
  for (const row of data.evaluations) {
    if (
      !row ||
      rows.has(row.criterionId) ||
      !input.criteria.some((criterion) => criterion.id === row.criterionId) ||
      Object.keys(row).some((key) => !['criterionId', 'status', 'reason', 'evidenceIds', 'question'].includes(key)) ||
      !EVALUATION_STATUSES.includes(row.status) ||
      typeof row.reason !== 'string' ||
      !row.reason.trim() ||
      row.reason.length > 500 ||
      typeof row.question !== 'string' ||
      row.question.length > 300 ||
      !Array.isArray(row.evidenceIds) ||
      row.evidenceIds.length > 4 ||
      new Set(row.evidenceIds).size !== row.evidenceIds.length
    )
      throw new Error('条件別評価の項目・判定区分が不正です。');
    for (const id of row.evidenceIds) {
      if (!sources.has(id)) throw new Error('存在しない根拠IDです。結果は採用できません。');
      verifyEvidence(sources.get(id), input);
    }
    rows.set(row.criterionId, row);
  }
  const evaluations = input.criteria.map((criterion) => {
    const row = rows.get(criterion.id);
    const rule = ruleEvaluation(criterion, input);
    let chosen = rule || { ...row, method: 'LLM評価' };
    if (!rule && chosen.status === '未調査') throw new Error('求人情報の不足は「要確認」としてください。');
    if (!rule && ['一致', '不一致', '提示額次第'].includes(chosen.status) && !chosen.evidenceIds.length)
      chosen = {
        status: '要確認',
        method: '根拠不足補正',
        evidenceIds: [],
        reason: 'LLMが確定判定を返しましたが、根拠IDがないため確定せず要確認にしました。',
        question: `採用情報と照合して確認してください：${criterion.text}`,
      };
    if (!rule && chosen.status === '提示額次第' && !/年収|給与|月給|報酬/.test(criterion.text))
      throw new Error('提示額次第は給与条件にだけ使用できます。');
    const question =
      chosen.question.trim() ||
      (chosen.status === '要確認' ? `根拠が不足しています。確認してください：${criterion.text}` : '');
    return {
      criterion,
      status: chosen.status,
      reason: chosen.reason.trim(),
      method: chosen.method,
      question,
      evidence: chosen.evidenceIds.map((id) => verifyEvidence(sources.get(id), input)),
    };
  });
  const questions = evaluations
    .filter((row) => row.question)
    .sort((a, b) => a.criterion.priority - b.criterion.priority)
    .map((row) => ({
      criterionId: row.criterion.id,
      priority: row.criterion.external ? '外部調査' : row.criterion.category,
      status: row.status,
      text: row.question,
    }));
  return { evaluations, questions };
}
