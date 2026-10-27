# serverless/ — the original Telegram Serverless project

This folder is the **original cloud project**, byte-identical to what is
deployed on the Telegram Serverless platform (`app<YOUR_APP_ID>.tgcloud.ai`).
The VPS build in `bot/` is derived from it — the only two differences are
marked with `[VPS port patch]` comments (`lib/reply.js`, `lib/metrics.js`).

## Deploy to Telegram Serverless (optional)

The bot can run **without any VPS at all** — Telegram hosts it for free
inside their cloud. If you want this variant instead of (or next to) the
VPS one:

```bash
cd serverless
npm install                 # installs @tgcloud/cli

# 1. Link the CLI to your bot (asks for the bot's CLI token):
npx tgcloud login
#    BotFather -> your bot -> Serverless -> CLI Access -> Access token

# 2. Deploy the code and the Mini App (web/):
npx tgcloud push

# 3. Create/upgrade the database tables:
npx tgcloud migrate --safe
```

Or do it non-interactively:

```bash
TGCLOUD_TOKEN="app<id>:<secret>" npx tgcloud push
TGCLOUD_TOKEN="app<id>:<secret>" npx tgcloud migrate --safe
```

Notes:

- The Mini App URL (`lib/reply.js -> WEBAPP_URL`) points to
  `https://app<id>.tgcloud.ai/` in this build — replace the app id with yours.
- `/stats` admins: `lib/metrics.js -> DEFAULT_ADMIN_IDS` — put your own
  Telegram user id there.
- Run either the Serverless copy **or** the VPS copy on the same bot token,
  not both at once: a bot token has a single webhook. The VPS build calls
  `setWebhook` (or `deleteWebhook` in polling mode) on boot, so the last one
  started wins.
