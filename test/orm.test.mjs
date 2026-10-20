// test/orm.test.mjs — exercises the full sdk/db ORM subset the bot uses,
// against a real SQLite file in a temp dir. Exits non-zero on any failure.
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const tmp = path.join(os.tmpdir(), 'headless-duckapi-orm-test-' + Date.now());
mkdirSync(tmp, { recursive: true });
process.env.DATA_DIR = tmp;

const { db, migrate, sql, eq, gte, lt, and, desc, table, integer, text, index, primaryKey } =
  await import('../platform/sdk/db.js');

// A test schema shaped like the bot's (all modes + composite PK + index).
const items = table('items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  title: text('title').default('none'),
  flag: integer('flag', { mode: 'boolean' }).notNull().default(false),
  meta: text('meta', { mode: 'json' }),
  seenAt: integer('seen_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  idx: index('idx_items_chat').on(t.chatId, t.id),
}));
const counters = table('counters', {
  day: text('day').notNull(),
  key: text('key').notNull(),
  value: integer('value').notNull().default(0),
  models: text('models', { mode: 'json' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.day, t.key] }),
}));

await migrate();

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

// insert + select full row (mode decoding)
await db.insert(items).values({ chatId: 1, title: 'hello', flag: true, meta: { a: 1 } }).run();
let row = await db.select().from(items).where(eq(items.chatId, 1)).get();
assert.equal(row.title, 'hello');
assert.equal(row.flag, true);            // boolean decode
assert.deepEqual(row.meta, { a: 1 });    // json decode
assert.ok(row.seenAt instanceof Date);   // timestamp decode (unixepoch default)
assert.equal(row.id, 1);                 // autoincrement
ok('insert + select with boolean/json/timestamp modes');

// default values
await db.insert(items).values({ chatId: 2 }).run();
row = await db.select().from(items).where(eq(items.chatId, 2)).get();
assert.equal(row.title, 'none');
assert.equal(row.flag, false);
ok('column defaults applied');

// onConflictDoNothing with target
await db.insert(items).values({ id: 1, chatId: 99 }).onConflictDoNothing({ target: items.id }).run();
row = await db.select().from(items).where(eq(items.id, 1)).get();
assert.equal(row.chatId, 1); // unchanged
ok('onConflictDoNothing({target})');

// update + boolean/timestamp encoding
await db.update(items).set({ title: 'changed', flag: true, seenAt: new Date(1700000000000) })
  .where(eq(items.id, 2)).run();
row = await db.select().from(items).where(eq(items.id, 2)).get();
assert.equal(row.title, 'changed');
assert.equal(row.flag, true);
assert.equal(row.seenAt.getTime(), 1700000000000);
ok('update with Date/boolean encoding');

// orderBy + limit + offset (pruneHistory pattern)
for (let i = 0; i < 10; i++) await db.insert(items).values({ chatId: 3, title: 'm' + i }).run();
// rows 1-2 exist from earlier checks, so chatId=3 rows got ids 3..12
const last = await db.select({ id: items.id }).from(items).where(eq(items.chatId, 3))
  .orderBy(desc(items.id)).limit(1).offset(5).all();
assert.equal(last.length, 1);
assert.equal(last[0].id, 7); // 6th of the 10 newest (ids 12,11,…,7)
await db.delete(items).where(and(eq(items.chatId, 3), lt(items.id, last[0].id + 1))).run();
const left = await db.select({ id: items.id }).from(items).where(eq(items.chatId, 3)).all();
assert.equal(left.length, 5);
ok('orderBy/desc/limit/offset + delete with and()/lt()');

// projection with column refs
const proj = await db.select({ title: items.title, flag: items.flag }).from(items)
  .where(eq(items.id, 1)).get();
assert.deepEqual(proj, { title: 'hello', flag: true });
ok('projection with column refs');

// onConflictDoUpdate (bumpModel pattern)
await db.insert(counters).values({ day: '2026-10-20', key: 'k', value: 2 }).run();
await db.insert(counters).values({ day: '2026-10-20', key: 'k', value: 2 })
  .onConflictDoUpdate({ target: [counters.day, counters.key], set: { value: 5 } }).run();
row = await db.select().from(counters).where(eq(counters.key, 'k')).get();
assert.equal(row.value, 5);
ok('composite PK + onConflictDoUpdate');

// db.run raw SQL with sql.raw (bumpDaily pattern)
await db.run(sql`INSERT INTO counters (day, key, value) VALUES (${('2026-10-21')}, ${'x'}, ${1})
  ON CONFLICT (day, key) DO UPDATE SET value = value + ${3}`);
await db.run(sql`INSERT INTO counters (day, key, value) VALUES (${('2026-10-21')}, ${'x'}, ${1})
  ON CONFLICT (day, key) DO UPDATE SET value = value + ${3}`);
row = await db.select().from(counters).where(and(eq(counters.day, '2026-10-21'), eq(counters.key, 'x'))).get();
assert.equal(row.value, 4);
ok('db.run raw upsert with params');

// aggregate projections (renderStats pattern)
await db.insert(counters).values({ day: '2026-10-22', key: 'y', value: 7 }).run();
const agg = await db.select({ key: counters.key, total: sql`sum(value)` })
  .from(counters).where(gte(counters.day, '2026-10-20')).groupBy(counters.key).all();
const byKey = Object.fromEntries(agg.map((r) => [r.key, r.total]));
assert.equal(byKey.x, 4);
assert.equal(byKey.y, 7);
ok('groupBy + sql`sum()` projection');

// count over full table
const c = await db.select({ n: sql`count(*)` }).from(items).all();
assert.ok(c[0].n >= 2);
ok('sql`count(*)` projection');

// json column update via bumpModel-style upsert (composite PK target)
await db.insert(counters).values({ day: '2026-10-23', key: 'm', models: {} }).run();
row = await db.select().from(counters)
  .where(and(eq(counters.day, '2026-10-23'), eq(counters.key, 'm'))).get();
row.models = row.models || {};
row.models['gpt-x'] = (row.models['gpt-x'] || 0) + 1;
await db.insert(counters).values({ day: '2026-10-23', key: 'm', models: row.models })
  .onConflictDoUpdate({ target: [counters.day, counters.key], set: { models: row.models } }).run();
row = await db.select().from(counters)
  .where(and(eq(counters.day, '2026-10-23'), eq(counters.key, 'm'))).get();
assert.deepEqual(row.models, { 'gpt-x': 1 });
ok('json round-trip (bumpModel upsert)');

rmSync(tmp, { recursive: true, force: true });
console.log(`\nORM test passed: ${passed} checks`);
