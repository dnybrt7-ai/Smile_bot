import type { Env, GameState } from '../types';
import { SENTENCES } from '../sentences';
import { sendMessage, editMessageText, answerCallbackQuery, getChatMember, kb, escapeHtml } from '../telegram';

const COLLECT_MS = 4 * 60 * 1000;
const JUDGE_MS = 5 * 60 * 1000;
const MAX_ANSWER_LEN = 120;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;

function emptyState(chatId: number): GameState {
  return {
    status: 'idle',
    chatId,
    starterId: 0,
    starterName: '',
    mainMessageId: null,
    players: [],
    judgeOrder: [],
    currentRoundIndex: 0,
    currentJudgeId: null,
    currentSentence: null,
    usedSentenceIndices: [],
    submissions: {},
    excludedThisRound: [],
    roundDeadline: null,
    judgeDeadline: null,
    judgeOptionOrder: null,
    createdAt: Date.now(),
  };
}

export class GameRoom {
  state: DurableObjectState;
  env: Env;
  game: GameState;
  ready: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.game = emptyState(0);
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<GameState>('game');
      if (stored) this.game = stored;
    });
  }

  async persist() {
    await this.state.storage.put('game', this.game);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/start-game-flow':
          await this.handleStartCommand(request);
          break;
        case '/callback':
          await this.handleCallback(request);
          break;
        case '/dm-start':
          await this.handleDmStart(request);
          break;
        case '/dm-message':
          await this.handleDmMessage(request);
          break;
        case '/cancel':
          await this.handleCancel(request);
          break;
        case '/tick':
          await this.handleTick();
          break;
        case '/status':
          return new Response(JSON.stringify({ status: this.game.status }), { status: 200 });
        default:
          return new Response('not found', { status: 404 });
      }
      return new Response('ok');
    } catch (err: any) {
      console.error('GameRoom error', err);
      return new Response('error: ' + (err?.message ?? String(err)), { status: 500 });
    }
  }

  async registerActive() {
    await this.env.REGISTRY.put(`active:${this.game.chatId}`, '1');
  }

  async unregisterActive() {
    await this.env.REGISTRY.delete(`active:${this.game.chatId}`);
  }

  async clearUserPointers() {
    for (const p of this.game.players) {
      await this.env.REGISTRY.delete(`user:${p.id}`);
    }
  }

  async handleStartCommand(request: Request) {
    const { chatId, userId, userName } = await request.json<{
      chatId: number;
      userId: number;
      userName: string;
    }>();

    if (this.game.status !== 'idle' && this.game.status !== 'finished') {
      await sendMessage(this.env, chatId, '⚠️ یک بازی در حال حاضر در این گروه فعال است. برای لغو آن دستور /CANCEL را بزنید.');
      return;
    }

    this.game = emptyState(chatId);
    this.game.status = 'joining';
    this.game.starterId = userId;
    this.game.starterName = userName;
    await this.persist();
    await this.registerActive();

    const markup = kb([
      [{ text: '🙋‍♂️ جوین به بازی', url: `https://t.me/${this.env.BOT_USERNAME}?start=join_${chatId}` }],
      [{ text: '▶️ شروع بازی', callback_data: 'start_game' }],
    ]);
    const res = await sendMessage(this.env, chatId, this.renderJoinMessage(), markup);
    this.game.mainMessageId = res?.result?.message_id ?? null;
    await this.persist();
  }

  renderJoinMessage(): string {
    const names =
      this.game.players.map((p, i) => `${i + 1}. ${escapeHtml(p.name)}`).join('\n') ||
      '— هنوز کسی جوین نداده —';
    return (
      `🎭 <b>بازی جمله‌سازی خنده‌دار</b>\n\n` +
      `برای جوین شدن روی دکمه زیر بزنید (پیوی ربات به‌طور خودکار باز می‌شود).\n` +
      `حداقل ۳ نفر، حداکثر ۶ نفر لازم است.\n\n` +
      `👥 <b>شرکت‌کننده‌ها:</b>\n${names}\n\n` +
      `وقتی آماده بودید، سازنده بازی (${escapeHtml(this.game.starterName)}) دکمه «شروع بازی» را بزند.`
    );
  }

  async handleDmStart(request: Request) {
    const { userId, userName } = await request.json<{ userId: number; userName: string }>();

    if (this.game.status !== 'joining') {
      await sendMessage(this.env, userId, 'این بازی دیگر در مرحله جوین شدن نیست.');
      return;
    }
    if (this.game.players.some((p) => p.id === userId)) {
      await sendMessage(this.env, userId, 'شما قبلاً به این بازی جوین شده‌اید.');
      return;
    }
    if (this.game.players.length >= MAX_PLAYERS) {
      await sendMessage(this.env, userId, 'ظرفیت بازی تکمیل است (حداکثر ۶ نفر).');
      return;
    }

    this.game.players.push({ id: userId, name: userName, score: 0, judgedCount: 0 });
    await this.persist();
    await this.env.REGISTRY.put(`user:${userId}`, String(this.game.chatId));

    await sendMessage(
      this.env,
      userId,
      '✅ شما با موفقیت به بازی جوین شدید.\nمنتظر بمانید تا سازنده بازی را شروع کند.'
    );

    if (this.game.mainMessageId) {
      const markup = kb([
        [{ text: '🙋‍♂️ جوین به بازی', url: `https://t.me/${this.env.BOT_USERNAME}?start=join_${this.game.chatId}` }],
        [{ text: '▶️ شروع بازی', callback_data: 'start_game' }],
      ]);
      await editMessageText(this.env, this.game.chatId, this.game.mainMessageId, this.renderJoinMessage(), markup);
    }
  }

  async handleCallback(request: Request) {
    const { data, userId, userName, callbackQueryId } = await request.json<{
      data: string;
      userId: number;
      userName: string;
      callbackQueryId: string;
    }>();

    if (data === 'start_game') return this.handleStartGameButton(userId, callbackQueryId);
    if (data.startsWith('pick_')) return this.handleJudgePick(data, userId, callbackQueryId);
    if (data === 'next_round') return this.handleNextRoundButton(userId, callbackQueryId);
    await answerCallbackQuery(this.env, callbackQueryId);
  }

  async handleStartGameButton(userId: number, callbackQueryId: string) {
    if (this.game.status !== 'joining') {
      await answerCallbackQuery(this.env, callbackQueryId, 'بازی در این مرحله نیست.', true);
      return;
    }
    if (userId !== this.game.starterId) {
      await answerCallbackQuery(this.env, callbackQueryId, 'فقط سازنده بازی می‌تواند بازی را شروع کند.', true);
      return;
    }
    if (this.game.players.length < MIN_PLAYERS) {
      await answerCallbackQuery(
        this.env,
        callbackQueryId,
        `تعدادتان از ${MIN_PLAYERS} نفر کمتر است، بازی استارت نمی‌شود.`,
        true
      );
      return;
    }

    await answerCallbackQuery(this.env, callbackQueryId, 'بازی شروع شد!');

    this.game.judgeOrder = [];
    for (let round = 0; round < 2; round++) {
      for (const p of this.game.players) this.game.judgeOrder.push(p.id);
    }
    this.game.currentRoundIndex = -1;
    await this.persist();
    await this.startNextRound();
  }

  pickSentence(): string {
    const remaining = SENTENCES.map((_, i) => i).filter((i) => !this.game.usedSentenceIndices.includes(i));
    const pool = remaining.length > 0 ? remaining : SENTENCES.map((_, i) => i);
    const idx = pool[Math.floor(Math.random() * pool.length)];
    this.game.usedSentenceIndices.push(idx);
    return SENTENCES[idx];
  }

  async startNextRound() {
    this.game.currentRoundIndex += 1;

    if (this.game.currentRoundIndex >= this.game.judgeOrder.length) {
      await this.finishGame();
      return;
    }

    this.game.status = 'collecting';
    this.game.currentJudgeId = this.game.judgeOrder[this.game.currentRoundIndex];
    this.game.currentSentence = this.pickSentence();
    this.game.submissions = {};
    this.game.excludedThisRound = [];
    this.game.roundDeadline = Date.now() + COLLECT_MS;
    this.game.judgeDeadline = null;
    this.game.judgeOptionOrder = null;
    await this.persist();

    const judge = this.game.players.find((p) => p.id === this.game.currentJudgeId)!;
    const text = this.renderCollectingMessage(judge.name);

    if (this.game.mainMessageId) {
      await editMessageText(this.env, this.game.chatId, this.game.mainMessageId, text);
    } else {
      const res = await sendMessage(this.env, this.game.chatId, text);
      this.game.mainMessageId = res?.result?.message_id ?? null;
      await this.persist();
    }

    for (const p of this.game.players) {
      if (p.id === this.game.currentJudgeId) continue;
      await sendMessage(
        this.env,
        p.id,
        `📝 <b>سوال این دور:</b>\n${escapeHtml(this.game.currentSentence!)}\n\n` +
          `یک جواب خنده‌دار بنویس (حداکثر ${MAX_ANSWER_LEN} کاراکتر). حدود ۴ دقیقه وقت داری.`
      );
    }
  }

  renderCollectingMessage(judgeName: string): string {
    const roundNo = this.game.currentRoundIndex + 1;
    const totalRounds = this.game.judgeOrder.length;
    const receivedNames = Object.keys(this.game.submissions)
      .map(Number)
      .map((id) => this.game.players.find((p) => p.id === id)?.name)
      .filter(Boolean) as string[];
    const receivedText =
      receivedNames.length > 0 ? receivedNames.map((n) => `✅ ${escapeHtml(n)}`).join('\n') : '— هنوز کسی ارسال نکرده —';

    return (
      `🎭 دور ${roundNo} از ${totalRounds}\n` +
      `👨‍⚖️ قاضی این دور: <b>${escapeHtml(judgeName)}</b>\n\n` +
      `❓ جمله: <i>${escapeHtml(this.game.currentSentence!)}</i>\n\n` +
      `⏳ بقیه بازیکن‌ها در پیوی ربات جواب می‌فرستند...\n\n` +
      `📥 دریافت شده از:\n${receivedText}`
    );
  }

  async handleDmMessage(request: Request) {
    const { userId, text } = await request.json<{ userId: number; text: string }>();

    if (this.game.status !== 'collecting') return;
    if (userId === this.game.currentJudgeId) return;
    if (!this.game.players.some((p) => p.id === userId)) return;
    if (this.game.excludedThisRound.includes(userId)) return;

    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length > MAX_ANSWER_LEN) {
      await sendMessage(this.env, userId, `❌ جواب نباید بیشتر از ${MAX_ANSWER_LEN} کاراکتر باشد. دوباره بفرست.`);
      return;
    }

    this.game.submissions[userId] = trimmed;
    await this.persist();
    await sendMessage(this.env, userId, '✅ دریافت شد.');

    const judgeName = this.game.players.find((p) => p.id === this.game.currentJudgeId)?.name ?? '';
    if (this.game.mainMessageId) {
      await editMessageText(this.env, this.game.chatId, this.game.mainMessageId, this.renderCollectingMessage(judgeName));
    }

    const expectedCount = this.game.players.length - 1;
    if (Object.keys(this.game.submissions).length >= expectedCount) {
      await this.moveToJudging();
    }
  }

  async moveToJudging() {
    const entries = Object.entries(this.game.submissions).map(([id, txt]) => ({ id: Number(id), text: txt }));

    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }

    if (entries.length === 0) {
      await this.startNextRound();
      return;
    }

    this.game.status = 'judging';
    this.game.judgeOptionOrder = entries.map((e) => e.id);
    this.game.judgeDeadline = Date.now() + JUDGE_MS;
    await this.persist();

    const judge = this.game.players.find((p) => p.id === this.game.currentJudgeId)!;
    const optionsText = entries.map((e, i) => `${i + 1}. ${escapeHtml(e.text)}`).join('\n');
    const text =
      `👨‍⚖️ نوبت قضاوت <b>${escapeHtml(judge.name)}</b>\n\n` +
      `❓ جمله: <i>${escapeHtml(this.game.currentSentence!)}</i>\n\n` +
      `گزینه‌ها:\n${optionsText}\n\n` +
      `قاضی باید خنده‌دارترین جمله را انتخاب کند (حدود ۵ دقیقه وقت هست).`;

    const buttons = entries.map((e, i) => [{ text: `جمله ${i + 1}`, callback_data: `pick_${e.id}` }]);
    await editMessageText(this.env, this.game.chatId, this.game.mainMessageId!, text, kb(buttons));
  }

  async handleJudgePick(data: string, userId: number, callbackQueryId: string) {
    if (this.game.status !== 'judging') {
      await answerCallbackQuery(this.env, callbackQueryId, 'الان زمان قضاوت نیست.', true);
      return;
    }
    if (userId !== this.game.currentJudgeId) {
      await answerCallbackQuery(this.env, callbackQueryId, 'شما قاضی این دور نیستید.', true);
      return;
    }
    const winnerId = Number(data.replace('pick_', ''));
    if (!this.game.judgeOptionOrder?.includes(winnerId)) {
      await answerCallbackQuery(this.env, callbackQueryId, 'گزینه نامعتبر.', true);
      return;
    }

    await answerCallbackQuery(this.env, callbackQueryId, 'انتخاب ثبت شد!');
    await this.revealRoundResult(winnerId);
  }

  async revealRoundResult(winnerId: number | null) {
    const judge = this.game.players.find((p) => p.id === this.game.currentJudgeId)!;
    const entries = (this.game.judgeOptionOrder ?? []).map((id) => ({
      id,
      text: this.game.submissions[id],
      name: this.game.players.find((p) => p.id === id)?.name ?? '؟',
    }));

    if (winnerId !== null) {
      const winner = this.game.players.find((p) => p.id === winnerId);
      if (winner) winner.score += 1;
    }
    judge.judgedCount += 1;
    this.game.status = 'reveal';
    await this.persist();

    let resultText = `🎭 نتیجه دور:\n❓ <i>${escapeHtml(this.game.currentSentence!)}</i>\n\n`;
    if (winnerId !== null) {
      const winnerEntry = entries.find((e) => e.id === winnerId)!;
      resultText += `🏆 برنده این دور: <b>${escapeHtml(winnerEntry.name)}</b> با جمله «${escapeHtml(
        winnerEntry.text
      )}» (+۱ امتیاز)\n\n`;
    } else {
      resultText += `⏱ زمان قضاوت تمام شد، این دور بدون امتیاز رد شد.\n\n`;
    }

    const others = entries.filter((e) => e.id !== winnerId);
    if (others.length > 0) {
      resultText +=
        `دیگر جمله‌ها:\n` + others.map((e) => `• ${escapeHtml(e.name)}: ${escapeHtml(e.text)}`).join('\n') + '\n\n';
    }

    resultText += `👨‍⚖️ قاضی: ${escapeHtml(judge.name)}\n\n`;
    resultText += this.renderScoreboard();

    await editMessageText(
      this.env,
      this.game.chatId,
      this.game.mainMessageId!,
      resultText,
      kb([[{ text: '➡️ دور بعدی', callback_data: 'next_round' }]])
    );
  }

  renderScoreboard(): string {
    const sorted = [...this.game.players].sort((a, b) => b.score - a.score);
    return '📊 امتیازها:\n' + sorted.map((p, i) => `${i + 1}. ${escapeHtml(p.name)} — ${p.score} امتیاز`).join('\n');
  }

  async handleNextRoundButton(userId: number, callbackQueryId: string) {
    if (this.game.status !== 'reveal') {
      await answerCallbackQuery(this.env, callbackQueryId, 'الان زمان مناسبی نیست.', true);
      return;
    }
    if (userId !== this.game.currentJudgeId) {
      await answerCallbackQuery(this.env, callbackQueryId, 'فقط قاضی همین دور می‌تواند دور بعدی را شروع کند.', true);
      return;
    }
    await answerCallbackQuery(this.env, callbackQueryId);
    await this.startNextRound();
  }

  async finishGame() {
    this.game.status = 'finished';
    await this.persist();
    await this.clearUserPointers();
    await this.unregisterActive();

    const text = `🏁 <b>بازی تمام شد!</b>\n\n${this.renderScoreboard()}\n\nبرای شروع بازی جدید /SMILE را بزنید.`;
    if (this.game.mainMessageId) {
      await editMessageText(this.env, this.game.chatId, this.game.mainMessageId, text);
    } else {
      await sendMessage(this.env, this.game.chatId, text);
    }
  }

  async handleCancel(request: Request) {
    const { userId } = await request.json<{ userId: number }>();

    if (this.game.status === 'idle' || this.game.status === 'finished') {
      await sendMessage(this.env, this.game.chatId, 'بازی فعالی برای لغو وجود ندارد.');
      return;
    }

    if (userId !== this.game.starterId) {
      const member = await getChatMember(this.env, this.game.chatId, userId);
      const status = member?.result?.status;
      if (!(status === 'administrator' || status === 'creator')) {
        await sendMessage(this.env, this.game.chatId, '❌ فقط سازنده بازی یا ادمین‌های گروه می‌توانند بازی را لغو کنند.');
        return;
      }
    }

    await sendMessage(this.env, this.game.chatId, '🛑 بازی لغو شد.');
    await this.clearUserPointers();
    await this.unregisterActive();
    this.game = emptyState(this.game.chatId);
    await this.persist();
  }

  async handleTick() {
    if (this.game.status === 'collecting' && this.game.roundDeadline && Date.now() > this.game.roundDeadline) {
      const nonJudges = this.game.players.filter((p) => p.id !== this.game.currentJudgeId);
      for (const p of nonJudges) {
        if (!(p.id in this.game.submissions)) this.game.excludedThisRound.push(p.id);
      }
      await this.persist();
      await this.moveToJudging();
    } else if (this.game.status === 'judging' && this.game.judgeDeadline && Date.now() > this.game.judgeDeadline) {
      await this.revealRoundResult(null);
    }
  }
              }
