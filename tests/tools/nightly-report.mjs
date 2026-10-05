// Итог ночного прогона площадки (2.56) → NIGHTLY.md: дата, версия, зелёный или красный, сколько проверок прошло,
// какие упали (название и первая строка ошибки). Без данных людей — только названия проверок.
//   node tests/tools/nightly-report.mjs test-results/stage-report.json <результат job> <адрес прогона> <версия>
import fs from 'node:fs';

const [file, result = 'unknown', url = '', sha = ''] = process.argv.slice(2);
let report = null;
try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* прогон не дошёл до проверок */ }

const tests = [];
const walk = (suite, path = []) => {
  for (const s of suite.suites ?? []) walk(s, [...path, s.title]);
  for (const sp of suite.specs ?? []) {
    for (const t of sp.tests ?? []) {
      const last = t.results?.at(-1);
      const status = t.status === 'skipped' ? 'skipped' : last?.status === 'passed' ? 'passed' : (t.status === 'flaky' ? 'flaky' : 'failed');
      const err = (last?.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((x) => x.trim()) ?? '';
      tests.push({ title: [...path.filter(Boolean).slice(1), sp.title].join(' › ') || sp.title, file: sp.file, status, err: err.slice(0, 200) });
    }
  }
};
if (report) for (const s of report.suites ?? []) walk(s, [s.title]);

const n = (st) => tests.filter((t) => t.status === st).length;
const green = result === 'success' && n('failed') === 0;
const at = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const lines = [
  `# Ночной прогон площадки — ${green ? 'зелёный' : 'КРАСНЫЙ'}`,
  '',
  `- Когда: ${at} МСК; версия \`${sha}\`; [прогон](${url})`,
  report ? `- Проверок: ${tests.length}; прошло ${n('passed')}, нестабильных ${n('flaky')}, упало ${n('failed')}, пропущено ${n('skipped')}`
    : '- Проверки не запускались: выкладка на площадку не прошла (подробности — в прогоне)',
];
const failed = tests.filter((t) => t.status === 'failed' || t.status === 'flaky');
if (failed.length) {
  lines.push('', '## Упало', '');
  for (const t of failed) lines.push(`- ${t.status === 'flaky' ? '(со второй попытки) ' : ''}${t.file}: ${t.title}${t.err ? ` — ${t.err}` : ''}`);
}
console.log(lines.join('\n'));
