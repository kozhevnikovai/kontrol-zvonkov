// Общие типы Контроля звонков.

export type Role = "manager" | "client";

/** Реплика звонка */
export interface Turn { start: number; end: number; role: Role; text: string }

/** Как определили, кто из говорящих — менеджер */
export type RoleSource = "channel" | "voice" | "greeting" | "order" | "setting";

export interface CallTranscript {
  file: string;
  duration: number;
  /** stereo — менеджер и клиент в разных каналах; mono — голоса разделены CAM++ */
  layout: "stereo" | "mono";
  turns: Turn[];
  roles: { source: RoleSource; managerChannel?: 0 | 1; confident: boolean };
  /** Отпечаток голоса менеджера (CAM++), для «знакомых голосов» — в архив не пишется */
  managerVoice?: number[];
  stats: { asrSeconds: number; rtf: number; device: string };
}

export type Direction = "in" | "out" | "unknown";

/** Сведения о звонке: из выгрузки телефонии, имени файла или настроек */
export interface CallMeta {
  id: string;
  file: string;
  manager: string;
  /** Номер клиента как в источнике; в отчётах маскируется */
  client: string;
  direction: Direction;
  /** ISO-дата и время начала */
  date: string;
  source: string;
  /** Номер звонка в телефонии */
  externalId?: string;
}

/** Метрики, которые считает код (одинаковые при каждом запуске) */
export interface Metrics {
  duration: number;
  managerTalk: number;
  clientTalk: number;
  /** Доля речи менеджера от всей речи, % */
  talkRatio: number;
  silence: number;
  longestMonologue: number;
  interruptions: number;
  /** Вопросы менеджера (по знаку «?» в распознанном тексте) */
  questions: number;
  /** Слов в минуту у менеджера */
  wpm: number;
  turnsPerMinute: number;
  /** Самая долгая пауза менеджера перед ответом клиенту, с */
  longestPause: number;
  /** Слова-паразиты и стоп-слова менеджера */
  fillers: number;
  stopWords: string[];
}

export interface ScriptItem {
  id: string;
  title: string;
  /** Что считается выполнением — подсказка модели и человеку */
  hint: string;
  weight: number;
  /** Обязательный пункт: невыполнение — отдельная пометка в отчёте */
  required?: boolean;
}

export interface Script { id: string; title: string; description: string; items: ScriptItem[]; stopWords?: string[] }

export type ItemStatus = "yes" | "partial" | "no" | "na";

export interface ItemResult {
  id: string;
  title: string;
  status: ItemStatus;
  quote: string;
  /** Время цитаты в записи, с; null — цитата не найдена в расшифровке */
  t: number | null;
  /** Модель сказала «выполнено», но цитаты нет в расшифровке — засчитано как «нет», нужна проверка */
  unverified?: boolean;
  comment?: string;
}

export type ObjectionType = "price" | "need" | "time" | "trust" | "competitor" | "decision" | "other";

export interface Objection {
  type: ObjectionType;
  /** Цитата клиента */
  quote: string;
  t: number | null;
  /** Цитата ответа менеджера */
  answer: string;
  handled: "yes" | "partial" | "no";
  /** Как ответить лучше — совет модели (помечен как совет, не как факт) */
  better: string;
}

export type Outcome = "sale" | "next_step" | "refusal" | "no_decision" | "not_sales";
export type Interest = "high" | "medium" | "low" | "none";

export interface Review {
  callId: string;
  scriptId: string;
  /** 0–100, считает код по весам пунктов; null — звонок не о продаже */
  score: number | null;
  items: ItemResult[];
  objections: Objection[];
  nextStep: { agreed: boolean; text: string; due: string | null; quote: string; t: number | null };
  interest: { level: Interest; quote: string; t: number | null };
  outcome: Outcome;
  /** Упущенная сделка: интерес был, следующего шага нет — считает код */
  missed: boolean;
  missedReason: string;
  summary: string;
  advice: string[];
  model: string;
  /** Сколько цитат модели нашлось в расшифровке */
  quotes: { total: number; verified: number };
  warnings: string[];
}

/** Звонок в архиве: сведения + расшифровка + метрики + оценка */
export interface CallRecord {
  meta: CallMeta;
  transcript: CallTranscript;
  metrics: Metrics;
  review?: Review;
  /** Работа с упущенной сделкой: перезвонили, задача в CRM */
  followUp?: { status: "open" | "done" | "crm"; note?: string; link?: string; at: string };
  processedAt: string;
  version: string;
}
