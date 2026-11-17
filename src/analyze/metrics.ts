// Метрики звонка, которые считает код: доля речи, монологи, перебивания, паузы, вопросы, темп, слова-паразиты.
// Одинаковые при каждом запуске — по ним можно сравнивать менеджеров и недели.
import type { Metrics, Turn } from "../types.js";

export const FILLERS = ["ну", "как бы", "типа", "короче", "в общем-то", "это самое", "значит", "ээ", "эээ", "мм", "вот"];
export const DEFAULT_STOP_WORDS = ["не знаю", "наверное", "к сожалению", "не могу сказать", "это не ко мне", "перезвоните позже", "я не уверен", "без понятия"];

const norm = (s: string) => " " + s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\d? ]/gu, " ").replace(/\s+/g, " ") + " ";
function count(text: string, phrase: string): number {
  const t = norm(text), p = " " + norm(phrase).trim() + " ";
  let n = 0, i = t.indexOf(p);
  while (i >= 0) { n++; i = t.indexOf(p, i + p.length - 1); }
  return n;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Длина объединения интервалов речи, с */
function union(iv: [number, number][]): number {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  let total = 0, cs = -1, ce = -1;
  for (const [a, b] of s) {
    if (a > ce) { if (ce > cs) total += ce - cs; cs = a; ce = b; }
    else ce = Math.max(ce, b);
  }
  if (ce > cs) total += ce - cs;
  return total;
}

export function computeMetrics(turns: Turn[], duration: number, stopWords: string[] = DEFAULT_STOP_WORDS): Metrics {
  const mgr = turns.filter(t => t.role === "manager"), cli = turns.filter(t => t.role === "client");
  const talk = (a: Turn[]) => a.reduce((s, t) => s + Math.max(0, t.end - t.start), 0);
  const managerTalk = talk(mgr), clientTalk = talk(cli);
  const speech = union(turns.map(t => [t.start, t.end]));
  const sorted = [...turns].sort((a, b) => a.start - b.start);

  // перебивание: менеджер начал говорить, когда клиент говорил ещё ≥ 0,5 с после этого
  let interruptions = 0;
  for (const m of mgr) if (cli.some(c => c.start < m.start - 0.2 && c.end - m.start >= 0.5)) interruptions++;

  // самая долгая пауза менеджера перед ответом клиенту
  let longestPause = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].role === "manager" && sorted[i - 1].role === "client") longestPause = Math.max(longestPause, sorted[i].start - sorted[i - 1].end);
  }
  const mgrText = mgr.map(t => t.text).join(" ");
  const words = mgrText.split(/\s+/).filter(w => /\p{L}/u.test(w)).length;
  const questions = (mgrText.match(/\?/g) ?? []).length;
  const fillers = FILLERS.reduce((s, f) => s + count(mgrText, f), 0);
  const stops = stopWords.filter(w => count(mgrText, w) > 0);
  // смена говорящего в минуту
  let switches = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].role !== sorted[i - 1].role) switches++;

  return {
    duration: r1(duration),
    managerTalk: r1(managerTalk),
    clientTalk: r1(clientTalk),
    talkRatio: managerTalk + clientTalk > 0 ? Math.round((managerTalk / (managerTalk + clientTalk)) * 100) : 0,
    silence: r1(Math.max(0, duration - speech)),
    longestMonologue: r1(Math.max(0, ...mgr.map(t => t.end - t.start))),
    interruptions,
    questions,
    wpm: managerTalk > 5 ? Math.round(words / (managerTalk / 60)) : 0,
    turnsPerMinute: duration > 0 ? r1(switches / (duration / 60)) : 0,
    longestPause: r1(Math.max(0, longestPause)),
    fillers,
    stopWords: stops,
  };
}

/** Подсказки по метрикам — пороги из практики отделов продаж; считает код, без модели */
export function metricHints(m: Metrics): string[] {
  const out: string[] = [];
  if (m.duration >= 60 && m.talkRatio > 70) out.push(`Менеджер говорит ${m.talkRatio} % времени — клиенту почти не дают высказаться. Ориентир — 40–60 %.`);
  if (m.duration >= 60 && m.talkRatio > 0 && m.talkRatio < 25) out.push(`Менеджер говорит лишь ${m.talkRatio} % времени — разговор ведёт клиент.`);
  if (m.longestMonologue > 90) out.push(`Самый длинный монолог менеджера — ${Math.round(m.longestMonologue)} с. Лучше прерываться на вопрос каждые 30–60 с.`);
  if (m.interruptions >= 3) out.push(`Менеджер перебил клиента ${m.interruptions} раз.`);
  if (m.duration >= 90 && m.questions < 2) out.push(`Менеджер задал ${m.questions} вопрос(а) — потребность почти не выявлялась.`);
  if (m.wpm > 190) out.push(`Темп речи ${m.wpm} слов в минуту — клиенту трудно успевать.`);
  if (m.longestPause > 8) out.push(`Пауза перед ответом клиенту — ${Math.round(m.longestPause)} с.`);
  if (m.stopWords.length) out.push(`Стоп-слова: ${m.stopWords.map(w => `«${w}»`).join(", ")}.`);
  return out;
}
