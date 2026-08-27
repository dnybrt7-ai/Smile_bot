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
};  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'بازیکن';
}

async function handleUpdate(update: any, env: Env) {
  console.log('[HANDLE_UPDATE] START');

  try {
    if (update.message) {
      const msg = update.message;
      const chat = msg.chat;
      const from = msg.from;
      const text: string | undefined = msg.text;

      console.log(
        `[MESSAGE] chatType=${chat.type} chatId=${chat.id} text=${text ?? '(no text)'}`
      );

      if (chat.type === 'private') {
        if (text?.startsWith('/start')) {
          console.log('[PRIVATE] /start detected');

          const payload = text.split(' ')[1] ?? '';

          if (payload.startsWith('join_')) {
            const chatId = Number(payload.replace('join_', ''));

            if (Number.isFinite(chatId)) {
              console.log(
                `[PRIVATE] Calling /dm-start for chatId=${chatId}`
              );

              await callRoom(env, chatId, '/dm-start', {
                userId: from.id,
                userName: fullName(from),
              });
            }
          }

          return;
        }

        // پیام معمولی در پیوی = جواب یک دور در حال جمع‌آوری،
        // اگر کاربر در بازی‌ای فعال باشد
        const activeChatId = await env.REGISTRY.get(`user:${from.id}`);

        if (activeChatId) {
          console.log(
            `[PRIVATE] Calling /dm-message activeChatId=${activeChatId}`
          );

          await callRoom(env, Number(activeChatId), '/dm-message', {
            userId: from.id,
            text: text ?? '',
          });
        }

        return;
      }

      if (chat.type === 'group' || chat.type === 'supergroup') {
        const lowered = text?.toLowerCase() ?? '';

        console.log(
          `[GROUP] command=${lowered || '(empty)'} chatId=${chat.id}`
        );

        if (lowered.startsWith('/smile')) {
          console.log(
            `[SMILE] DETECTED chatId=${chat.id} userId=${from.id} userName=${fullName(from)}`
          );

          console.log(
            `[SMILE] Calling GameRoom /start-game-flow...`
          );

          const response = await callRoom(
            env,
            chat.id,
            '/start-game-flow',
            {
              chatId: chat.id,
              userId: from.id,
              userName: fullName(from),
            }
          );

          console.log(
            `[SMILE] /start-game-flow FINISHED status=${response.status}`
          );

          return;
        }

        if (lowered.startsWith('/cancel')) {
          console.log(
            `[CANCEL] DETECTED chatId=${chat.id} userId=${from.id}`
          );

          await callRoom(env, chat.id, '/cancel', {
            userId: from.id,
          });

          return;
        }
      }

      return;
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      const chat = cq.message?.chat;

      if (!chat) {
        console.log('[CALLBACK] No chat found');
        return;
      }

      console.log(
        `[CALLBACK] data=${cq.data} chatId=${chat.id} userId=${cq.from.id}`
      );

      await callRoom(env, chat.id, '/callback', {
        data: cq.data,
        userId: cq.from.id,
        userName: fullName(cq.from),
        callbackQueryId: cq.id,
      });

      return;
    }

    console.log('[HANDLE_UPDATE] Unknown update type');
  } catch (error) {
    console.error('[HANDLE_UPDATE] ERROR', error);
    throw error;
  }
}

async function runTick(env: Env) {
  console.log('[TICK] START');

  try {
    const list = await env.REGISTRY.list({ prefix: 'active:' });

    console.log(`[TICK] Active rooms=${list.keys.length}`);

    for (const key of list.keys) {
      const chatId = Number(key.name.replace('active:', ''));

      if (!Number.isFinite(chatId)) {
        console.log(`[TICK] Invalid chatId from key=${key.name}`);
        continue;
      }

      console.log(`[TICK] Calling /tick chatId=${chatId}`);

      await callRoom(env, chatId, '/tick', {});
    }

    console.log('[TICK] FINISHED');
  } catch (error) {
    console.error('[TICK] ERROR', error);
    throw error;
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    console.log(
      `[FETCH] ${request.method} ${url.pathname}`
    );

    if (url.pathname === '/webhook') {
      console.log('[WEBHOOK] Request received');

      if (env.WEBHOOK_SECRET) {
        const secret = request.headers.get(
          'X-Telegram-Bot-Api-Secret-Token'
        );

        if (secret !== env.WEBHOOK_SECRET) {
          console.log('[WEBHOOK] Invalid secret');
          return new Response('unauthorized', { status: 401 });
        }
      }

      const update = await request.json<any>();

      console.log('[WEBHOOK] Telegram update parsed');

      ctx.waitUntil(
        handleUpdate(update, env).catch((error) => {
          console.error('[WEBHOOK] handleUpdate FAILED', error);
        })
      );

      console.log('[WEBHOOK] Returning 200 to Telegram');

      return new Response('ok');
    }

    return new Response('smile game bot is running', {
      status: 200,
    });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    console.log('[SCHEDULED] Tick started');

    ctx.waitUntil(
      runTick(env).catch((error) => {
        console.error('[SCHEDULED] runTick FAILED', error);
      })
    );
  },
};          }
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
