// settings.js — the Mini App's backend: read and change per-chat settings.
// Called by web/index.html via Telegram.WebApp.Serverless.call('settings', …).
// The platform verifies initData before this runs, so ctx.initData.user is
// the real Telegram user; in private chats the user id IS the chat id.
import { db, fetch as sdkFetch } from 'sdk';
import { eq } from 'sdk/db';
import { chats, messages } from '../schema.js';
import { getChatRow, listModels, modelName, historyCount, EFFORTS, EFFORT_LABELS } from '../lib/settings.js';
import { touchUser, bumpDaily } from '../lib/metrics.js';

async function snapshot(chatId, fetchFn) {
  const row = await getChatRow(chatId);
  const models = await listModels(fetchFn);
  return {
    model: row.model,
    modelLabel: modelName(row.model, models),
    effort: row.effort,
    effortLabel: EFFORT_LABELS[row.effort] || row.effort,
    web: !!row.webSearch,
    history: await historyCount(chatId),
    models: models.map((m) => ({ id: m.id, name: m.name, free: m.free !== false })),
  };
}

export default async function (input, ctx) {
  const user = ctx && ctx.initData && ctx.initData.user;
  if (!user || !user.id) throw new Error('no user in initData');
  const chatId = user.id;

  // Metrics: webapp opens (every 'get' = one app open) + user touch.
  try {
    await touchUser(user);
    if ((input && input.action) === 'get') await bumpDaily(user.id, 'webappOpens');
  } catch (e) { /* metrics must never break the app */ }

  const action = (input && input.action) || 'get';

  if (action === 'get') {
    return snapshot(chatId, sdkFetch);
  }

  if (action === 'model') {
    const id = String((input && input.value) || '').trim();
    if (!id) throw new Error('value required');
    await getChatRow(chatId);
    await db.update(chats).set({ model: id }).where(eq(chats.chatId, chatId)).run();
    return snapshot(chatId, sdkFetch);
  }

  if (action === 'effort') {
    const v = String((input && input.value) || '').trim();
    if (!EFFORTS.includes(v)) throw new Error('bad effort: ' + v);
    await getChatRow(chatId);
    await db.update(chats).set({ effort: v }).where(eq(chats.chatId, chatId)).run();
    return snapshot(chatId, sdkFetch);
  }

  if (action === 'web') {
    const v = !!(input && input.value);
    await getChatRow(chatId);
    await db.update(chats).set({ webSearch: v }).where(eq(chats.chatId, chatId)).run();
    return snapshot(chatId, sdkFetch);
  }

  if (action === 'reset') {
    await getChatRow(chatId);
    await db.delete(messages).where(eq(messages.chatId, chatId)).run();
    return snapshot(chatId, sdkFetch);
  }

  throw new Error('unknown action: ' + action);
}
