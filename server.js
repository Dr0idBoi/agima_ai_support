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
  if (budgetSpent()) return json(res, 429, { error: 'Лимит демо на этот час исчерпан. Попробуйте позже.' });
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
  // X-Forwarded-For верим только за прокси хостинга (TRUST_PROXY=1): иначе его подделывает любой клиент.
  const forwarded = (process.env.TRUST_PROXY || process.env.VERCEL) && req.headers['x-forwarded-for']?.split(',').pop().trim();
  const ip = forwarded || req.socket.remoteAddress;
  const now = Date.now();
  if (hits.size > 10_000) hits.clear();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  const blocked = recent.length >= RATE_LIMIT;
  if (!blocked) recent.push(now); // отклонённые запросы не записываем, массив не растёт
  hits.set(ip, recent);
  return blocked;
}

// Потолок расхода ключа: считаются только запросы, дошедшие до платной модели. Окно фиксированное, это один счётчик.
const GLOBAL_LIMIT = 200, GLOBAL_WINDOW_MS = 3_600_000;
let budget = { start: 0, count: 0 };
function budgetSpent() {
  if (Date.now() - budget.start > GLOBAL_WINDOW_MS) budget = { start: Date.now(), count: 0 };
  return budget.count >= GLOBAL_LIMIT || (budget.count++, false);
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

// Vercel вызывает default-экспорт как обработчик запроса и порт не слушает; локально и на Render слушаем сами.
export default (req, res) => server.emit('request', req, res);

if (!process.env.VERCEL && process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Дежурный: http://localhost:${port}`));
}
