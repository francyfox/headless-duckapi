// Per-chat settings. One row per chat, created on first message.
import { table, integer, text, index, primaryKey, sql } from 'sdk/db';

export const chats = table('chats', {
  chatId: integer('chat_id').primaryKey(),
  model: text('model').notNull().default('gpt-5.4-mini'),
  effort: text('effort').notNull().default('none'),
  webSearch: integer('web_search', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// Conversation history. Images are stored as text placeholders ('[photo] caption'),
// the actual bytes are never persisted.
export const messages = table('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  model: text('model'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  chatIdx: index('idx_messages_chat_id').on(t.chatId, t.id),
}));

// Small key-value store for the duck.ai protocol auto-update: the solved
// challenge token, the frontend version and the live entry.js URL survive
// isolate restarts here, so we hit duck.ai far less often (fewer 418/429).
export const config = table('config', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// ---------------------------------------------------------------------------
// Metrics (added Oct 2026)
// ---------------------------------------------------------------------------

// One row per Telegram user (private chats) or group (userId = -(chat id)).
// `source` records how the user came in: 'direct' (/start without payload),
// a deep-link payload (t.me/<bot>?start=<payload>), or 'group'.
export const users = table('users', {
  userId: integer('user_id').primaryKey(),
  firstName: text('first_name'),
  username: text('username'),
  isGroup: integer('is_group', { mode: 'boolean' }).notNull().default(false),
  source: text('source').notNull().default('direct'),
  firstSeen: integer('first_seen', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  lastSeen: integer('last_seen', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  msgsIn: integer('msgs_in').notNull().default(0),
  msgsOut: integer('msgs_out').notNull().default(0),
}, (t) => ({
  lastIdx: index('idx_users_last_seen').on(t.lastSeen),
  srcIdx: index('idx_users_source').on(t.source),
}));

// Per-UTC-day, per-user aggregates for /stats and activity charts.
export const statsDaily = table('stats_daily', {
  day: text('day').notNull(), // 'YYYY-MM-DD' (UTC)
  userId: integer('user_id').notNull(),
  msgsIn: integer('msgs_in').notNull().default(0),
  msgsOut: integer('msgs_out').notNull().default(0),
  errors: integer('errors').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  webappOpens: integer('webapp_opens').notNull().default(0),
  imgs: integer('imgs').notNull().default(0), // generated images (/img + spontaneous)
  models: text('models', { mode: 'json' }), // { modelId: count }
}, (t) => ({
  pk: primaryKey({ columns: [t.day, t.userId] }),
}));

// duck.ai protocol health, per UTC day, key-value counters:
// chats (ok), solves, fallbacks, token_reused, status_err, e418, e429,
// net_err, http_err.
export const duckDaily = table('duck_daily', {
  day: text('day').notNull(),
  key: text('key').notNull(),
  value: integer('value').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.day, t.key] }),
}));
