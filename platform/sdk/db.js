// db.js — 'sdk/db' compatibility layer: the exact ORM subset the cloud bot
// uses, implemented over SQLite (node:sqlite built-in on Node >= 22.5, with
// better-sqlite3 as a fallback for older runtimes).
//
// Supported surface (mirrors the platform):
//   schema.js  : table(name, cols, extra?), integer()/text(), modes
//                { boolean | timestamp | json }, .primaryKey()/.primaryKey({
//                autoIncrement }), .notNull(), .default(v|sql``), index()..on(),
//                composite primaryKey({ columns: [...] })
//   queries    : db.select([proj]).from(t).where(c).groupBy(c).orderBy(desc(c))
//                .limit(n).offset(n)  ->  .get() / .all()
//                db.insert(t).values(o).onConflictDoNothing([target]).run()
//                db.insert(t).values(o).onConflictDoUpdate({target, set}).run()
//                db.update(t).set(o).where(c).run()
//                db.delete(t).where(c).run()
//                db.run(sql`...`)                      — raw SQL, ?-params
//   operators  : eq, gte, lt, and, desc, sql``, sql.raw
//
// Column modes: boolean -> 0/1 ints; timestamp -> unix seconds (Date in/out);
// json -> TEXT with JSON.stringify/parse. Values are encoded on write and
// decoded on read, so bot code sees plain JS values exactly like in the cloud.

import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// sql template tag
// ---------------------------------------------------------------------------

// Tagged template: sql`INSERT ... VALUES (${a}, ${b})` -> {__sql, text, params}.
// Nested sql`` templates merge; sql.raw('col') inlines text without params.
export function sql(strings, ...values) {
  let text = '';
  const params = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i >= values.length) continue;
    const v = values[i];
    if (v && v.__sql) { text += v.text; params.push(...v.params); }
    else if (v && v.__raw) { text += v.text; }
    else { text += '?'; params.push(v); }
  }
  return { __sql: true, text, params };
}
sql.raw = (s) => ({ __raw: true, text: String(s) });

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

const registry = new Map(); // table name -> TableDef

class Column {
  constructor(dbName, kind, opts = {}) {
    this.dbName = dbName;          // snake_case column name in SQLite
    this.jsName = dbName;          // overwritten by table()
    this.kind = kind;              // 'integer' | 'text'
    this.mode = opts.mode || null; // 'boolean' | 'timestamp' | 'json' | null
    this.pk = false;
    this.autoinc = false;
    this.req = false;              // NOT NULL flag (field name != method name!)
    this.def;                      // undefined = no default
  }
  primaryKey(opts) {
    this.pk = true;
    if (opts && opts.autoIncrement) this.autoinc = true;
    return this;
  }
  notNull() { this.req = true; return this; }
  default(v) { this.def = v; return this; }
}

export const integer = (name, opts) => new Column(name, 'integer', opts);
export const text = (name, opts) => new Column(name, 'text', opts);

export function index(name) {
  return { __index: true, name, cols: null, on(...cols) { this.cols = cols; return this; } };
}

export function primaryKey(opts) { return { __tablePk: true, columns: (opts && opts.columns) || [] }; }

export function table(name, cols, extra) {
  if (registry.has(name)) return registry.get(name);
  const colList = Object.entries(cols).map(([jsName, col]) => {
    col.jsName = jsName;
    return col;
  });
  const def = { name, cols, colList, pkCols: [], indexes: [] };
  // Expose columns directly on the table object: eq(chats.chatId, x) — the
  // cloud code reads columns as properties of the table definition itself.
  for (const [k, v] of Object.entries(cols)) def[k] = v;
  for (const col of colList) if (col.pk) def.pkCols.push(col.dbName);
  if (extra) {
    const ex = extra(cols);
    for (const v of Object.values(ex)) {
      if (v && v.__index) def.indexes.push(v);
      else if (v && v.__tablePk && v.columns.length) def.pkCols = v.columns.map((c) => c.dbName);
    }
  }
  registry.set(name, def);
  return def;
}

// ---------------------------------------------------------------------------
// Value encoding / decoding
// ---------------------------------------------------------------------------

function encodeValue(col, v) {
  if (v === undefined || v === null) return v === undefined ? undefined : null;
  if (col && col.mode === 'boolean') return v ? 1 : 0;
  if (col && col.mode === 'timestamp') {
    if (v instanceof Date) return Math.floor(v.getTime() / 1000);
    if (typeof v === 'number') return Math.floor(v);
    return v;
  }
  if (col && col.mode === 'json') return typeof v === 'string' ? v : JSON.stringify(v);
  return v;
}

function decodeValue(col, v) {
  if (v === null || v === undefined) return v;
  if (col && col.mode === 'boolean') return !!v;
  if (col && col.mode === 'json') { try { return JSON.parse(v); } catch (e) { return v; } }
  if (col && col.mode === 'timestamp') return new Date(v * 1000);
  return v;
}

function ddlLiteral(col, v) {
  const enc = encodeValue(col, v);
  if (enc === null || enc === undefined) return 'NULL';
  if (typeof enc === 'number') return String(enc);
  if (typeof enc === 'boolean') return enc ? '1' : '0';
  return "'" + String(enc).replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export const eq = (col, value) => ({ __op: true, op: '=', col, value });
export const gte = (col, value) => ({ __op: true, op: '>=', col, value });
export const lt = (col, value) => ({ __op: true, op: '<', col, value });
export const and = (...parts) => ({ __and: true, parts: parts.filter(Boolean) });
export const desc = (col) => ({ __desc: true, col });

function condSql(c, params) {
  if (!c) return null;
  if (c.__sql) { params.push(...c.params); return '(' + c.text + ')'; }
  if (c.__op) {
    const v = encodeValue(c.col, c.value);
    params.push(v === undefined ? null : v);
    return `"${c.col.dbName}" ${c.op} ?`;
  }
  if (c.__and) {
    const inner = c.parts.map((p) => condSql(p, params)).filter(Boolean);
    return inner.length ? '(' + inner.join(' AND ') + ')' : null;
  }
  throw new Error('sdk/db: unsupported condition ' + JSON.stringify(Object.keys(c)));
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

class Query {
  constructor(kind, def) {
    this.kind = kind;   // 'select' | 'insert' | 'update' | 'delete'
    this.def = def;
    this._proj = null;
    this._where = null;
    this._groupBy = null;
    this._order = null;
    this._limit = null;
    this._offset = null;
    this._values = null;
    this._conflict = null;
    this._set = null;
  }
  // select
  select(proj) { this.kind = 'select'; this._proj = proj === undefined ? null : proj; return this; }
  from(def) { this.def = def; return this; }
  where(c) { this._where = c; return this; }
  groupBy(col) { this._groupBy = col; return this; }
  orderBy(...os) { this._order = os; return this; }
  limit(n) { this._limit = n; return this; }
  offset(n) { this._offset = n; return this; }
  // insert
  values(o) { this._values = o; return this; }
  onConflictDoNothing(o) { this._conflict = { do: 'nothing', target: o && o.target }; return this; }
  onConflictDoUpdate(o) { this._conflict = { do: 'update', target: o && o.target, set: (o && o.set) || {} }; return this; }
  // update
  set(o) { this._set = o; return this; }
  // exec
  run() { return execWrite(this); }
  get() { return execSelect(this, 'get'); }
  all() { return execSelect(this, 'all'); }
}

function colByName(def, jsName) {
  const c = def.cols[jsName];
  if (!c) throw new Error(`sdk/db: table "${def.name}" has no column "${jsName}"`);
  return c;
}

function buildSelect(q) {
  const params = [];
  const def = q.def;
  let colsSql;
  if (q._proj && typeof q._proj === 'object') {
    colsSql = Object.entries(q._proj).map(([key, v]) => {
      if (v && (v.__sql)) { params.push(...v.params); return `${v.text} AS "${key}"`; }
      if (v && v.dbName) return `"${v.dbName}" AS "${key}"`;
      throw new Error(`sdk/db: bad projection for "${key}"`);
    }).join(', ');
  } else {
    colsSql = '*';
  }
  let s = `SELECT ${colsSql} FROM "${def.name}"`;
  const w = condSql(q._where, params);
  if (w) s += ' WHERE ' + w;
  if (q._groupBy) s += ' GROUP BY "' + q._groupBy.dbName + '"';
  if (q._order && q._order.length) {
    s += ' ORDER BY ' + q._order.map((o) => {
      if (o && o.__desc) return `"${o.col.dbName}" DESC`;
      if (o && o.dbName) return `"${o.dbName}" ASC`;
      throw new Error('sdk/db: bad orderBy');
    }).join(', ');
  }
  if (q._limit !== null) s += ' LIMIT ' + Number(q._limit);
  if (q._offset !== null) s += ' OFFSET ' + Number(q._offset);
  return { text: s, params };
}

function decodeRows(def, proj, rows) {
  if (proj && typeof proj === 'object') {
    const colByKey = {};
    for (const [key, v] of Object.entries(proj)) if (v && v.dbName) colByKey[key] = v;
    return rows.map((r) => {
      const out = {};
      for (const key of Object.keys(proj)) {
        out[key] = colByKey[key] ? decodeValue(colByKey[key], r[key]) : r[key];
      }
      return out;
    });
  }
  // select() with no projection: map db names -> JS names + mode decode
  const byDb = {};
  for (const c of def.colList) byDb[c.dbName] = c;
  return rows.map((r) => {
    const out = {};
    for (const [db, val] of Object.entries(r)) {
      const c = byDb[db];
      out[c ? c.jsName : db] = c ? decodeValue(c, val) : val;
    }
    return out;
  });
}

async function execSelect(q, mode) {
  const eng = await engine();
  const { text, params } = buildSelect(q);
  const rows = eng.all(text, params);
  const decoded = decodeRows(q.def, q._proj, rows);
  return mode === 'get' ? decoded[0] : decoded;
}

function buildInsert(q) {
  const def = q.def;
  const entries = Object.entries(q._values || {}).filter(([, v]) => v !== undefined);
  const cols = entries.map(([k]) => colByName(def, k));
  const params = entries.map(([, v], i) => encodeValue(cols[i], v));
  let s = `INSERT INTO "${def.name}" (${cols.map((c) => '"' + c.dbName + '"').join(', ')}) ` +
    `VALUES (${cols.map(() => '?').join(', ')})`;
  if (q._conflict) {
    let target = q._conflict.target;
    const tCols = target ? (Array.isArray(target) ? target : [target]).map((c) => '"' + c.dbName + '"').join(', ') : null;
    s += tCols ? ` ON CONFLICT (${tCols})` : ' ON CONFLICT';
    if (q._conflict.do === 'update') {
      const setEntries = Object.entries(q._conflict.set).filter(([, v]) => v !== undefined);
      const sets = setEntries.map(([k]) => {
        const c = colByName(def, k);
        params.push(encodeValue(c, q._conflict.set[k]));
        return `"${c.dbName}" = ?`;
      });
      s += ' DO UPDATE SET ' + sets.join(', ');
    } else {
      s += ' DO NOTHING';
    }
  }
  return { text: s, params };
}

function buildUpdate(q) {
  const def = q.def;
  const params = [];
  const entries = Object.entries(q._set || {}).filter(([, v]) => v !== undefined);
  const sets = entries.map(([k, v]) => {
    const c = colByName(def, k);
    params.push(encodeValue(c, v));
    return `"${c.dbName}" = ?`;
  });
  let s = `UPDATE "${def.name}" SET ${sets.join(', ')}`;
  const w = condSql(q._where, params);
  if (w) s += ' WHERE ' + w;
  return { text: s, params };
}

function buildDelete(q) {
  const params = [];
  let s = `DELETE FROM "${q.def.name}"`;
  const w = condSql(q._where, params);
  if (w) s += ' WHERE ' + w;
  return { text: s, params };
}

async function execWrite(q) {
  const eng = await engine();
  let built;
  if (q.kind === 'insert') built = buildInsert(q);
  else if (q.kind === 'update') built = buildUpdate(q);
  else if (q.kind === 'delete') built = buildDelete(q);
  else throw new Error('sdk/db: run() on a ' + q.kind);
  const r = eng.run(built.text, built.params) || {};
  return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
}

// ---------------------------------------------------------------------------
// Public db object
// ---------------------------------------------------------------------------

export const db = {
  select(proj) { const q = new Query('select', null); q._proj = proj === undefined ? null : proj; return q; },
  insert(def) { return new Query('insert', def); },
  update(def) { return new Query('update', def); },
  delete(def) { return new Query('delete', def); },
  // Raw SQL: db.run(sql`...`) — matches the platform's db.run.
  run(stmt) {
    if (!stmt || !stmt.__sql) throw new Error('sdk/db: run() expects an sql`...` statement');
    return execRaw(stmt);
  },
  migrate,
};

async function execRaw(stmt) {
  const eng = await engine();
  const r = eng.run(stmt.text, stmt.params) || {};
  return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
}

// ---------------------------------------------------------------------------
// DDL / migration
// ---------------------------------------------------------------------------

function tableDdl(def) {
  const parts = def.colList.map((c) => {
    let s = `"${c.dbName}" ${c.kind.toUpperCase()}`;
    const singlePk = def.pkCols.length === 1 && c.pk;
    if (singlePk) {
      s += ' PRIMARY KEY';
      if (c.autoinc) s += ' AUTOINCREMENT';
    }
    if (c.req) s += ' NOT NULL';
    if (c.def !== undefined) {
      s += ' DEFAULT ' + (c.def && c.def.__sql ? c.def.text : ddlLiteral(c, c.def));
    }
    return s;
  });
  if (def.pkCols.length > 1) parts.push('PRIMARY KEY (' + def.pkCols.map((c) => '"' + c + '"').join(', ') + ')');
  return `CREATE TABLE IF NOT EXISTS "${def.name}" (${parts.join(', ')})`;
}

// Create all registered tables + indexes (CREATE ... IF NOT EXISTS). Safe to
// call on every boot; called automatically before the bot starts.
export async function migrate() {
  const eng = await engine();
  for (const def of registry.values()) eng.exec(tableDdl(def));
  for (const def of registry.values()) {
    for (const ix of def.indexes) {
      const cols = ix.cols.map((c) => '"' + c.dbName + '"').join(', ');
      eng.exec(`CREATE INDEX IF NOT EXISTS "${ix.name}" ON "${def.name}" (${cols})`);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Engine: node:sqlite (Node >= 22.5) with better-sqlite3 fallback
// ---------------------------------------------------------------------------

let eng = null;

function dbFilePath() {
  const dir = path.resolve(process.env.DATA_DIR || path.join(path.dirname(fileURLCoerce()), 'data'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'duck.db');
}

import { fileURLToPath } from 'node:url';
function fileURLCoerce() {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch (e) { return process.cwd(); }
}

async function engine() {
  if (eng) return eng;
  const file = dbFilePath();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const d = new DatabaseSync(file);
    d.exec('PRAGMA journal_mode = WAL;');
    d.exec('PRAGMA busy_timeout = 5000;');
    eng = {
      exec: (q) => d.exec(q),
      all: (q, p) => d.prepare(q).all(...(p || [])),
      get: (q, p) => d.prepare(q).get(...(p || [])),
      run: (q, p) => d.prepare(q).run(...(p || [])),
    };
  } catch (e) {
    // node:sqlite unavailable (Node < 22.5 or flag missing) -> better-sqlite3
    let BS;
    try { BS = (await import('better-sqlite3')).default; } catch (e2) { BS = null; }
    if (!BS) {
      throw new Error(
        'headless-duckapi needs SQLite: either Node.js >= 22.5 (built-in node:sqlite; on ' +
        'Node 22.x start with `node --experimental-sqlite app.js`) or the optional ' +
        'dependency better-sqlite3 installed (npm install better-sqlite3). ' +
        'Original error: ' + e.message,
      );
    }
    const d = new BS(file);
    d.pragma('journal_mode = WAL');
    d.pragma('busy_timeout = 5000');
    eng = {
      exec: (q) => d.exec(q),
      all: (q, p) => d.prepare(q).all(...(p || [])),
      get: (q, p) => d.prepare(q).get(...(p || [])),
      run: (q, p) => d.prepare(q).run(...(p || [])),
    };
  }
  return eng;
}
