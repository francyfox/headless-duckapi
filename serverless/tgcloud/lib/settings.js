// settings.js — shared per-chat settings helpers used by handlers/message,
// handlers/callback_query and the Mini App endpoints, so every surface
// (commands, buttons, Mini App) shows and changes settings the same way.
import { api, db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { chats, messages } from '../schema.js';
import { getModels } from './duckai.js';
import { mainKeyboard, escHtml } from './reply.js';

export const DEFAULT_MODEL = 'gpt-5.4-mini';
export const EFFORTS = ['none', 'low', 'medium'];
export const EFFORT_LABELS = { none: 'Выкл', low: 'Низкий', medium: 'Средний' };

// Display names when the live duck.ai model list is unreachable.
export const MODEL_NAMES = {
  'gpt-5.4-mini': 'GPT-5.4 mini',
  'gpt-6-luna': 'GPT-6 Luna',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'mistral-small-2603': 'Mistral Small 2603',
  'tinfoil/gpt-oss-120b': 'GPT-OSS 120B',
  'tinfoil/gemma4-31b': 'Gemma 4 31B',
};
export const FALLBACK_MODELS = Object.keys(MODEL_NAMES).map((id) => ({
  id, name: MODEL_NAMES[id], free: true,
}));

export async function getChatRow(chatId) {
  let row = await db.select().from(chats).where(eq(chats.chatId, chatId)).get();
  if (!row) {
    await db.insert(chats).values({ chatId, model: DEFAULT_MODEL }).onConflictDoNothing().run();
    row = await db.select().from(chats).where(eq(chats.chatId, chatId)).get();
  }
  return row;
}

export async function historyCount(chatId) {
  const rows = await db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId)).all();
  return rows.length;
}

// Live model list, falling back to the static one.
export async function listModels(fetchFn) {
  try {
    const models = await getModels(fetchFn);
    if (models && models.length > 0) return models;
  } catch (e) { /* offline / rate-limited */ }
  return FALLBACK_MODELS.slice();
}

export function modelName(id, models) {
  if (models) {
    const m = models.find((x) => x.id === id);
    if (m) return m.name;
  }
  return MODEL_NAMES[id] || id;
}

export function webLabel(b) { return b ? 'вкл' : 'выкл'; }

// ---------------------------------------------------------------------------
// Inline keyboards (radio style, like Telegram's own pickers)
// ---------------------------------------------------------------------------
export function effortInline(current) {
  const mark = (v) => (v === current ? '◉' : '○');
  return { inline_keyboard: [
    [{ text: mark('none') + ' Выкл', callback_data: 'effort:none' }],
    [{ text: mark('low') + ' Низкий', callback_data: 'effort:low' }],
    [{ text: mark('medium') + ' Средний', callback_data: 'effort:medium' }],
    [{ text: '✕ Закрыть', callback_data: 'effort:close' }],
  ] };
}

export function modelsInline(models, currentId) {
  return { inline_keyboard: models.map((m) => ([{
    text: (m.free === false ? '🔒 ' : '') + m.name + (m.id === currentId ? '  ✅' : ''),
    callback_data: 'model:' + m.id,
  }])).concat([[{ text: '✕ Закрыть', callback_data: 'model:close' }]]) };
}

export function settingsInline() {
  return { inline_keyboard: [
    [{ text: '🤖 Модель', callback_data: 'settings:models' }, { text: '🧠 Размышления', callback_data: 'settings:effort' }],
    [{ text: '🌐 Поиск', callback_data: 'settings:web' }, { text: '🧹 Очистить', callback_data: 'settings:reset' }],
    [{ text: '✕ Закрыть', callback_data: 'settings:close' }],
  ] };
}

// ---------------------------------------------------------------------------
// Settings screen (text + keyboard)
// ---------------------------------------------------------------------------
export async function renderSettings(chatId, fetchFn) {
  const row = await getChatRow(chatId);
  const n = await historyCount(chatId);
  let models = null;
  try { models = await listModels(fetchFn); } catch (e) { /* static fallback inside */ }
  const text = [
    '⚙️ <b>Настройки</b>',
    '',
    '🤖 Модель: <b>' + escHtml(modelName(row.model, models)) + '</b>',
    '🧠 Размышления: <b>' + (EFFORT_LABELS[row.effort] || row.effort) + '</b>',
    '🌐 Веб-поиск: <b>' + webLabel(row.webSearch) + '</b>',
    '💬 Сообщений в истории: <b>' + n + '</b>',
  ].join('\n');
  return { row, models, text, keyboard: settingsInline() };
}

// The persistent reply keyboard labels are live; after any change made from
// an inline message we refresh it with a send-and-delete (the keyboard stays).
export async function refreshReplyKeyboard(chatId, row) {
  let m = null;
  try {
    m = await api.sendMessage({ chat_id: chatId, text: '⠀', reply_markup: mainKeyboard(row) });
  } catch (e) { return; }
  try { await api.deleteMessage({ chat_id: chatId, message_id: m.message_id }); } catch (e) { /* keep */ }
}
