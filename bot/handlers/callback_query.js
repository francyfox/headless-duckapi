// Inline keyboard callbacks:
//   model:<id>     — model picker (radio list)
//   model:close    — close the model picker
//   effort:<v>     — effort radio picker (none | low | medium)
//   effort:close   — close the effort picker
//   settings:*     — quick actions on the /settings screen
//                    (models, effort, web toggle, reset, close)
import { api, db, fetch as sdkFetch } from 'sdk';
import { eq } from 'sdk/db';
import { chats, messages } from '../schema.js';
import { escHtml } from '../lib/reply.js';
import {
  getChatRow, listModels, modelName, modelsInline, effortInline, renderSettings,
  refreshReplyKeyboard, EFFORTS, EFFORT_LABELS,
} from '../lib/settings.js';
import { touchUser, bumpDaily } from '../lib/metrics.js';

async function answer(cq, text) {
  const params = { callback_query_id: cq.id };
  if (text) params.text = text;
  try { await api.answerCallbackQuery(params); } catch (e) { /* expired */ }
}

function inlineMsg(cq) {
  return cq.message && cq.message.chat ? cq : null;
}

// ---------------------------------------------------------------------------
// model:<id> / model:close
// ---------------------------------------------------------------------------
async function onModel(cq, modelId) {
  const msg = inlineMsg(cq);
  if (!msg) return answer(cq, 'Нет чата 🤷');
  const chatId = msg.message.chat.id;

  if (modelId === 'close') {
    try { await api.deleteMessage({ chat_id: chatId, message_id: msg.message.message_id }); } catch (e) {}
    return answer(cq);
  }

  const row = await getChatRow(chatId);
  await db.update(chats).set({ model: modelId }).where(eq(chats.chatId, chatId)).run();
  await answer(cq, 'Модель: ' + modelName(modelId));
  await refreshReplyKeyboard(chatId, Object.assign({}, row, { model: modelId }));

  // Re-render the radio list with the new check-mark.
  let models = [];
  try { models = await listModels(sdkFetch); } catch (e) { /* keyboard stays as is */ }
  if (models.length > 0) {
    try {
      await api.editMessageText({
        chat_id: chatId,
        message_id: msg.message.message_id,
        text: '🤖 Модель: <b>' + escHtml(modelName(modelId, models)) + '</b>\nМожно поменять (🔒 — Plus/Pro):',
        parse_mode: 'HTML',
        reply_markup: modelsInline(models, modelId),
      });
    } catch (e) { /* message is not modified etc. */ }
  }
}

// ---------------------------------------------------------------------------
// effort:<v> / effort:close
// ---------------------------------------------------------------------------
async function onEffort(cq, v) {
  const msg = inlineMsg(cq);
  if (!msg) return answer(cq, 'Нет чата 🤷');
  const chatId = msg.message.chat.id;

  if (v === 'close') {
    try { await api.deleteMessage({ chat_id: chatId, message_id: msg.message.message_id }); } catch (e) {}
    return answer(cq);
  }
  if (!EFFORTS.includes(v)) return answer(cq);

  const row = await getChatRow(chatId);
  await db.update(chats).set({ effort: v }).where(eq(chats.chatId, chatId)).run();
  const updated = Object.assign({}, row, { effort: v });
  await answer(cq, '🧠 Размышления: ' + EFFORT_LABELS[v]);
  await refreshReplyKeyboard(chatId, updated);
  try {
    await api.editMessageText({
      chat_id: chatId,
      message_id: msg.message.message_id,
      text: '🧠 <b>Размышления: ' + EFFORT_LABELS[v] + '</b>\nВыбери уровень:',
      parse_mode: 'HTML',
      reply_markup: effortInline(v),
    });
  } catch (e) { /* not modified */ }
}

// ---------------------------------------------------------------------------
// settings:* — quick actions on the /settings screen
// ---------------------------------------------------------------------------
async function onSettings(cq, action) {
  const msg = inlineMsg(cq);
  if (!msg) return answer(cq, 'Нет чата 🤷');
  const chatId = msg.message.chat.id;
  const mid = msg.message.message_id;

  if (action === 'close') {
    try { await api.deleteMessage({ chat_id: chatId, message_id: mid }); } catch (e) {}
    return answer(cq);
  }

  if (action === 'models') {
    await answer(cq);
    const row = await getChatRow(chatId);
    let models = [];
    try { models = await listModels(sdkFetch); } catch (e) { /* fallback inside */ }
    try {
      await api.editMessageText({
        chat_id: chatId, message_id: mid,
        text: '🤖 Выбери модель (🔒 — тариф duck.ai Plus/Pro):',
        reply_markup: modelsInline(models, row.model),
      });
    } catch (e) { /* not modified */ }
    return;
  }

  if (action === 'effort') {
    await answer(cq);
    const row = await getChatRow(chatId);
    try {
      await api.editMessageText({
        chat_id: chatId, message_id: mid,
        text: '🧠 <b>Размышления: ' + (EFFORT_LABELS[row.effort] || row.effort) + '</b>\nВыбери уровень:',
        parse_mode: 'HTML',
        reply_markup: effortInline(row.effort),
      });
    } catch (e) { /* not modified */ }
    return;
  }

  if (action === 'web') {
    const row = await getChatRow(chatId);
    const next = !row.webSearch;
    await db.update(chats).set({ webSearch: next }).where(eq(chats.chatId, chatId)).run();
    const updated = Object.assign({}, row, { webSearch: next });
    await answer(cq, '🌐 Веб-поиск: ' + (next ? 'вкл' : 'выкл'));
    await refreshReplyKeyboard(chatId, updated);
    // Re-render the settings screen in place (model label without live fetch).
    const s = await renderSettings(chatId, null);
    try {
      await api.editMessageText({ chat_id: chatId, message_id: mid, text: s.text, parse_mode: 'HTML', reply_markup: s.keyboard });
    } catch (e) { /* not modified */ }
    return;
  }

  if (action === 'reset') {
    const row = await getChatRow(chatId);
    await db.delete(messages).where(eq(messages.chatId, chatId)).run();
    await answer(cq, '🧹 История очищена');
    const s = await renderSettings(chatId, null);
    try {
      await api.editMessageText({ chat_id: chatId, message_id: mid, text: s.text, parse_mode: 'HTML', reply_markup: s.keyboard });
    } catch (e) { /* not modified */ }
    return;
  }

  await answer(cq);
}

// ---------------------------------------------------------------------------
export default async function (cq) {
  if (!cq || !cq.id) return;
  const data = cq.data || '';

  // Metrics: button presses per user.
  try {
    if (cq.from) {
      await touchUser(cq.from);
      await bumpDaily(cq.from.id, 'clicks');
    }
  } catch (e) { /* metrics must never break the bot */ }

  if (data.startsWith('model:')) return onModel(cq, data.slice('model:'.length));
  if (data.startsWith('effort:')) return onEffort(cq, data.slice('effort:'.length));
  if (data.startsWith('settings:')) return onSettings(cq, data.slice('settings:'.length));

  await answer(cq);
}
