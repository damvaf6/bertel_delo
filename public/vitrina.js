// Витрина «Дело: Экспертиза» (2.53): пометка проверочной версии; вошедшему — «В кабинет» вместо «Войти».
import { api } from '/common.js';

const $ = (id) => document.getElementById(id);
api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});
api('GET', '/api/me').then(() => { $('top-enter').textContent = 'В кабинет'; }).catch(() => {});
