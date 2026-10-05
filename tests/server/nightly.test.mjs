// Задача 2.56: ночной прогон площадки — расписание, только stage через выкладку deploy.yml, итог NIGHTLY.md без данных
// людей (tests/tools/nightly-report.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/nightly.yml'), 'utf8');

test('ночной прогон: каждую ночь, через выкладку stage, без ключей и без боевого сайта', () => {
  assert.match(yml, /cron: '0 23 \* \* 0-5'/);
  assert.match(yml, /cron: '0 23 \* \* 6'/);
  assert.match(yml, /uses: \.\/\.github\/workflows\/deploy\.yml/);
  assert.match(yml, /demo: true/);
  assert.doesNotMatch(yml, /prod|STAGE_LOGIN_KEY|YC_SA_KEY/);
  const deploy = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(deploy, /workflow_call:/);
  assert.match(deploy, /^\s+ENV: stage$/m);
  assert.match(fs.readFileSync(path.join(ROOT, 'playwright.stage.mjs'), 'utf8'), /stage-report\.json/);
});

test('итог ночного прогона: зелёный и красный, упавшие проверки с первой строкой ошибки', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-'));
  const file = path.join(dir, 'r.json');
  const spec = (title, status, error) => ({ title, file: 'stage.spec.mjs', tests: [{ status: status === 'passed' ? 'expected' : 'unexpected', results: [{ status, ...(error ? { error: { message: error } } : {}) }] }] });
  const run = (data, result) => {
    fs.writeFileSync(file, JSON.stringify(data));
    return execFileSync(process.execPath, [path.join(ROOT, 'tests/tools/nightly-report.mjs'), file, result, 'https://example.test/run', 'abc1234'], { encoding: 'utf8' });
  };
  const ok = run({ suites: [{ title: 'stage.spec.mjs', specs: [spec('вход', 'passed'), spec('витрина', 'passed')] }] }, 'success');
  assert.match(ok, /зелёный/);
  assert.match(ok, /Проверок: 2; прошло 2/);
  const bad = run({ suites: [{ title: 'stage.spec.mjs', specs: [spec('вход', 'passed'), spec('витрина', 'failed', '\u001b[31mError: не открылась\u001b[39m\nподробности')] }] }, 'failure');
  assert.match(bad, /КРАСНЫЙ/);
  assert.match(bad, /stage\.spec\.mjs: витрина — Error: не открылась/);
  assert.doesNotMatch(bad, /подробности|\u001b/);
  fs.rmSync(file);
  assert.match(execFileSync(process.execPath, [path.join(ROOT, 'tests/tools/nightly-report.mjs'), file, 'failure', 'u', 's'], { encoding: 'utf8' }), /выкладка на площадку не прошла/);
});
