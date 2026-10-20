import { BASE_PROMPT, KINDS, MODES, SEVERITIES, TRIAGE_PROMPT } from './prompts.js';

const API = 'https://api.proxyapi.ru/v1/chat/completions';
const DEFAULT_TRIAGE = { kind: 'howto', tech: '', severity: 'low' };
const OFFTOPIC = {
  kind: 'offtopic', title: 'Это не про разработку', severity: null, confidence: 100,
  summary: 'Я помогаю только с техническими вопросами: ошибки, код, git, базы данных, инфраструктура.',
  cause: '', steps: [], code: null, verify: '',
  followups: ['Объясни, что такое git rebase', 'Почему падает мой Docker-контейнер?'], clarify: [],
};

export class HarnessError extends Error {}

const STATUS_HINTS = {
  401: 'Ключ ProxyAPI отклонён. Проверьте PROXYAPI_KEY.',
  402: 'На балансе ProxyAPI не хватает средств.',
  429: 'Слишком много запросов. Подождите минуту.',
};

async function chat(model, messages, timeoutMs) {
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PROXYAPI_KEY}` },
      body: JSON.stringify({ model, messages, response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new HarnessError(e.name === 'TimeoutError' ? 'Модель отвечает слишком долго. Попробуйте ещё раз.' : 'Не удалось связаться с ProxyAPI. Проверьте интернет.');
  }
  if (!res.ok) throw new HarnessError(STATUS_HINTS[res.status] || `ProxyAPI вернул ошибку ${res.status} для модели ${model}.`);
  const data = await res.json().catch(() => null);
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

const parseJson = (text) => JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, n, max) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);

// Проверка границы доверия: всё, что пришло от модели, приводим к схеме или бросаем с причиной для повторной попытки.
export function normalize(raw, triage) {
  if (!raw || typeof raw !== 'object') throw new Error('ответ не объект JSON');
  const codeText = str(raw.code?.text, 4000);
  const confidence = Math.round(Number(raw.confidence));
  const r = {
    kind: KINDS.includes(triage.kind) ? triage.kind : 'howto',
    title: str(raw.title, 80),
    severity: SEVERITIES.includes(raw.severity) ? raw.severity : triage.severity,
    confidence: Number.isFinite(confidence) ? Math.min(100, Math.max(0, confidence)) : 50,
    summary: str(raw.summary, 500),
    cause: str(raw.cause, 900),
    steps: list(raw.steps, 7, 400),
    code: codeText ? { lang: str(raw.code.lang, 20), text: codeText } : null,
    verify: str(raw.verify, 300),
    followups: list(raw.followups, 3, 120),
    clarify: list(raw.clarify, 2, 200),
  };
  if (!r.summary) throw new Error('пустое поле summary');
  if (!r.steps.length && !r.clarify.length && r.kind !== 'concept') throw new Error('нет ни steps, ни clarify');
  return r;
}

async function triage(question) {
  try {
    const raw = parseJson(await chat(process.env.TRIAGE_MODEL || 'openai/gpt-5.4-nano', [
      { role: 'system', content: TRIAGE_PROMPT },
      { role: 'user', content: question },
    ], 30_000));
    return {
      kind: KINDS.includes(raw.kind) ? raw.kind : DEFAULT_TRIAGE.kind,
      tech: str(raw.tech, 30),
      severity: SEVERITIES.includes(raw.severity) ? raw.severity : DEFAULT_TRIAGE.severity,
    };
  } catch {
    return DEFAULT_TRIAGE; // диспетчер необязателен: без него отвечаем в общем режиме, а ошибку ключа покажет следующий вызов
  }
}

// Конвейер: разбор → ответ в режиме под тип вопроса → проверка схемы → одна попытка починки.
export async function* run(question, previous) {
  const started = Date.now();
  yield { type: 'stage', stage: 'triage' };
  const t = await triage(question);
  yield { type: 'triage', data: t };
  if (t.kind === 'offtopic') return yield { type: 'result', data: OFFTOPIC };

  yield { type: 'stage', stage: 'answer' };
  const model = process.env.MODEL || 'openai/gpt-5.4';
  const context = t.tech ? `Технология: ${t.tech}. Предварительная оценка срочности: ${t.severity}.` : '';
  const messages = [{ role: 'system', content: `${BASE_PROMPT}\n\n${MODES[t.kind]}\n${context}` }];
  if (previous?.question && previous?.summary) {
    messages.push({ role: 'user', content: previous.question }, { role: 'assistant', content: previous.summary });
  }
  messages.push({ role: 'user', content: question });

  const text = await chat(model, messages, 90_000);
  yield { type: 'stage', stage: 'check' };
  let result;
  try {
    result = normalize(parseJson(text), t);
  } catch (e) {
    yield { type: 'stage', stage: 'repair' };
    const fixed = await chat(model, [
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: `Ответ не прошёл проверку: ${e.message}. Верни только исправленный валидный JSON по схеме.` },
    ], 90_000);
    try {
      result = normalize(parseJson(fixed), t);
    } catch {
      throw new HarnessError('Модель дважды вернула ответ в неверном формате. Переформулируйте вопрос.');
    }
  }
  yield { type: 'result', data: { ...result, tech: t.tech, model, ms: Date.now() - started } };
}
