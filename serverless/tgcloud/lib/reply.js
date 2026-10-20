// Streaming reply helper: ONE message progressively edited as tokens arrive,
// markdown -> Telegram HTML rendering, rollover for long texts,
// plus the persistent reply keyboard (menu buttons above the input field).
import { api } from 'sdk';

const EDIT_EVERY_MS = 1000;   // min interval between edits (snappy but rate-limit safe)
const EDIT_MIN_GROWTH = 8;    // min new chars before an edit is worth it
const MAX_MSG = 3600;         // raw text cap per message (headroom for HTML tags)

export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// duck.ai sometimes leaks internal citation tags into the stream — cut them.
export function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/<citation\b[^>]*>[\s\S]*?<\/citation>/gi, '')
    .replace(/<citation\b[^>]*\/>/gi, '')
    .replace(/<\/?(?:cite|source|subcitation)\b[^>]*>/gi, '');
}

// Markdown -> Telegram-flavoured HTML. Tolerant to markers left unclosed
// mid-stream: they get a virtual closer, so partial bold/code renders nicely.
export function mdToHtml(src) {
  let s = cleanText(src);
  s = escHtml(s);

  // Fenced code blocks first (complete pairs only; odd fence count -> virtual closer).
  if ((s.match(/```/g) || []).length % 2 === 1) s += '\n```';
  const blocks = [];
  s = s.replace(/```(\w+)?[ \t]*\n?([\s\S]*?)```/g, (m, lang, body) => {
    blocks.push('<pre>' + body + '</pre>');
    return '\x00' + (blocks.length - 1) + '\x00';
  });

  // Inline code (odd tick count -> virtual closer).
  if ((s.replace(/\x00\d+\x00/g, '').match(/`/g) || []).length % 2 === 1) s += '`';
  s = s.replace(/`([^`\n]+)`/g, (m, c) => '<code>' + c + '</code>');

  // Bold (odd ** count -> virtual closer), italic _, strike, links, headings.
  if ((s.match(/\*\*/g) || []).length % 2 === 1) s += '**';
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w\\])_([^_\n]+)_(?![\w])/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) =>
    '<a href="' + u.replace(/"/g, '%22') + '">' + t + '</a>');
  s = s.replace(/^#{1,6}[ \t]+(.+)$/gm, '<b>$1</b>');

  // Bullets and blockquotes.
  s = s.replace(/^[ \t]*\*[ \t]+/gm, '• ');
  s = s.replace(/^[ \t]*-[ \t]+/gm, '• ');
  s = s.replace(/(^|\n)((?:&gt;[^\n]*\n?)+)/g, (m, pre, block) => {
    const inner = block.split('\n').filter((l) => l !== '')
      .map((l) => l.replace(/^&gt;[ \t]?/, '')).join('\n');
    return pre + '<blockquote>' + inner + '</blockquote>';
  });

  // Restore code blocks.
  s = s.replace(/\x00(\d+)\x00/g, (m, i) => blocks[+i] || '');
  return s;
}

const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

const WEBAPP_URL = 'https://app<YOUR_APP_ID>.tgcloud.ai/'; // Mini App (web/ static folder) — replace <YOUR_APP_ID> with your app id

// Persistent menu above the input field (reply keyboard). Labels are live:
// they reflect the chat's current settings, and are refreshed after each change.
export function mainKeyboard(row) {
  const web = row && row.webSearch ? 'вкл' : 'выкл';
  const eff = (row && row.effort) || 'none';
  const effLabel = { none: 'выкл', low: 'низкий', medium: 'средний' }[eff] || eff;
  return {
    keyboard: [
      [{ text: '🤖 Модели' }, { text: '⚙️ Статус' }],
      [{ text: '🌐 Поиск: ' + web }, { text: '🧠 Размышления: ' + effLabel }],
      [{ text: '🎛 Настройки', web_app: { url: WEBAPP_URL } }],
      [{ text: '🧹 Очистить историю' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Спроси что-нибудь…',
  };
}

export class StreamReply {
  constructor(chatId) {
    this.chatId = chatId;
    this.msgId = null;        // current Telegram message id
    this.baseLen = 0;         // global offset where this message's text starts
    this.lastEditAt = 0;
    this.lastEditLen = 0;
    this.lastTypingAt = 0;
    this.lastFull = '';
    this.done = false;
    this._chain = Promise.resolve(); // serialization: one render step at a time
  }

  _typing() {
    const now = Date.now();
    if (now - this.lastTypingAt > 4000) {
      this.lastTypingAt = now;
      api.sendChatAction({ chat_id: this.chatId, action: 'typing' }).catch(() => {});
    }
  }

  _send(text, html = true) {
    const opts = Object.assign({ chat_id: this.chatId, text }, NO_PREVIEW);
    if (html) opts.parse_mode = 'HTML';
    return api.sendMessage(opts).catch((e) => {
      // Bad HTML entities -> retry as plain text rather than losing the answer.
      if (html && /parse|entities/i.test(String((e && e.description) || e))) {
        return api.sendMessage(Object.assign({ chat_id: this.chatId, text }, NO_PREVIEW));
      }
      throw e;
    });
  }

  _edit(text, html = true) {
    const opts = Object.assign({ chat_id: this.chatId, message_id: this.msgId, text }, NO_PREVIEW);
    if (html) opts.parse_mode = 'HTML';
    return api.editMessageText(opts).catch((e) => {
      if (html && /parse|entities/i.test(String((e && e.description) || e))) {
        return api.editMessageText(Object.assign({ chat_id: this.chatId, message_id: this.msgId, text }, NO_PREVIEW));
      }
      throw e;
    });
  }

  // One serialized render step. `full` is the accumulated clean-ish text.
  async _step(full, isFinal, note) {
    const text = cleanText(full);

    if (this.msgId === null) {
      if (!isFinal && text.trim().length < 2) return; // wait for a meaningful first chunk
      const suffix = isFinal && note ? '\n\n<i>' + escHtml(note) + '</i>' : '';
      try {
        const m = await this._send(mdToHtml(text.slice(0, MAX_MSG) || '…') + suffix);
        this.msgId = m.message_id;
        this.baseLen = 0;
        this.lastEditAt = Date.now();
        this.lastEditLen = text.length;
      } catch (e) {
        console.error('[reply] initial send failed:', e && e.description ? e.description : e);
      }
      return;
    }

    const now = Date.now();
    if (!isFinal && (now - this.lastEditAt < EDIT_EVERY_MS || text.length - this.lastEditLen < EDIT_MIN_GROWTH)) return;
    this.lastEditAt = now;
    this.lastEditLen = text.length;

    const chunk = text.slice(this.baseLen);
    const suffix = isFinal && note ? '\n\n<i>' + escHtml(note) + '</i>' : '';

    if (chunk.length <= MAX_MSG) {
      try { await this._edit(mdToHtml(chunk) + suffix); } catch (e) { /* throttled/not modified — final edit fixes */ }
    } else {
      // Close the current message and roll over to a fresh one.
      try { await this._edit(mdToHtml(chunk.slice(0, MAX_MSG))); } catch (e) {}
      try {
        const m = await this._send('…');
        this.msgId = m.message_id;
        this.baseLen = text.length;
        if (suffix) { try { await this._edit('…' + suffix); } catch (e) {} }
      } catch (e) {
        console.error('[reply] rollover failed:', e && e.description ? e.description : e);
      }
    }
  }

  // Called by duckai's chat() on every delta (synchronously, without await —
  // steps are serialized through the chain, so no double-send races).
  push(delta, full) {
    if (this.done) return;
    this.lastFull = full;
    if (this.msgId === null) this._typing();
    this._chain = this._chain.then(() => this._step(full, false)).catch(() => {});
  }

  // Final edit with the complete text (plus an optional note, e.g. model tag).
  async finish(full, note = '') {
    if (this.done) return;
    this.done = true;
    this._chain = this._chain.then(() => this._step(full, true, note)).catch(() => {});
    await this._chain;
  }

  // Replace/edit whatever we have with a friendly error line.
  async fail(err) {
    if (this.done) return;
    this.done = true;
    const line = '⚠️ ' + escHtml(friendlyError(err));
    this._chain = this._chain.then(async () => {
      if (this.msgId === null) {
        try { await this._send(line, false); } catch (e) {}
        return;
      }
      const chunk = cleanText(this.lastFull || '').slice(this.baseLen).slice(0, MAX_MSG);
      const text = chunk ? mdToHtml(chunk) + '\n\n' + line : line;
      try { await this._edit(text); } catch (e) {}
    }).catch(() => {});
    await this._chain;
  }
}

export function friendlyError(err) {
  const s = String(err && err.message ? err.message : err);
  if (/HTTP 418/.test(s)) return 'duck.ai временно не принял запрос (антибот-челлендж). Попробуй ещё раз через минуту.';
  if (/HTTP 429/.test(s)) return 'Слишком много запросов к duck.ai — немного подожди и повтори.';
  if (/HTTP 40[0-9]/.test(s)) return 'duck.ai отклонил запрос: ' + s.slice(0, 200);
  if (/HTTP 5\d\d/.test(s)) return 'duck.ai вернул серверную ошибку: ' + s.slice(0, 200);
  if (err && err.description) return 'Telegram: ' + err.description;
  return s.slice(0, 300);
}
