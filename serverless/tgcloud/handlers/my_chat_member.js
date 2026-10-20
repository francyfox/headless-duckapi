// my_chat_member handler: tracks when the bot is added to (or removed from)
// groups, so /stats can show how the bot spreads through group sources.
// The update payload is ChatMemberUpdated: { chat, from, old_chat_member,
// new_chat_member, ... }.
import { touchUser } from '../lib/metrics.js';

export default async function (mcm) {
  if (!mcm || !mcm.chat) return;
  const chat = mcm.chat;
  const status = mcm.new_chat_member && mcm.new_chat_member.status;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';

  try {
    if (isGroup && (status === 'member' || status === 'administrator')) {
      // Bot was added to a group — register it as a group "user".
      await touchUser(
        { id: chat.id, title: chat.title, username: chat.username },
        { isGroup: true, chatId: chat.id, title: chat.title, source: 'group' },
      );
    } else if (isGroup && status === 'left' && mcm.from && mcm.from.id) {
      // Added-by info: whoever performed the change (e.g. an admin adding the
      // bot) is worth touching so their source shows up even if the add
      // event raced with this handler.
      await touchUser(mcm.from, { source: 'group' });
    }
  } catch (e) { /* metrics must never break the bot */ }
}
