import type { Env } from './types';

const API_BASE = 'https://api.telegram.org/bot';

async function call(
  env: Env,
  method: string,
  payload: Record<string, unknown>
): Promise<any> {
  if (!env.BOT_TOKEN) {
    console.error(`[TELEGRAM] BOT_TOKEN is missing`);
    return {
      ok: false,
      error_code: 500,
      description: 'BOT_TOKEN is missing',
    };
  }

  const token = String(env.BOT_TOKEN).trim();

  console.log(
    `[TELEGRAM] Calling ${method} with token length=${token.length}`
  );

  try {
    const res = await fetch(`${API_BASE}${token}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!data.ok) {
      console.error(
        `[TELEGRAM] API ERROR method=${method} http=${res.status}`,
        JSON.stringify(data)
      );
    } else {
      console.log(
        `[TELEGRAM] SUCCESS method=${method} http=${res.status}`
      );
    }

    return data;
  } catch (error) {
    console.error(
      `[TELEGRAM] FETCH ERROR method=${method}`,
      error
    );

    return {
      ok: false,
      error_code: 500,
      description: 'Telegram fetch failed',
    };
  }
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export function kb(rows: InlineButton[][]) {
  return {
    inline_keyboard: rows,
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendMessage(
  env: Env,
  chatId: number | string,
  text: string,
  replyMarkup?: unknown
) {
  return call(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function editMessageText(
  env: Env,
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: unknown
) {
  return call(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup ?? {
      inline_keyboard: [],
    },
  });
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
  showAlert = false
) {
  return call(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

export async function getChatMember(
  env: Env,
  chatId: number,
  userId: number
) {
  return call(env, 'getChatMember', {
    chat_id: chatId,
    user_id: userId,
  });
    }    reply_markup: replyMarkup,
  });
}

export async function editMessageText(
  env: Env,
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: unknown
) {
  return call(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  });
}

export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
  showAlert = false
) {
  return call(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

export async function getChatMember(env: Env, chatId: number, userId: number) {
  return call(env, 'getChatMember', { chat_id: chatId, user_id: userId });
                  }
