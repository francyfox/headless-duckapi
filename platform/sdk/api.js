// api.js — Telegram Bot API client behind the cloud platform's `api` object.
//
// The bot code calls methods like api.sendMessage({...}) / api.sendPhoto({...})
// / api.editMessageText({...}) and reads e.message_id / e.description off the
// results and errors. This shim maps any method name straight to the Bot API
// method of the same name, so every current and future method just works.
//
// InputFile values (possibly nested inside params, e.g. Bot API 9.x
// setMyProfilePhoto's InputProfilePhoto) are uploaded as multipart parts and
// referenced via attach:// — the standard Bot API file-upload convention.

const API_BASE = 'https://api.telegram.org';

export class InputFile {
  // data: Uint8Array | Buffer; filename; opts.type = MIME type
  constructor(data, filename, opts = {}) {
    this.data = data;
    this.filename = filename || 'file';
    this.type = opts.type || 'application/octet-stream';
  }
}

export const fetch = (...args) => globalThis.fetch(...args);

function getToken() {
  const t = process.env.BOT_TOKEN;
  if (!t) throw new Error('BOT_TOKEN is not set');
  return t;
}

// Deep-walk params; replace every InputFile with an attach://N reference and
// collect the files in order. Returns a JSON-serializable params object.
function extractFiles(value, files) {
  if (value instanceof InputFile) {
    files.push(value);
    return 'attach://file' + (files.length - 1);
  }
  if (Array.isArray(value)) return value.map((v) => extractFiles(v, files));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = extractFiles(v, files);
    return out;
  }
  return value;
}

async function call(method, params) {
  const token = getToken();
  const files = [];
  const clean = extractFiles(params || {}, files);

  let res;
  if (files.length > 0) {
    // Multipart upload: every top-level param becomes a form field (objects
    // are JSON-serialized strings, like reply_markup / InputMedia do), files
    // are attached as binary parts named file0..fileN.
    const fd = new FormData();
    for (const [k, v] of Object.entries(clean)) {
      fd.append(k, v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    files.forEach((f, i) => {
      const bytes = f.data instanceof Uint8Array ? f.data : Buffer.from(String(f.data));
      fd.append('file' + i, new Blob([bytes], { type: f.type }), f.filename);
    });
    res = await fetch(`${API_BASE}/bot${token}/${method}`, { method: 'POST', body: fd });
  } else {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(clean),
    });
  }

  let data;
  try { data = await res.json(); } catch (e) {
    throw Object.assign(new Error('Telegram API: bad JSON response (HTTP ' + res.status + ')'), {
      description: 'bad json response', error_code: res.status,
    });
  }
  if (data && data.ok) return data.result;
  const desc = (data && data.description) || 'HTTP ' + res.status;
  throw Object.assign(new Error(desc), {
    description: desc,
    error_code: data && data.error_code,
    parameters: data && data.parameters,
  });
}

// Convenience used by the bot for photo vision: getFile + download -> bytes.
export async function getFileContent(fileId) {
  const info = await api.getFile({ file_id: fileId });
  if (!info || !info.file_path) throw new Error('getFile: no file_path in response');
  const res = await fetch(`${API_BASE}/file/bot${getToken()}/${info.file_path}`);
  if (!res.ok) throw new Error('file download HTTP ' + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

export const api = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop !== 'string') return undefined;
    if (prop === 'getFileContent') return getFileContent;
    return (params) => call(prop, params);
  },
});
