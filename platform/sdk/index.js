// index.js — the 'sdk' module surface, as the Telegram Serverless platform
// provides it to bot code. This Node implementation keeps the cloud bot code
// byte-compatible: handlers import { api, db, fetch, InputFile } from 'sdk'.
export { api, InputFile, getFileContent, fetch } from './api.js';
export { db } from './db.js';
