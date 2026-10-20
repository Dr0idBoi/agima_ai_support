import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError, run } from './harness.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const MAX_QUESTION = 4000;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error('too large');
  }
  return JSON.parse(raw);
}

// Ответ идёт построчным JSON (NDJSON), чтобы интерфейс показывал стадии конвейера по мере выполнения.
async function ask(res, question, previous) {
  if (!process.env.PROXYAPI_KEY) return json(res, 500, { error: 'На сервере не задан PROXYAPI_KEY. Добавьте его в .env и перезапустите.' });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  try {
    for await (const event of run(question, previous)) res.write(JSON.stringify(event) + '\n');
  } catch (e) {
    const error = e instanceof HarnessError ? e.message : 'Внутренняя ошибка сервера.';
    res.write(JSON.stringify({ type: 'error', error }) + '\n');
  }
  res.end();
}

// shortcut: лимит в памяти одного процесса, сбрасывается при рестарте; при нескольких инстансах нужен общий стор (Redis).
const RATE_LIMIT = 10, RATE_WINDOW_MS = 60_000;
const hits = new Map();
function tooMany(req) {
  const ip = req.headers['x-forwarded-for']?.split(',').pop().trim() || req.socket.remoteAddress; // последний адрес добавляет прокси хостинга
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

export const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/ask') {
      if (tooMany(req)) return json(res, 429, { error: 'Слишком много запросов. Подождите минуту.' });
      const body = await readBody(req);
      const question = String(body.question ?? '').trim();
      if (!question) return json(res, 400, { error: 'Опишите проблему или вставьте ошибку.' });
      if (question.length > MAX_QUESTION) return json(res, 400, { error: `Слишком длинно: максимум ${MAX_QUESTION} символов.` });
      const p = body.previous;
      const previous = p && { question: String(p.question ?? '').slice(0, MAX_QUESTION), summary: String(p.summary ?? '').slice(0, 600) };
      return await ask(res, question, previous);
    }
    const file = req.url === '/' ? 'index.html' : req.url.split('?')[0].replace(/\.\./g, '');
    const body = await readFile(join(PUBLIC, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'Не найдено' });
    json(res, 400, { error: 'Некорректный запрос.' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Дежурный: http://localhost:${port}`));
}
