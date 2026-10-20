const HISTORY_KEY = 'duty.history.v2';
const HISTORY_LIMIT = 5;
const STARTERS = [
  { glyph: '!', title: 'Разобрать ошибку', desc: 'Стек-трейс или лог: причина и план исправления', tone: 'var(--high)',
    text: "TypeError: Cannot read properties of undefined (reading 'map')" },
  { glyph: '>_', title: 'Найти команду', desc: 'Git, Docker, консоль: как сделать, не ломая лишнего', tone: 'var(--accent)',
    text: 'Как отменить последний коммит, но оставить изменения в файлах?' },
  { glyph: '?', title: 'Объяснить идею', desc: 'Чем отличается одно от другого и когда что брать', tone: 'var(--low)',
    text: 'Чем отличаются git rebase и git merge и когда что использовать?' },
  { glyph: '{ }', title: 'Проверить код', desc: 'Баги и дыры в безопасности по убыванию важности', tone: 'var(--medium)',
    text: `Посмотри на код, что с ним не так?

app.get("/user", async (req, res) => {
  const rows = await db.query("SELECT * FROM users WHERE id = " + req.query.id);
  res.json(rows);
});` },
];
const STAGES = [
  ['triage', 'Разбор', 'Определяю тип и срочность'],
  ['answer', 'Ответ', 'Готовлю ответ'],
  ['check', 'Проверка', 'Сверяю формат ответа'],
];
const KIND_LABEL = { error: 'Ошибка', howto: 'Как сделать', concept: 'Объяснение', review: 'Ревью кода', offtopic: 'Не по теме' };
const SEVERITY_LABEL = { low: 'Срочность низкая', medium: 'Срочность средняя', high: 'Срочность высокая' };

const $ = (id) => document.getElementById(id);
const form = $('form'), input = $('question'), submit = $('submit'), result = $('result'), historyEl = $('history'), trace = $('trace');

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
// Текст от модели может содержать `код` и **акценты**: разбираем markdown и чистим от разметки, которой там быть не должно.
const rich = (tag, cls, md) => {
  const n = el(tag, cls);
  n.innerHTML = DOMPurify.sanitize(marked.parseInline(md));
  return n;
};
const sec = (title) => { const s = el('section', 'block'); s.append(el('h4', null, title)); return s; };

const loadHistory = () => {
  try { return (JSON.parse(localStorage.getItem(HISTORY_KEY)) || []).filter((h) => h.result); } catch { return []; }
};
const saveHistory = (list) => {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* приватный режим: история живёт до перезагрузки */ }
};
let history = loadHistory();

async function copyText(btn, text, idle) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Скопировано';
  } catch {
    btn.textContent = 'Не удалось';
  }
  setTimeout(() => (btn.textContent = idle), 1800);
}

function toMarkdown(r) {
  const parts = [`## ${r.title}`, r.summary];
  if (r.cause) parts.push(`**Причина.** ${r.cause}`);
  if (r.steps.length) parts.push(r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  if (r.code) parts.push('```' + r.code.lang + '\n' + r.code.text + '\n```');
  if (r.verify) parts.push(`**Как проверить.** ${r.verify}`);
  return parts.join('\n\n');
}

/* ---------- Ход обработки ---------- */
let stageStart = 0;
function initTrace() {
  trace.innerHTML = '';
  for (const [id, name, hint] of STAGES) {
    const li = el('li');
    li.dataset.stage = id;
    li.append(el('b', null, name), el('span', null, hint));
    trace.append(li);
  }
  trace.hidden = false;
  stageStart = performance.now();
}
const stageEl = (id) => trace.querySelector(`[data-stage="${id}"]`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} с`;

function setStage(id) {
  const prev = trace.querySelector('.active');
  if (prev) {
    prev.classList.replace('active', 'done');
    prev.querySelector('span').textContent = seconds(performance.now() - stageStart);
  }
  stageStart = performance.now();
  const next = stageEl(id);
  if (id === 'repair') stageEl('check').querySelector('span').textContent = 'Формат неверный, прошу исправить';
  (next || stageEl('check')).classList.add('active');
}
function finishTrace(ok) {
  const active = trace.querySelector('.active');
  if (active) {
    active.classList.replace('active', ok ? 'done' : 'failed');
    if (ok) active.querySelector('span').textContent = seconds(performance.now() - stageStart);
  }
  trace.querySelectorAll('li:not(.done):not(.failed)').forEach((li) => { li.classList.add('skip'); li.querySelector('span').textContent = 'Не понадобилось'; });
}

/* ---------- Отрисовка ответа ---------- */
function renderResult(question, r) {
  const t = el('article', `ticket sev-${r.severity || 'none'}`);

  const top = el('div', 'ticket-top');
  top.append(el('span', null, [KIND_LABEL[r.kind], r.tech].filter(Boolean).join(' · ')));
  if (r.severity) top.append(el('span', 'badge', SEVERITY_LABEL[r.severity]));
  t.append(top, el('h3', 'title', r.title || KIND_LABEL[r.kind]));

  if (r.kind !== 'offtopic') {
    const meter = el('div', 'meter');
    const bars = el('span', 'meter-bars');
    for (let i = 0; i < 10; i++) {
      const bar = el('i', i < Math.round(r.confidence / 10) ? 'on' : '');
      bar.style.setProperty('--n', i);
      bars.append(bar);
    }
    meter.append(bars, el('span', null, `Уверенность ${r.confidence}%${r.confidence < 60 ? ': проверьте вручную' : ''}`));
    t.append(meter);
  }
  t.append(rich('p', 'summary', r.summary));

  if (r.cause) { const s = sec('Причина'); s.append(rich('p', null, r.cause)); t.append(s); }

  if (r.steps.length) {
    const s = sec(r.kind === 'concept' ? 'Главное' : 'План');
    const progress = el('span', null, `0 из ${r.steps.length}`);
    s.firstChild.append(progress);
    const ol = el('ol', 'steps');
    for (const step of r.steps) {
      const li = el('li'), label = el('label'), box = el('input');
      box.type = 'checkbox';
      box.onchange = () => (progress.textContent = `${ol.querySelectorAll('input:checked').length} из ${r.steps.length}`);
      label.append(box, rich('span', null, step));
      li.append(label);
      ol.append(li);
    }
    s.append(ol);
    t.append(s);
  }

  if (r.code) {
    const s = sec('Код'), box = el('div', 'code'), head = el('header'), copy = el('button', 'mini', 'Копировать');
    copy.type = 'button';
    copy.onclick = () => copyText(copy, r.code.text, 'Копировать');
    head.append(el('span', null, r.code.lang || 'text'), copy);
    const pre = el('pre'), code = el('code', r.code.lang ? `language-${r.code.lang}` : '', r.code.text);
    pre.append(code);
    box.append(head, pre);
    s.append(box);
    t.append(s);
    if (window.hljs) hljs.highlightElement(code);
  }

  if (r.verify) { const s = sec('Как проверить'); s.append(rich('p', null, r.verify)); t.append(s); }

  if (r.clarify.length) {
    const c = el('aside', 'clarify');
    const ul = el('ul');
    r.clarify.forEach((q) => ul.append(el('li', null, q)));
    c.append(el('h4', null, 'Чтобы ответить точнее, уточните'), ul);
    t.append(c);
  }

  if (r.followups.length) {
    const f = el('div', 'followups');
    for (const q of r.followups) {
      const b = el('button', null, q);
      b.type = 'button';
      b.onclick = () => { input.value = q; ask(q, { question, summary: r.summary }); };
      f.append(b);
    }
    t.append(f);
  }

  const foot = el('footer', 'ticket-foot'), copy = el('button', 'copy', 'Копировать ответ');
  copy.type = 'button';
  copy.onclick = () => copyText(copy, toMarkdown(r), 'Копировать ответ');
  foot.append(el('span', null, r.model ? `${r.model.replace('openai/', '')} · ${seconds(r.ms)}` : ''), copy);
  t.append(foot);

  [...t.children].forEach((c, i) => c.style.setProperty('--i', i));
  const q = el('p', 'visually-hidden', `Вопрос: ${question}`);
  result.replaceChildren(q, t);
}

function showError(message) {
  const box = el('div', 'error');
  box.setAttribute('role', 'alert');
  box.textContent = message;
  result.replaceChildren(box);
}

function renderHistory() {
  historyEl.replaceChildren();
  if (!history.length) historyEl.append(el('li', 'history-empty', 'Здесь появятся ваши вопросы.'));
  for (const item of history) {
    const li = el('li'), b = el('button');
    b.type = 'button';
    const time = new Date(item.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    b.append(el('span', `dot ${item.result.severity || ''}`), el('span', 'meta', `${KIND_LABEL[item.result.kind]} · ${time}`), el('span', 'text', item.question));
    b.onclick = () => {
      input.value = item.question;
      trace.hidden = true;
      renderResult(item.question, item.result);
    };
    li.append(b);
    historyEl.append(li);
  }
}

/* ---------- Запрос ---------- */
async function readStream(res, onEvent) {
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.filter(Boolean).forEach((l) => onEvent(JSON.parse(l)));
  }
}

async function ask(question, previous) {
  submit.disabled = true;
  submit.classList.add('busy');
  submit.textContent = 'Думаю…';
  result.replaceChildren();
  initTrace();
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, previous }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Что-то пошло не так. Попробуйте ещё раз.');
    await readStream(res, (e) => {
      if (e.type === 'stage') setStage(e.stage);
      else if (e.type === 'triage') {
        const hint = [KIND_LABEL[e.data.kind], e.data.tech].filter(Boolean).join(' · ');
        stageEl('triage').querySelector('span').textContent = hint;
      } else if (e.type === 'error') throw new Error(e.error);
      else if (e.type === 'result') {
        finishTrace(true);
        history = [{ question, result: e.data, at: Date.now() }, ...history.filter((h) => h.question !== question)].slice(0, HISTORY_LIMIT);
        saveHistory(history);
        renderHistory();
renderStarters();
        renderResult(question, e.data);
      }
    });
  } catch (e) {
    if (trace.querySelector('.active, .done')) finishTrace(false);
    else trace.hidden = true;
    showError(e instanceof TypeError ? 'Нет связи с сервером. Проверьте, что он запущен.' : e.message);
  } finally {
    submit.disabled = false;
    submit.classList.remove('busy');
    submit.textContent = 'Спросить AI';
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (question) ask(question);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
});

function renderStarters() {
  const grid = el('div', 'starters');
  for (const s of STARTERS) {
    const b = el('button', 'starter');
    b.type = 'button';
    b.style.setProperty('--tone', s.tone);
    b.append(el('span', 'glyph', s.glyph), el('b', null, s.title), el('span', null, s.desc));
    b.onclick = () => { input.value = s.text; input.focus(); };
    grid.append(b);
  }
  result.replaceChildren(grid);
}

renderHistory();
renderStarters();
