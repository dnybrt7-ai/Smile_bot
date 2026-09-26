const MAX_TG_TEXT = 4096;
const LOBBY_TTL = 24 * 60 * 60;
const GAME_TTL = 7 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Telegram Roleplay Bot is running.", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response("OK");
      } catch (err) {
        console.error(err);
        return new Response("OK");
      }
    }

    return new Response("Not found", { status: 404 });
  }
};

async function handleUpdate(update, env) {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const user = msg.from;

  if (msg.chat.type === "private") {
    await handlePrivateMessage(msg, env);
    return;
  }

  const text = (msg.text || "").trim();

  if (text === "/role" || text.startsWith("/role@")) {
    await startLobby(msg, env);
    return;
  }

  if (text === "/antirole" || text.startsWith("/antirole@")) {
    await cancelGame(msg, env);
    return;
  }

  if (text === "/finish" || text.startsWith("/finish@")) {
    await finishGame(msg, env);
    return;
  }

  const state = await getState(env, chatId);
  if (state?.active && state.phase === "WAITING_PLAYER_TEXT" &&
      state.currentPlayerId === user.id) {
    // Player should write the role in private chat, not the group.
    return;
  }
}

async function handlePrivateMessage(msg, env) {
  const user = msg.from;
  const text = (msg.text || "").trim();

  if (text === "/start" || text.startsWith("/start ")) {
    await rememberUser(env, user);
    await tg(env, "sendMessage", {
      chat_id: user.id,
      text: "ثبت شدی. حالا می‌تونی به گروه برگردی و روی «پایه‌ام» بزنی."
    });
    return;
  }

  const states = await findStatesForUser(env, user.id);
  for (const item of states) {
    const state = item.state;
    if (!state?.active) continue;

    if (state.narratorId === user.id) {
      if (state.phase === "WAITING_REJECT_REASON") {
        if (!text) return;
        state.phase = "WAITING_PLAYER_TEXT";
        state.rejectReason = text;
        await saveState(env, state, GAME_TTL);
        await tg(env, "sendMessage", {
          chat_id: state.currentPlayerId,
          text: `رول شما به دلیل زیر رد شد:\n\n${text}\n\nرول خود را اصلاح کنید.`
        });
        await tg(env, "sendMessage", {
          chat_id: user.id,
          text: "دریافت شد."
        });
        return;
      }

      if (state.phase === "WAITING_NARRATOR_RESPONSE") {
        if (!text) return;
        state.pendingResponse = text;
        await publishApprovedRole(state, env);
        return;
      }

      return;
    }

    if (state.currentPlayerId === user.id && state.phase === "WAITING_PLAYER_TEXT") {
      if (!text) return;
      if (text.length > MAX_TG_TEXT) {
        await tg(env, "sendMessage", {
          chat_id: user.id,
          text: `رول باید در یک پیام تلگرام جا شود و حداکثر ${MAX_TG_TEXT} کاراکتر باشد.`
        });
        return;
      }

      state.pendingRole = text;
      state.phase = "WAITING_NARRATOR_DECISION";
      await saveState(env, state, GAME_TTL);

      await tg(env, "sendMessage", {
        chat_id: user.id,
        text: "رول دریافت شد."
      });

      await tg(env, "sendMessage", {
        chat_id: state.narratorId,
        text: `رول ${displayName(state, user.id)}:\n\n${text}\n\nاین رول تاییده یا رد؟`,
        reply_markup: {
          inline_keyboard: [[
            { text: "تایید", callback_data: `r:ok:${state.chatId}` },
            { text: "رد", callback_data: `r:no:${state.chatId}` }
          ]]
        }
      });
      return;
    }
  }
}

async function startLobby(msg, env) {
  const chatId = msg.chat.id;
  const narrator = msg.from;

  const existing = await getState(env, chatId);
  if (existing?.active) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "در این گروه یک رول در حال اجراست. اول آن را با /antirole یا /finish ببندید."
    });
    return;
  }

  const known = await isKnownUser(env, narrator.id);
  if (!known) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "قبل از استفاده از /role باید یک‌بار ربات را در پیوی استارت کرده باشی."
    });
    return;
  }

  const state = {
    active: true,
    phase: "LOBBY",
    chatId,
    chatTitle: msg.chat.title || "گروه",
    narratorId: narrator.id,
    narratorName: nameOf(narrator),
    players: [],
    eliminated: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + LOBBY_TTL * 1000
  };

  await saveState(env, state, LOBBY_TTL);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `برای شرکت در سناریو، پایه‌ام را بزنید\n\nبازیکنان:\n—`,
    reply_markup: lobbyKeyboard()
  });
}

function lobbyKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "پایه‌ام", callback_data: "l:join" },
        { text: "شروع", callback_data: "l:start" },
        { text: "لفت", callback_data: "l:leave" }
      ]
    ]
  };
}

async function handleCallback(q, env) {
  q._env = env;
  const data = q.data || "";
  const user = q.from;

  if (data === "l:join" || data === "l:start" || data === "l:leave") {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;
    const state = await getState(env, chatId);

    if (!state?.active || state.phase !== "LOBBY") {
      await answer(q, "این لابی دیگر فعال نیست.");
      return;
    }

    if (Date.now() > state.expiresAt) {
      await deleteState(env, chatId);
      await answer(q, "زمان این لابی تمام شده.");
      return;
    }

    if (data === "l:join") {
      await joinLobby(q, state, env);
      return;
    }

    if (data === "l:leave") {
      await leaveLobby(q, state, env);
      return;
    }

    if (data === "l:start") {
      await startGame(q, state, env);
      return;
    }
  }

  if (data.startsWith("r:")) {
    const [, action, chatIdRaw] = data.split(":");
    const chatId = Number(chatIdRaw);
    const state = await getState(env, chatId);
    if (!state?.active) {
      await answer(q, "بازی فعال نیست.");
      return;
    }
    if (user.id !== state.narratorId) {
      await answer(q, "فقط راوی می‌تواند این کار را انجام دهد.");
      return;
    }

    if (action === "ok") {
      if (state.phase !== "WAITING_NARRATOR_DECISION") {
        await answer(q, "این رول در وضعیت قابل تایید نیست.");
        return;
      }
      state.phase = "WAITING_NARRATOR_RESPONSE";
      await saveState(env, state, GAME_TTL);
      await answer(q, "تایید شد.");
      await tg(env, "sendMessage", {
        chat_id: state.narratorId,
        text: "رول تایید شد.\nجواب را بنویسید."
      });
      return;
    }

    if (action === "no") {
      if (state.phase !== "WAITING_NARRATOR_DECISION") {
        await answer(q, "این رول در وضعیت قابل رد نیست.");
        return;
      }
      state.phase = "WAITING_REJECT_REASON";
      await saveState(env, state, GAME_TTL);
      await answer(q, "دلیل را در پیوی بنویس.");
      await tg(env, "sendMessage", {
        chat_id: state.narratorId,
        text: "دلیل رد شدن رول را بنویسید."
      });
      return;
    }
  }

  if (data.startsWith("pick:")) {
    const parts = data.split(":");
    const chatId = Number(parts[1]);
    const playerId = Number(parts[2]);
    const state = await getState(env, chatId);

    if (!state?.active || state.narratorId !== user.id) {
      await answer(q, "دسترسی نداری.");
      return;
    }

    if (state.phase !== "WAITING_NEXT_PLAYER") {
      await answer(q, "الان زمان انتخاب نفر بعدی نیست.");
      return;
    }

    if (!state.players.some(p => p.id === playerId)) {
      await answer(q, "این بازیکن دیگر فعال نیست.");
      return;
    }

    state.currentPlayerId = playerId;
    state.pendingRole = null;
    state.pendingResponse = null;
    state.rejectReason = null;
    state.phase = "WAITING_PLAYER_TEXT";
    await saveState(env, state, GAME_TTL);

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `نوبت ${displayName(state, playerId)} است.`
    });
    await tg(env, "sendMessage", {
      chat_id: playerId,
      text: "رولتو بفرست."
    });
    await answer(q, "انتخاب شد.");
    return;
  }

  if (data.startsWith("elimq:")) {
    const chatId = Number(data.split(":")[1]);
    const state = await getState(env, chatId);
    if (!state?.active || state.narratorId !== user.id) {
      await answer(q, "دسترسی نداری.");
      return;
    }
    state.phase = "WAITING_ELIMINATION_CHOICE";
    await saveState(env, state, GAME_TTL);
    await answer(q, "باشه.");
    await tg(env, "sendMessage", {
      chat_id: user.id,
      text: "آیا کسی از رول حذف شده؟",
      reply_markup: {
        inline_keyboard: [[
          { text: "خیر", callback_data: `elim:no:${chatId}` },
          { text: "بله", callback_data: `elim:yes:${chatId}` }
        ]]
      }
    });
    return;
  }

  if (data.startsWith("elim:")) {
    const [, action, chatIdRaw] = data.split(":");
    const chatId = Number(chatIdRaw);
    const state = await getState(env, chatId);

    if (!state?.active || state.narratorId !== user.id) {
      await answer(q, "دسترسی نداری.");
      return;
    }

    if (action === "no") {
      state.phase = "WAITING_NEXT_PLAYER";
      await saveState(env, state, GAME_TTL);
      await answer(q, "روند ادامه پیدا می‌کند.");
      await sendNextPlayerPicker(state, env);
      return;
    }

    if (action === "yes") {
      state.phase = "WAITING_ELIMINATION_PICK";
      await saveState(env, state, GAME_TTL);
      await answer(q, "بازیکن حذف‌شده را انتخاب کن.");
      await sendEliminationPicker(state, env);
      return;
    }
  }

  if (data.startsWith("backelim:")) {
    const chatId = Number(data.split(":")[1]);
    const state = await getState(env, chatId);
    if (!state?.active || state.narratorId !== user.id) {
      await answer(q, "دسترسی نداری.");
      return;
    }
    state.phase = "WAITING_NEXT_PLAYER";
    await saveState(env, state, GAME_TTL);
    await answer(q, "برگشت.");
    await sendNextPlayerPicker(state, env);
    return;
  }

  if (data.startsWith("remove:")) {
    const parts = data.split(":");
    const chatId = Number(parts[1]);
    const playerId = Number(parts[2]);
    const state = await getState(env, chatId);

    if (!state?.active || state.narratorId !== user.id) {
      await answer(q, "دسترسی نداری.");
      return;
    }

    if (state.phase !== "WAITING_ELIMINATION_PICK") {
      await answer(q, "الان زمان حذف نیست.");
      return;
    }

    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx < 0) {
      await answer(q, "این بازیکن پیدا نشد.");
      return;
    }

    const [removed] = state.players.splice(idx, 1);
    state.eliminated.push(removed);
    state.phase = "WAITING_NEXT_PLAYER";
    await saveState(env, state, GAME_TTL);

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `${removed.name} حذف شد`
    });
    await answer(q, "حذف شد.");
    await sendNextPlayerPicker(state, env);
  }
}

async function joinLobby(q, state, env) {
  const user = q.from;
  const existing = state.players.find(p => p.id === user.id);

  if (existing) {
    await answer(q, "تو قبلاً وارد شدی.");
    return;
  }

  const known = await isKnownUser(env, user.id);
  if (!known) {
    const me = await tg(env, "getMe", {});
    const username = me.result.username;
    await answer(q, "اول ربات را در پیوی استارت کن.", true);
    await tg(env, "sendMessage", {
      chat_id: state.chatId,
      text: `${nameOf(user)} برای ورود باید اول ربات را در پیوی استارت کند، بعد دوباره «پایه‌ام» را بزند.`,
      reply_markup: {
        inline_keyboard: [[
          { text: "رفتن به پیوی ربات", url: `https://t.me/${username}?start=role_${state.chatId}` }
        ]]
      }
    });
    return;
  }

  state.players.push({ id: user.id, name: nameOf(user), username: user.username || null });
  await saveState(env, state, LOBBY_TTL);
  await answer(q, "وارد شدی.");
  await editLobbyMessage(q.message, state, env);
}

async function leaveLobby(q, state, env) {
  const user = q.from;

  if (user.id === state.narratorId) {
    await deleteState(env, state.chatId);
    await answer(q, "رول لغو شد.");
    await tg(env, "editMessageText", {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      text: "این سناریو توسط راوی لغو شد."
    });
    return;
  }

  const before = state.players.length;
  state.players = state.players.filter(p => p.id !== user.id);

  if (state.players.length === before) {
    await answer(q, "تو داخل لیست بازیکنان نیستی.");
    return;
  }

  await saveState(env, state, LOBBY_TTL);
  await answer(q, "از لیست خارج شدی.");
  await editLobbyMessage(q.message, state, env);
}

async function startGame(q, state, env) {
  if (q.from.id !== state.narratorId) {
    await answer(q, "فقط راوی می‌تواند بازی را شروع کند.");
    return;
  }

  if (state.players.length < 2) {
    await answer(q, "حداقل دو بازیکن لازم است.");
    return;
  }

  state.phase = "WAITING_FIRST_PLAYER";
  await saveState(env, state, GAME_TTL);

  await tg(env, "sendMessage", {
    chat_id: state.chatId,
    text: "سناریو شروع شد."
  });

  await answer(q, "شروع شد.");
  await sendNextPlayerPicker(state, env);
}

async function sendNextPlayerPicker(state, env) {
  if (!state.players.length) {
    await finishGameInternal(state, env);
    return;
  }

  const rows = [];
  for (const p of state.players) {
    rows.push([{ text: p.name.slice(0, 60), callback_data: `pick:${state.chatId}:${p.id}` }]);
  }

  await tg(env, "sendMessage", {
    chat_id: state.narratorId,
    text: "رول رو کی شروع کنه؟",
    reply_markup: { inline_keyboard: rows }
  });
}

async function sendEliminationPicker(state, env) {
  const rows = state.players.map(p => [
    { text: p.name.slice(0, 60), callback_data: `remove:${state.chatId}:${p.id}` }
  ]);
  rows.push([{ text: "↩️ بازگشت", callback_data: `backelim:${state.chatId}` }]);

  await tg(env, "sendMessage", {
    chat_id: state.narratorId,
    text: "کی حذف شده؟",
    reply_markup: { inline_keyboard: rows }
  });
}

async function publishApprovedRole(state, env) {
  if (!state.pendingRole || !state.pendingResponse) {
    await saveState(env, state, GAME_TTL);
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: state.narratorId,
    text: "دریافت شد."
  });

  const playerName = displayName(state, state.currentPlayerId);

  await tg(env, "sendMessage", {
    chat_id: state.chatId,
    text: `🎭 رول ${playerName}:\n\n${state.pendingRole}`
  });

  await tg(env, "sendMessage", {
    chat_id: state.chatId,
    text: `📖 جواب راوی:\n\n${state.pendingResponse}`
  });

  state.pendingRole = null;
  state.pendingResponse = null;
  state.rejectReason = null;
  state.currentPlayerId = null;
  state.phase = "WAITING_ELIMINATION_CHOICE";
  await saveState(env, state, GAME_TTL);

  await tg(env, "sendMessage", {
    chat_id: state.narratorId,
    text: "آیا کسی از رول حذف شده؟",
    reply_markup: {
      inline_keyboard: [[
        { text: "خیر", callback_data: `elim:no:${state.chatId}` },
        { text: "بله", callback_data: `elim:yes:${state.chatId}` }
      ]]
    }
  });
}

async function cancelGame(msg, env) {
  const state = await getState(env, msg.chat.id);
  if (!state?.active) {
    await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "هیچ رول فعالی وجود ندارد." });
    return;
  }
  if (msg.from.id !== state.narratorId) {
    await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "فقط راوی می‌تواند رول را لغو کند." });
    return;
  }
  await deleteState(env, msg.chat.id);
  await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "رول لغو شد." });
}

async function finishGame(msg, env) {
  const state = await getState(env, msg.chat.id);
  if (!state?.active) {
    await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "هیچ رول فعالی وجود ندارد." });
    return;
  }
  if (msg.from.id !== state.narratorId) {
    await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "فقط راوی می‌تواند رول را تمام کند." });
    return;
  }
  await finishGameInternal(state, env);
}

async function finishGameInternal(state, env) {
  const survivors = state.players.length
    ? state.players.map(p => `• ${p.name}`).join("\n")
    : "—";

  const eliminated = state.eliminated.length
    ? state.eliminated.map(p => `• ${p.name}`).join("\n")
    : "—";

  await tg(env, "sendMessage", {
    chat_id: state.chatId,
    text: `رول با موفقیت به پایان رسید.\n\nلیست بازماندگان:\n${survivors}\n\nلیست حذف‌شدگان:\n${eliminated}`
  });

  await deleteState(env, state.chatId);
}

async function editLobbyMessage(message, state, env) {
  const players = state.players.length
    ? state.players.map(p => `• ${p.name}`).join("\n")
    : "—";

  await tg(env, "editMessageText", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: `برای شرکت در سناریو، پایه‌ام را بزنید\n\nبازیکنان:\n${players}`,
    reply_markup: lobbyKeyboard()
  });
}

function displayName(state, id) {
  const p = [...state.players, ...state.eliminated].find(x => x.id === id);
  return p?.name || "بازیکن";
}

function nameOf(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
}

async function rememberUser(env, user) {
  await env.ROLE_KV.put(`user:${user.id}`, JSON.stringify({
    id: user.id,
    name: nameOf(user),
    username: user.username || null,
    startedAt: Date.now()
  }));
}

async function isKnownUser(env, userId) {
  return !!(await env.ROLE_KV.get(`user:${userId}`));
}

async function getState(env, chatId) {
  const raw = await env.ROLE_KV.get(`game:${chatId}`);
  if (!raw) return null;
  const state = JSON.parse(raw);
  if (state.expiresAt && Date.now() > state.expiresAt) {
    await deleteState(env, chatId);
    return null;
  }
  return state;
}

async function saveState(env, state, ttl) {
  await env.ROLE_KV.put(`game:${state.chatId}`, JSON.stringify(state), {
    expirationTtl: ttl
  });
  const ids = JSON.parse((await env.ROLE_KV.get("active_games")) || "[]");
  if (!ids.includes(state.chatId)) {
    ids.push(state.chatId);
    await env.ROLE_KV.put("active_games", JSON.stringify(ids));
  }
}

async function deleteState(env, chatId) {
  await env.ROLE_KV.delete(`game:${chatId}`);
  const ids = JSON.parse((await env.ROLE_KV.get("active_games")) || "[]");
  const next = ids.filter(id => id !== chatId);
  await env.ROLE_KV.put("active_games", JSON.stringify(next));
}

async function findStatesForUser(env, userId) {
  // KV has no server-side query. Active games are indexed separately.
  const indexRaw = await env.ROLE_KV.get("active_games");
  if (!indexRaw) return [];
  const ids = JSON.parse(indexRaw);
  const out = [];
  for (const chatId of ids) {
    const state = await getState(env, chatId);
    if (state && (state.narratorId === userId || state.currentPlayerId === userId)) {
      out.push({ chatId, state });
    }
  }
  return out;
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!data.ok) console.error("Telegram API error", method, data);
  return data;
}

async function answer(q, text, showAlert = false) {
  const env = q._env;
  if (!env) return;
  return tg(env, "answerCallbackQuery", {
    callback_query_id: q.id,
    text,
    show_alert: showAlert
  });
}
