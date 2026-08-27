export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  REGISTRY: KVNamespace;
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  WEBHOOK_SECRET?: string;
}

export interface Player {
  id: number;
  name: string;
  score: number;
  judgedCount: number;
}

export type GameStatus =
  | 'idle'
  | 'joining'
  | 'collecting'
  | 'judging'
  | 'reveal'
  | 'finished';

export interface GameState {
  status: GameStatus;
  chatId: number;
  starterId: number;
  starterName: string;
  mainMessageId: number | null;
  players: Player[];
  judgeOrder: number[];
  currentRoundIndex: number;
  currentJudgeId: number | null;
  currentSentence: string | null;
  usedSentenceIndices: number[];
  submissions: Record<number, string>;
  excludedThisRound: number[];
  roundDeadline: number | null;
  judgeDeadline: number | null;
  judgeOptionOrder: number[] | null;
  createdAt: number;
  }
