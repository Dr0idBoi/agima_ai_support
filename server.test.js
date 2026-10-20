import { test } from 'node:test';
import assert from 'node:assert/strict';
import { server } from './server.js';

const post = async (port, body) => {
  const r = await fetch(`http://localhost:${port}/api/ask`, { method: 'POST', body: JSON.stringify(body) });
  return [r.status, (await r.json()).error];
};

test('валидация вопроса и отсутствие ключа', async (t) => {
  await new Promise((ok) => server.listen(0, ok));
  t.after(() => server.close());
  const { port } = server.address();
  delete process.env.PROXYAPI_KEY;

  assert.equal((await post(port, { question: '   ' }))[0], 400);
  assert.equal((await post(port, { question: 'x'.repeat(4001) }))[0], 400);
  assert.equal((await post(port, { question: 'ошибка' }))[0], 500);
});

test('лимит запросов: 11-й за минуту получает 429', async (t) => {
  await new Promise((ok) => server.listen(0, ok));
  t.after(() => server.close());
  const { port } = server.address();
  process.env.TRUST_PROXY = '1';
  t.after(() => delete process.env.TRUST_PROXY);
  const status = async () => (await fetch(`http://localhost:${port}/api/ask`, { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: '{}' })).status;

  for (let i = 0; i < 10; i++) assert.equal(await status(), 400);
  assert.equal(await status(), 429);
});
