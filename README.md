# Telegram Roleplay Bot — Cloudflare Worker

## What this bot does

- `/role` starts a 24-hour lobby in a group.
- The user who runs `/role` is the narrator.
- Players join with `پایه‌ام`.
- `شروع` is narrator-only and requires at least 2 players.
- `لفت` removes a player; narrator using it cancels the whole lobby.
- During the game, the narrator chooses the next player in private chat.
- The selected player submits one Telegram message as their role.
- Narrator approves or rejects it. Rejected roles can be resubmitted repeatedly.
- After approval, narrator submits the response.
- The role + narrator response are published to the group.
- Narrator is asked whether somebody was eliminated.
- `/antirole` cancels an active game.
- `/finish` ends an active game and lists survivors/eliminated players.
- Only one active game is allowed per group.
- Lobby expires after 24 hours.

## Important Telegram limitation

A bot cannot silently send `/start` into a user's private chat on the user's behalf.

The `پایه‌ام` button therefore opens the bot's private chat using a deep link. The user must tap **Start** once. After that, the bot can send private messages to that user.

The bot also keeps the player's join state in KV, so after `/start` the player can return to the group and press `پایه‌ام`.

## Cloudflare setup

1. Create a Cloudflare Worker.
2. Create a KV namespace.
3. Put its namespace ID into `wrangler.toml`.
4. Install dependencies:
   `npm install`
5. Authenticate:
   `npx wrangler login`
6. Set secrets:
   `npx wrangler secret put BOT_TOKEN`
   `npx wrangler secret put BOT_USERNAME`
   `npx wrangler secret put WEBHOOK_SECRET`
7. Deploy:
   `npm run deploy`
8. Set Telegram webhook:

   `https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR-WORKER.workers.dev/webhook/<WEBHOOK_SECRET>`

9. Add the bot to the group. For reliable group commands and member-related behavior, make it an administrator.

## Variables

### Secret: BOT_TOKEN
The token from BotFather.

Example:
`123456789:AA...`

### Secret: BOT_USERNAME
The bot username without `@`.

Example:
`MyRoleBot`

### Secret: WEBHOOK_SECRET
Any long random string. It is used to make the webhook URL hard to guess.

### KV binding
`ROLE_KV` must point to the KV namespace configured in `wrangler.toml`.

## Notes

- Telegram message text has a practical limit; the bot rejects role/response text that is too long for a normal Telegram message.
- Callback buttons use compact IDs, while the actual game state is stored in KV.
- The bot does not attempt to enumerate all Telegram group members. Players are discovered when they interact with the lobby, which is the reliable approach for this flow.
