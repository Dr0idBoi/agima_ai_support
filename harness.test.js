import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, run } from './harness.js';

const triage = { kind: 'error', tech: 'React', severity: 'medium' };
const valid = { summary: 'Суть', steps: ['Шаг'], confidence: 140, severity: 'bogus' };

// Подменяем сеть: каждый вызов модели возвращает следующий ответ из очереди.
const mockModel = (...replies) => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body).model);
    return { ok: true, json: async () => ({ choices: [{ message: { content: replies.shift() } }] }) };
  };
  return calls;
};
const collect = async (gen) => { const out = []; for await (const e of gen) out.push(e); return out; };

test('normalize приводит ответ к схеме', () => {
  const r = normalize(valid, triage);
  assert.equal(r.confidence, 100);
  assert.equal(r.severity, 'medium');
  assert.throws(() => normalize({ steps: ['x'] }, triage), /summary/);
});

test('не по теме: ответ без вызова основной модели', async () => {
  process.env.PROXYAPI_KEY = 'k';
  const calls = mockModel('{"kind":"offtopic","tech":"","severity":"low"}');
  const events = await collect(run('рецепт борща'));
  assert.equal(calls.length, 1);
  assert.equal(events.at(-1).data.kind, 'offtopic');
});

test('невалидный JSON чинится одной повторной попыткой', async () => {
  process.env.PROXYAPI_KEY = 'k';
  const calls = mockModel('{"kind":"error","tech":"React","severity":"medium"}', 'не json', JSON.stringify(valid));
  const events = await collect(run('TypeError'));
  assert.equal(calls.length, 3);
  assert.ok(events.some((e) => e.stage === 'repair'));
  assert.equal(events.at(-1).data.summary, 'Суть');
});
