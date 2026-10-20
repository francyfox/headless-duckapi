#!/usr/bin/env node
// app.js — headless-duckapi entrypoint: long-polling Telegram bot + Mini App host.
//
// Self-hosted port of the Telegram Serverless duck.ai bot. The bot code in
// bot/ is the cloud code (byte-compatible) running on top of the thin 'sdk'
// compatibility layer (platform/sdk): api -> Bot API over HTTPS,
// db -> SQLite, fetch -> global fetch.
//
// What it does:
//   1. loads .env (env.js)
//   2. opens SQLite (DATA_DIR, default ./data) and migrates the schema
//   3. starts an HTTP server: serves web/ (the Mini App) and POST /api/settings
//      (verified initData, same envelope the cloud platform uses)
//   4. switches the bot to long polling (deleteWebhook first), dispatches
//      updates to bot/handlers/* — concurrent across chats, serialized per chat
//
// CLI:  node app.js            — run the bot
//       node app.js setup      — apply bot appearance (description, commands,
//                                menu button, avatar) and exit
//       node app.js config [list|get <k>|set <k> <v>|del <k>]
//                              — manage the config table overrides

import './env.js';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Verify Telegram Mini App initData (HMAC-SHA256, key "WebAppData" -> bot token).
// Returns the parsed user object, or null when the signature is bad.
export function verifyInitData(rawInitData, botToken) {
  try {
    if (!rawInitData || !botToken) return null;
    const params = new URLSearchParams(rawInitData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const checkString = [...params.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => k + '=' + v).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = createHmac('sha256', secret).update(checkString).digest('hex');
    if (calc !== hash) return null;
    const u = params.get('user');
    return u ? JSON.parse(u) : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP: Mini App static + /api/settings
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function startHttpServer({ port, webDir, onApi }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith('/api/')) return await onApi(req, res, pathname);

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { ok: false, description: 'method not allowed' });
      }
      let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = path.resolve(webDir, rel);
      if (!file.startsWith(path.resolve(webDir) + path.sep) && file !== path.resolve(webDir)) {
        return json(res, 403, { ok: false, description: 'forbidden' });
      }
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) return json(res, 404, { ok: false, description: 'not found' });
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      try { json(res, 500, { ok: false, description: 'internal error' }); } catch (e2) { /* head sent */ }
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// update dispatch: concurrent across chats, serialized within one chat
// ---------------------------------------------------------------------------

let HANDLERS = null; // { message, callback_query, my_chat_member }
const chains = new Map(); // chat id -> promise tail

export function dispatch(update) {
  if (!HANDLERS) return;
  let type = null;
  let item = null;
  if (update.message) { type = 'message'; item = update.message; }
  else if (update.callback_query) { type = 'callback_query'; item = update.callback_query; }
  else if (update.my_chat_member) { type = 'my_chat_member'; item = update.my_chat_member; }
  if (!type) return;

  const key = (item.chat && item.chat.id) || (item.from && item.from.id) || 0;
  const prev = chains.get(key) || Promise.resolve();
  const next = prev
    .then(() => HANDLERS[type](item))
    .catch((e) => console.error('[' + type + '] handler failed:', (e && e.message) || e));
  chains.set(key, next.finally(() => { if (chains.get(key) === next) chains.delete(key); }));
}

async function pollLoop() {
  let offset = 0;
  let running = true;
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  let shuttingDown = false;
  function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('received', sig, '— shutting down…');
    running = false;
    setTimeout(() => process.exit(0), 1500).unref();
  }

  log('long polling started');
  while (running) {
    let updates = null;
    try {
      updates = await api.getUpdates({
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      });
    } catch (e) {
      const msg = String((e && e.description) || (e && e.message) || e);
      if (/409|Conflict|terminated by other/i.test(msg)) {
        console.error('getUpdates conflict: another getUpdates/webhook instance is running ' +
          '(is the Serverless copy of this bot still deployed?). Retrying in 15s…');
        await sleep(15000);
        continue;
      }
      console.error('getUpdates failed:', msg, '— retrying in 5s');
      await sleep(5000);
      continue;
    }
    if (!running) break;
    for (const u of updates || []) {
      offset = u.update_id + 1;
      dispatch(u);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI subcommands
// ---------------------------------------------------------------------------

async function cliConfig(args) {
  const { db } = await import('sdk');
  const { config } = await import('./bot/schema.js');
  const { eq } = await import('sdk/db');
  const sub = args[0] || 'list';
  if (sub === 'list') {
    const rows = await db.select().from(config).all();
    if (!rows.length) return log('(config table is empty)');
    for (const r of rows) log(r.key, '=', r.value === null ? '(null)' : r.value);
    return;
  }
  if (sub === 'get') {
    const row = await db.select().from(config).where(eq(config.key, args[1])).get();
    return log(row ? (row.key + ' = ' + row.value) : '(not set)');
  }
  if (sub === 'set') {
    if (args.length < 3) throw new Error('usage: node app.js config set <key> <value>');
    await db.delete(config).where(eq(config.key, args[1])).run();
    await db.insert(config).values({ key: args[1], value: args[2] }).run();
    return log('ok:', args[1], '=', args[2]);
  }
  if (sub === 'del') {
    await db.delete(config).where(eq(config.key, args[1])).run();
    return log('ok: deleted', args[1]);
  }
  throw new Error('usage: node app.js config [list|get <k>|set <k> <v>|del <k>]');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || '';

  // Import bot modules (registers schema tables as a side effect).
  await import('./bot/schema.js');
  const { db, migrate } = await import('sdk/db');
  const { api } = await import('sdk');

  // DB: open + migrate before anything touches the tables.
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));
  process.env.DATA_DIR = dataDir; // engine reads it lazily — pin the resolved path
  await migrate();
  log('sqlite ready at', path.join(dataDir, 'duck.db'));

  // CLI helpers that only need the DB.
  if (cmd === 'config') return cliConfig(argv.slice(1));

  // Everything below needs a bot token.
  const token = process.env.BOT_TOKEN;
  if (!token || !/^\d+:[\w-]{20,}$/.test(token)) {
    console.error('BOT_TOKEN is missing or malformed. Copy .env.example to .env and paste the\n' +
      'token from @BotFather (your bot -> API Token).');
    process.exit(1);
  }

  const { runSetup } = await import('./bot/lib/botsetup.js');
  const me = await api.getMe({}).catch((e) => {
    console.error('Telegram auth failed:', (e && e.description) || (e && e.message) || e);
    console.error('Check BOT_TOKEN in .env (BotFather -> your bot -> API Token).');
    process.exit(1);
  });
  log('authorized as @' + me.username + ' (id ' + me.id + ')');

  if (cmd === 'setup') {
    const report = await runSetup();
    log('setup report:', JSON.stringify(report, null, 2));
    return;
  }
  if (cmd && cmd !== 'run') throw new Error('unknown command: ' + cmd + ' (use: node app.js [setup|config …])');

  // Mini App / API HTTP server.
  const port = parseInt(process.env.PORT || '8080', 10) || 8080;
  const { default: settingsEndpoint } = await import('./bot/endpoints/settings.js');
  const server = await startHttpServer({
    port,
    webDir: path.join(here, 'web'),
    onApi: async (req, res, pathname) => {
      if (pathname !== '/api/settings') return json(res, 404, { ok: false, description: 'unknown endpoint' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, description: 'POST required' });
      const m = String(req.headers['authorization'] || '').match(/^TMA\s+(.+)$/i);
      if (!m) return json(res, 401, { ok: false, description: 'TMA Authorization header required', error_type: 'unauthorized' });
      const raw = Buffer.from(m[1], 'base64').toString('utf8');
      const user = verifyInitData(raw, token);
      if (!user || !user.id) return json(res, 401, { ok: false, description: 'invalid initData', error_type: 'unauthorized' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let input = {};
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {
        return json(res, 400, { ok: false, description: 'bad json body' });
      }
      try {
        const result = await settingsEndpoint(input, { initData: { user } });
        return json(res, 200, { ok: true, result });
      } catch (e) {
        return json(res, 500, { ok: false, description: String((e && e.message) || e).slice(0, 200), error_type: 'internal' });
      }
    },
  });
  log('mini app + api listening on http://0.0.0.0:' + port);

  // Switch from webhook (the Serverless deployment) to long polling.
  try {
    await api.deleteWebhook({ drop_pending_updates: false });
    log('webhook deleted (cloud copy will not receive updates until re-deployed)');
  } catch (e) { /* never set — fine */ }

  // First boot on a fresh DB: apply the bot appearance once (description,
  // commands, menu button, avatar). Same result as `node app.js setup`.
  const { config } = await import('./bot/schema.js');
  const { eq } = await import('sdk/db');
  const flag = await db.select().from(config).where(eq(config.key, 'vps_setup_done')).get();
  if (!flag) {
    const report = await runSetup().catch((e) => ({ error: String((e && e.message) || e) }));
    log('one-shot setup:', JSON.stringify(report));
    await db.delete(config).where(eq(config.key, 'vps_setup_done')).run();
    await db.insert(config).values({ key: 'vps_setup_done', value: new Date().toISOString() }).run();
  }

  // Load update handlers, then poll forever.
  const [message, callbackQuery, myChatMember] = await Promise.all([
    import('./bot/handlers/message.js'),
    import('./bot/handlers/callback_query.js'),
    import('./bot/handlers/my_chat_member.js'),
  ]);
  HANDLERS = {
    message: message.default,
    callback_query: callbackQuery.default,
    my_chat_member: myChatMember.default,
  };
  await pollLoop();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error('fatal:', (e && e.stack) || e);
    process.exit(1);
  });
}
