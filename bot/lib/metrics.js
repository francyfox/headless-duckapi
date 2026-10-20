// metrics.js — bot usage metrics: users, sources, daily activity, duck.ai health.
// Everything is aggregate-friendly (per-day rows), so /stats stays cheap.
import { db } from 'sdk';
import { eq, sql, and, gte, desc } from 'sdk/db';
import { users, statsDaily, duckDaily, config } from '../schema.js';

// Owners allowed to run /stats. Extend via the config table:
// key 'admin_ids', value JSON array of Telegram user ids.
// [VPS port patch] — additional admins come from the ADMIN_IDS env var
// ("123,456"). Put the bot owner's id into DEFAULT_ADMIN_IDS below, or use ADMIN_IDS.
const ENV_ADMIN_IDS = String(
  (typeof process !== 'undefined' && process.env && process.env.ADMIN_IDS) || '',
).split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger).filter((n) => n > 0);
const DEFAULT_ADMIN_IDS = [...ENV_ADMIN_IDS];

export function todayStr() { return new Date().toISOString().slice(0, 10); }
function dayStr(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

// Upsert a user (or group) row and refresh lastSeen.
// from: a Telegram User object; opts: { source, isGroup, chatId, title }.
export async function touchUser(from, opts = {}) {
  try {
    if (!from || !from.id) return null;
    const uid = opts.isGroup ? -Math.abs(opts.chatId || from.id) : from.id;
    const name = opts.title || from.first_name || from.title || '';
    const existing = await db.select().from(users).where(eq(users.userId, uid)).get();
    if (!existing) {
      await db.insert(users).values({
        userId: uid,
        firstName: name || null,
        username: from.username || null,
        isGroup: !!opts.isGroup,
        source: opts.source || 'direct',
        msgsIn: 0,
        msgsOut: 0,
      }).onConflictDoNothing({ target: users.userId }).run();
    } else {
      const patch = { lastSeen: new Date() };
      if (opts.isGroup && name && existing.firstName !== name) patch.firstName = name;
      if (opts.source && opts.source !== 'direct' && existing.source === 'direct') patch.source = opts.source;
      if (from.username && existing.username !== from.username) patch.username = from.username;
      await db.update(users).set(patch).where(eq(users.userId, uid)).run();
    }
    return uid;
  } catch (e) {
    console.warn('[metrics] touchUser failed:', e && e.message ? e.message : e);
    return null;
  }
}

// Deep-link /start payload -> normalised source tag (A-Za-z0-9_-, max 32).
export function normalizeSource(payload) {
  const p = String(payload || '').trim().replace(/^@/, '');
  if (!p) return 'direct';
  const clean = p.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return clean ? 'ref:' + clean : 'direct';
}

export async function isAdmin(userId) {
  if (!userId) return false;
  if (DEFAULT_ADMIN_IDS.includes(userId)) return true;
  try {
    const row = await db.select().from(config).where(eq(config.key, 'admin_ids')).get();
    if (row && row.value) {
      const list = JSON.parse(row.value);
      if (Array.isArray(list) && list.includes(userId)) return true;
    }
  } catch (e) { /* bad json — ignore */ }
  return false;
}

// ---------------------------------------------------------------------------
// Daily counters
// ---------------------------------------------------------------------------

// Increment a counter column in stats_daily for (today, uid).
const DAILY_COLS = {
  msgsIn: 'msgs_in',
  msgsOut: 'msgs_out',
  errors: 'errors',
  clicks: 'clicks',
  webappOpens: 'webapp_opens',
  imgs: 'imgs',
};
export async function bumpDaily(uid, field, n = 1) {
  if (!uid) return;
  const col = DAILY_COLS[field];
  if (!col) return;
  try {
    const day = todayStr();
    await db.run(sql`INSERT INTO stats_daily (day, user_id, ${sql.raw(col)}) VALUES (${day}, ${uid}, ${n})
      ON CONFLICT (day, user_id) DO UPDATE SET ${sql.raw(col)} = ${sql.raw(col)} + ${n}`);
  } catch (e) {
    console.warn('[metrics] bumpDaily failed:', e && e.message ? e.message : e);
  }
}

// Record one use of `modelId` for (today, uid) in the models json column.
export async function bumpModel(uid, modelId) {
  if (!uid || !modelId) return;
  try {
    const day = todayStr();
    const row = await db.select().from(statsDaily)
      .where(and(eq(statsDaily.day, day), eq(statsDaily.userId, uid))).get();
    const models = (row && row.models) || {};
    models[modelId] = (models[modelId] || 0) + 1;
    await db.insert(statsDaily).values({ day, userId: uid, models })
      .onConflictDoUpdate({ target: [statsDaily.day, statsDaily.userId], set: { models } }).run();
  } catch (e) {
    console.warn('[metrics] bumpModel failed:', e && e.message ? e.message : e);
  }
}

// duck.ai protocol health counter for today (key-value).
export function makeDuckStats() {
  return {
    bump(key, n = 1) {
      const allowed = new Set(['duck_chat_ok', 'duck_token_reused', 'duck_status_err', 'duck_418', 'duck_429', 'duck_net_err', 'duck_imgs']);
      if (!allowed.has(key)) return;
      const day = todayStr();
      db.run(sql`INSERT INTO duck_daily (day, key, value) VALUES (${day}, ${key}, ${n})
        ON CONFLICT (day, key) DO UPDATE SET value = value + ${n}`).catch((e) => {
        console.warn('[metrics] duck bump failed:', e && e.message ? e.message : e);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// /stats report
// ---------------------------------------------------------------------------

async function sums(days) {
  const rows = await db.select({
    msgsIn: sql`coalesce(sum(msgs_in), 0)`,
    msgsOut: sql`coalesce(sum(msgs_out), 0)`,
    errors: sql`coalesce(sum(errors), 0)`,
    clicks: sql`coalesce(sum(clicks), 0)`,
    webappOpens: sql`coalesce(sum(webapp_opens), 0)`,
    imgs: sql`coalesce(sum(imgs), 0)`,
  }).from(statsDaily).where(gte(statsDaily.day, dayStr(days - 1))).all();
  return rows[0] || { msgsIn: 0, msgsOut: 0, errors: 0, clicks: 0, webappOpens: 0, imgs: 0 };
}

async function modelTop(days, limit = 5) {
  const rows = await db.select({ models: statsDaily.models })
    .from(statsDaily).where(gte(statsDaily.day, dayStr(days - 1))).all();
  const agg = {};
  for (const r of rows) {
    if (!r.models) continue;
    for (const [k, v] of Object.entries(r.models)) agg[k] = (agg[k] || 0) + v;
  }
  const total = Object.values(agg).reduce((a, b) => a + b, 0);
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, limit);
  return { top, total };
}

async function duckStats(days) {
  const rows = await db.select({ key: duckDaily.key, value: sql`sum(value)` })
    .from(duckDaily).where(gte(duckDaily.day, dayStr(days - 1))).groupBy(duckDaily.key).all();
  const m = {};
  for (const r of rows) m[r.key] = r.value || 0;
  return m;
}

export async function renderStats() {
  const dayAgo = Math.floor((Date.now() - 86400000) / 1000);
  const [totalUsers, groups, newToday, activeToday, active7d] = await Promise.all([
    db.select({ n: sql`count(*)` }).from(users).where(eq(users.isGroup, false)).all(),
    db.select({ n: sql`count(*)` }).from(users).where(eq(users.isGroup, true)).all(),
    db.select({ n: sql`count(*)` }).from(users).where(sql`first_seen >= ${dayAgo}`).all(),
    db.select({ n: sql`count(*)` }).from(statsDaily).where(eq(statsDaily.day, todayStr())).all(),
    db.select({ n: sql`count(distinct user_id)` }).from(statsDaily).where(gte(statsDaily.day, dayStr(6))).all(),
  ]);

  const [s1, s7] = await Promise.all([sums(1), sums(7)]);
  const [{ top, total }, duck7] = await Promise.all([modelTop(7), duckStats(7)]);

  // sources
  const srcRows = await db.select({ source: users.source, n: sql`count(*)` })
    .from(users).groupBy(users.source).all();
  const sources = srcRows.sort((a, b) => b.n - a.n);

  // totals over all time (users table counters)
  const allTime = await db.select({
    msgsIn: sql`coalesce(sum(msgs_in), 0)`,
    msgsOut: sql`coalesce(sum(msgs_out), 0)`,
  }).from(users).all();

  const MODEL_LABELS = {
    'gpt-5.4-mini': 'GPT-5.4 mini',
    'gpt-6-luna': 'GPT-6 Luna',
    'claude-haiku-4-5': 'Claude Haiku 4.5',
    'mistral-small-2603': 'Mistral Small',
    'tinfoil/gpt-oss-120b': 'GPT-OSS 120B',
    'tinfoil/gemma4-31b': 'Gemma 4 31B',
  };

  const L = [];
  L.push('📊 <b>Статистика бота</b>');
  L.push('');
  L.push('👥 <b>Пользователи</b>: ' + (totalUsers[0] ? totalUsers[0].n : 0) +
    (groups[0] && groups[0].n ? ' + ' + groups[0].n + ' групп' : '') +
    ' · 🆕 за сутки: ' + (newToday[0] ? newToday[0].n : 0));
  L.push('🔥 <b>Активные</b>: сегодня ' + (activeToday[0] ? activeToday[0].n : 0) +
    ' · за 7 дней ' + (active7d[0] ? active7d[0].n : 0));
  L.push('');
  L.push('💬 <b>Сообщения</b>: сегодня ' + s1.msgsIn + ' вх / ' + s1.msgsOut + ' отв' +
    ' · за 7 дней ' + s7.msgsIn + ' / ' + s7.msgsOut);
  L.push('Σ Всего: ' + (allTime[0] ? allTime[0].msgsIn : 0) + ' вх / ' + (allTime[0] ? allTime[0].msgsOut : 0) + ' отв');
  L.push('🎛 Кнопок нажато (7д): ' + s7.clicks + ' · WebApp открывали (7д): ' + s7.webappOpens + ' раз');
  L.push('🎨 Картинок: сегодня ' + s1.imgs + ' · за 7 дней ' + s7.imgs);
  L.push('⚠️ Ошибок: сегодня ' + s1.errors + ' · за 7 дней ' + s7.errors);
  if (total > 0) {
    L.push('');
    L.push('🧠 <b>Модели (7 дней)</b>:');
    for (const [id, n] of top) {
      const pct = Math.round((n / total) * 100);
      L.push('  • ' + (MODEL_LABELS[id] || id) + ' — ' + n + ' (' + pct + '%)');
    }
  }
  if (sources.length > 0) {
    L.push('');
    L.push('🚪 <b>Источники</b>:');
    for (const s of sources) {
      const label = s.source.startsWith('ref:')
        ? 'по ссылке «' + s.source.slice(4) + '»'
        : (s.source === 'group' ? 'из групп' : 'напрямую /start');
      L.push('  • ' + label + ' — ' + s.n);
    }
  }
  const duckTotal = (duck7.duck_chat_ok || 0) + (duck7.e418 || 0) + (duck7.e429 || 0) +
    (duck7.status_err || 0) + (duck7.net_err || 0);
  if (duckTotal > 0) {
    L.push('');
    L.push('🦆 <b>duck.ai (7 дней)</b>: ' + duckTotal + ' запросов · ок ' + (duck7.duck_chat_ok || 0) +
      ' · 418: ' + (duck7.e418 || 0) + ' · 429: ' + (duck7.e429 || 0));
    const solveFb = (duck7.solves || 0), fb = (duck7.fallbacks || 0);
    if (solveFb + fb > 0) L.push('  · челленджей решено: ' + solveFb + (fb ? ' (fallback: ' + fb + ')' : ''));
  }
  return L.join('\n');
}
