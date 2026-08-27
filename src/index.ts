import type { Env } from './types';

export { GameRoom } from './durable/GameRoom';

function getRoomStub(env: Env, chatId: number) {
  const id = env.GAME_ROOM.idFromName(String(chatId));
  return env.GAME_ROOM.get(id);
}

async function callRoom(env: Env, chatId: number, path: string, body: unknown) {
  const stub = getRoomStub(env, chatId);
  return stub.fetch(`https://game-room${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fullName(from: any): string {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'بازیکن';
}

async function handleUpdate(update: any, env: Env) {
  if (update.message) {
    const msg = update.message;
    const chat = msg.chat;
    const from = msg.from;
    const text: string | undefined = msg.text;

    if (chat.type === 'private') {
      if (text?.startsWith('/start')) {
        const payload = text.split(' ')[1] ?? '';
        if (payload.startsWith('join_')) {
          const chatId = Number(payload.replace('join_', ''));
          if (Number.isFinite(chatId)) {
            await callRoom(env, chatId, '/dm-start', { userId: from.id, userName: fullName(from) });
          }
        }
        return;
      }
      const activeChatId = await env.REGISTRY.get(`user:${from.id}`);
      if (activeChatId) {
        await callRoom(env, Number(activeChatId), '/dm-message', { userId: from.id, text: text ?? '' });
      }
      return;
    }

    if (chat.type === 'group' || chat.type === 'supergroup') {
      const lowered = text?.toLowerCase() ?? '';
      if (lowered.startsWith('/smile')) {
        await callRoom(env, chat.id, '/start-game-flow', {
          chatId: chat.id,
          userId: from.id,
          userName: fullName(from),
        });
      } else if (lowered.startsWith('/cancel')) {
        await callRoom(env, chat.id, '/cancel', { userId: from.id });
      }
    }
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chat = cq.message?.chat;
    if (!chat) return;
    await callRoom(env, chat.id, '/callback', {
      data: cq.data,
      userId: cq.from.id,
      userName: fullName(cq.from),
      callbackQueryId: cq.id,
    });
  }
}

async function runTick(env: Env) {
  const list = await env.REGISTRY.list({ prefix: 'active:' });
  for (const key of list.keys) {
    const chatId = Number(key.name.replace('active:', ''));
    if (!Number.isFinite(chatId)) continue;
    await callRoom(env, chatId, '/tick', {});
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/webhook') {
      if (env.WEBHOOK_SECRET) {
        const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (secret !== env.WEBHOOK_SECRET) {
          return new Response('unauthorized', { status: 401 });
        }
      }
      const update = await request.json<any>();
      ctx.waitUntil(handleUpdate(update, env));
      return new Response('ok');
    }

    return new Response('smile game bot is running', { status: 200 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runTick(env));
  },
};
