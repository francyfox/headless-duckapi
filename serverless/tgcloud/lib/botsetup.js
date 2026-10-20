// botsetup.js — one-shot bot appearance configuration: description, short
// description, command list and the profile photo (avatar).
// Called from endpoints/setup.js (manual run) and from handlers/message.js
// (automatic one-shot after deploys that change the command list).
import { api, InputFile } from 'sdk';
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { config } from '../schema.js';
import { AVATAR_B64 } from './avatar.js';

// base64 -> bytes without Buffer (JPEG is binary, atobUtf8-style string
// decoding would corrupt it — build a Uint8Array directly).
function b64ToBytes(b64) {
  const C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const e0 = C.indexOf(clean[i]), e1 = C.indexOf(clean[i + 1]);
    const e2 = clean[i + 2] === '=' ? 0 : C.indexOf(clean[i + 2]);
    const e3 = clean[i + 3] === '=' ? 0 : C.indexOf(clean[i + 3]);
    out[p++] = (e0 << 2) | (e1 >> 4);
    if (clean[i + 2] !== '=') out[p++] = ((e1 & 15) << 4) | (e2 >> 2);
    if (clean[i + 3] !== '=') out[p++] = (((e2 & 3) << 6) | e3);
  }
  return out.subarray(0, p);
}

const DESCRIPTION = 'AI-бот на движке duck.ai — бесплатные модели GPT, Claude и Mistral прямо в Телеграме. ' +
  'Живой стриминг ответов, веб-поиск, понимание фотографий и память диалога. ' +
  'Просто напиши вопрос или нажми /start.';

const SHORT_DESCRIPTION = 'AI-чат с GPT, Claude и Mistral: стриминг, веб-поиск, понимание фото. Бесплатно, на движке duck.ai.';

const COMMANDS = [
  { command: 'start', description: 'Запустить бота и показать меню' },
  { command: 'help', description: 'Что умеет бот' },
  { command: 'img', description: 'Нарисовать картинку: /img <описание>' },
  { command: 'models', description: 'Выбрать модель (кнопками)' },
  { command: 'model', description: 'Модель текстом, напр. /model claude' },
  { command: 'effort', description: 'Размышления: none / low / medium' },
  { command: 'web', description: 'Веб-поиск вкл/выкл' },
  { command: 'reset', description: 'Очистить историю диалога' },
  { command: 'settings', description: 'Текущие настройки' },
  { command: 'stats', description: 'Статистика бота (для владельца)' },
];

async function step(name, fn) {
  try { await fn(); return '✅ ok'; }
  catch (e) { return '❌ ' + String((e && e.description) || (e && e.message) || e).slice(0, 160); }
}

export async function runSetup() {
  const report = {};

  report.description = await step('description', () =>
    api.setMyDescription({ description: DESCRIPTION }));

  report.shortDescription = await step('shortDescription', () =>
    api.setMyShortDescription({ short_description: SHORT_DESCRIPTION }));

  report.commands = await step('commands', () =>
    api.setMyCommands({ commands: COMMANDS }));

  // Menu button (☰ next to the input field) opens the command list.
  report.menuButton = await step('menuButton', () =>
    api.setChatMenuButton({ menu_button: { type: 'commands' } }));

  // Profile photo. Bot API 9.x expects an InputProfilePhoto object
  // ({ type: 'static', photo: InputFile }); older shapes get a second try.
  report.photo = await step('photo', async () => {
    try {
      await api.setMyProfilePhoto({
        photo: { type: 'static', photo: new InputFile(b64ToBytes(AVATAR_B64), 'avatar.jpg', { type: 'image/jpeg' }) },
      });
    } catch (e1) {
      await api.setMyProfilePhoto({
        photo: new InputFile(b64ToBytes(AVATAR_B64), 'avatar.jpg', { type: 'image/jpeg' }),
      });
    }
  });

  return report;
}

// One-shot: runs runSetup() when the config flag `needs_setup` is set
// (used after deploys that change the bot's command list). Safe to call on
// every message — the flag check happens at most once per isolate.
let checkedThisIsolate = false;
export async function maybeRunOneShotSetup() {
  if (checkedThisIsolate) return null;
  checkedThisIsolate = true;
  try {
    const row = await db.select().from(config).where(eq(config.key, 'needs_setup')).get();
    if (!row || !row.value) return null;
    const report = await runSetup();
    await db.delete(config).where(eq(config.key, 'needs_setup')).run();
    console.log('[setup] one-shot complete:', JSON.stringify(report));
    return report;
  } catch (e) {
    console.warn('[setup] one-shot failed:', e && e.message ? e.message : e);
    return null;
  }
}
