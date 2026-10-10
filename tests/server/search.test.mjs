// Поиск по списку дел (2.73, 2.165): номер русскими буквами и полный номер находят дело; адрес с «2а» — по-прежнему.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matcher } from '../../public/search.js';

const id = '1a2bc3e4-5d6f-4a1b-9c2d-0e1f2a3b4c5d';
const hay = `№ ${id.slice(0, 8).toUpperCase()} ${id} Оценка квартиры Ковалёва Мария`;

test('2.165: номер дела — латиницей, похожими русскими буквами и с русской раскладкой', () => {
  for (const q of ['1A2BC3E4', '№ 1а2вс3е4', '1ф2ис3у4', '1A2В', 'ковалева 1а2в']) assert.equal(matcher(q)(hay), true, q);
  for (const q of ['1а2вс3е5', '1ф2ис3у5', 'ковалева 9a9b']) assert.equal(matcher(q)(hay), false, q);
});

test('2.165: полный номер из письма или ссылки находит дело', () => {
  assert.equal(matcher(id)(hay), true);
  assert.equal(matcher(id.toUpperCase())(hay), true);
  assert.equal(matcher(id.replace('5d', '5e'))(hay), false);
});

test('2.165: слово с цифрой и русской буквой ищется и как есть — «лесная 2а»', () => {
  const addr = 'Москва, ул. Лесная, д. 2а, кв. 15';
  assert.equal(matcher('лесная 2а')(addr), true);
  assert.equal(matcher('лесная 2б')(addr), false);
});
