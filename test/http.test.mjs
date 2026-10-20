// test/http.test.mjs — HTTP server + initData verification, no network
// needed (uses a fake bot token to SIGN initData, so the positive path is
// covered too). The /api/settings happy path is intentionally not hit here:
// it would call duck.ai over the network.
import { rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const tmp = path.join(os.tmpdir(), 'headless-duckapi-http-test-' + Date.now());
mkdirSync(path.join(tmp, 'web'), { recursive: true });
process.env.DATA_DIR = tmp;
const FAKE_TOKEN = '123456789:TESTTOKEN_abcdefghijklmnopqrst';

writeFileSync(path.join(tmp, 'web', 'index.html'), '<!doctype html><title>ok</title>');
copyFileSync(new URL('../web/avatar.jpg', import.meta.url), path.join(tmp, 'web', 'avatar.jpg'));

const { verifyInitData, startHttpServer } = await import('../app.js');

// --- initData verification (canonical Telegram algorithm) ---
function sign(paramsObj) {
  const params = new URLSearchParams(paramsObj);
  params.delete('hash');
  const checkString = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => k + '=' + v).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(FAKE_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  params.set('hash', hash);
  return params;
}

const goodRaw = sign({ user: JSON.stringify({ id: 42, first_name: 'Test' }), auth_date: '1700000000' }).toString();
const user = verifyInitData(goodRaw, FAKE_TOKEN);
assert.ok(user && user.id === 42 && user.first_name === 'Test');
console.log('  ✓ valid initData accepted, user parsed');

assert.equal(verifyInitData(goodRaw, '999:WRONGTOKEN_wrongwrongwrongwrong'), null);
console.log('  ✓ wrong bot token rejected');

const tampered = goodRaw.replace('auth_date=1700000000', 'auth_date=1700000001');
assert.notEqual(tampered, goodRaw); // make sure we really changed something
assert.equal(verifyInitData(tampered, FAKE_TOKEN), null);
console.log('  ✓ tampered initData rejected');

assert.equal(verifyInitData('user=%7B%22id%22%3A1%7D', FAKE_TOKEN), null); // no hash
console.log('  ✓ missing hash rejected');

// --- HTTP server: static files + /api envelope, no valid auth needed ---
const seen = [];
const server = await startHttpServer({
  port: 0, // ephemeral
  webDir: path.join(tmp, 'web'),
  onApi: async (req, res, pathname) => {
    seen.push(pathname);
    if (pathname !== '/api/settings') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, description: 'unknown endpoint' }));
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, description: 'invalid initData', error_type: 'unauthorized' }));
  },
});
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

const index = await fetch(base + '/');
assert.equal(index.status, 200);
assert.ok((await index.text()).includes('<title>ok</title>'));
console.log('  ✓ GET / serves web/index.html');

const img = await fetch(base + '/avatar.jpg');
assert.equal(img.status, 200);
assert.equal(img.headers.get('content-type'), 'image/jpeg');
console.log('  ✓ static assets served with correct mime');

const trav = await fetch(base + '/..%2f..%2fetc%2fpasswd');
assert.equal(trav.status, 403);
console.log('  ✓ path traversal blocked');

const nf = await fetch(base + '/nope.js');
assert.equal(nf.status, 404);
console.log('  ✓ missing file -> 404');

const api404 = await fetch(base + '/api/other');
assert.equal(api404.status, 404);
console.log('  ✓ unknown endpoint -> 404');

const api401 = await fetch(base + '/api/settings', { method: 'POST', body: '{}' });
assert.equal(api401.status, 401);
const env = await api401.json();
assert.equal(env.ok, false);
assert.equal(env.error_type, 'unauthorized');
console.log('  ✓ /api/settings without auth -> {ok:false} envelope');

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log('\nHTTP test passed');
