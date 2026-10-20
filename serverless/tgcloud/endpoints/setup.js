// setup.js — thin wrapper over lib/botsetup.js so the bot's appearance
// (description, commands, avatar) can be applied on demand.
// Run manually via `tgcloud run endpoints/setup '{}'`; safe to re-run.
import { runSetup } from '../lib/botsetup.js';

export default async function () {
  return runSetup();
}
