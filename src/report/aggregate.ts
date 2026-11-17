// Сводки: по менеджеру и за период. Всё считает код по сохранённым оценкам.
import type { CallRecord, ObjectionType, Outcome } from "../types.js";

export interface ItemRate { id: string; title: string; yes: number; partial: number; no: number; rate: number }
export interface ManagerStat {
  manager: string;
  calls: number;
  /** Звонки с оценкой (продажи) */
  scored: number;
  avgScore: number | null;
  talkRatio: number | null;
  avgDuration: number;
  sales: number;
  nextSteps: number;
  missed: number;
  objections: number;
  /** Доля возражений, на которые менеджер ответил (да/частично), % */
  handled: number | null;
  items: ItemRate[];
  weakest: ItemRate[];
  objectionTypes: Partial<Record<ObjectionType, number>>;
  weeks: { week: string; calls: number; avgScore: number | null }[];
}

export interface PeriodSummary {
  from: string; to: string;
  calls: number; scored: number; avgScore: number | null;
  outcomes: Partial<Record<Outcome, number>>;
  missed: number;
  managers: ManagerStat[];
  items: ItemRate[];
  objectionTypes: Partial<Record<ObjectionType, number>>;
  weeks: { week: string; calls: number; avgScore: number | null }[];
}

const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

/** Неделя ISO: «2026-W46» */
export function isoWeek(date: string): string {
  const d = new Date(date.slice(0, 10) + "T12:00:00Z");
  if (isNaN(+d)) return "—";
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((+d - +jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

function itemRates(recs: CallRecord[]): ItemRate[] {
  const m = new Map<string, ItemRate>();
  for (const r of recs) for (const i of r.review?.score != null ? r.review.items : []) {
    if (i.status === "na") continue;
    const x = m.get(i.id) ?? { id: i.id, title: i.title, yes: 0, partial: 0, no: 0, rate: 0 };
    x[i.status]++;
    m.set(i.id, x);
  }
  return [...m.values()].map(x => ({ ...x, rate: Math.round(((x.yes + x.partial / 2) / Math.max(1, x.yes + x.partial + x.no)) * 100) }));
}

function weeks(recs: CallRecord[]) {
  const m = new Map<string, number[]>(), n = new Map<string, number>();
  for (const r of recs) { const w = isoWeek(r.meta.date); n.set(w, (n.get(w) ?? 0) + 1); if (r.review?.score != null) m.set(w, [...(m.get(w) ?? []), r.review.score]); }
  return [...n.keys()].sort().map(w => ({ week: w, calls: n.get(w)!, avgScore: avg(m.get(w) ?? []) }));
}

function objTypes(recs: CallRecord[]) {
  const o: Partial<Record<ObjectionType, number>> = {};
  for (const r of recs) for (const x of r.review?.objections ?? []) o[x.type] = (o[x.type] ?? 0) + 1;
  return o;
}

export function managerStat(manager: string, recs: CallRecord[]): ManagerStat {
  const scored = recs.filter(r => r.review?.score != null);
  const objs = recs.flatMap(r => r.review?.objections ?? []);
  const items = itemRates(recs);
  return {
    manager, calls: recs.length, scored: scored.length,
    avgScore: avg(scored.map(r => r.review!.score!)),
    talkRatio: avg(scored.map(r => r.metrics.talkRatio)),
    avgDuration: Math.round(recs.reduce((s, r) => s + r.metrics.duration, 0) / Math.max(1, recs.length)),
    sales: recs.filter(r => r.review?.outcome === "sale").length,
    nextSteps: recs.filter(r => r.review?.nextStep.agreed).length,
    missed: recs.filter(r => r.review?.missed).length,
    objections: objs.length,
    handled: objs.length ? Math.round((objs.filter(o => o.handled !== "no").length / objs.length) * 100) : null,
    items, weakest: [...items].filter(i => i.yes + i.partial + i.no >= 2).sort((a, b) => a.rate - b.rate).slice(0, 3),
    objectionTypes: objTypes(recs),
    weeks: weeks(recs),
  };
}

export function periodSummary(recs: CallRecord[], from = "", to = ""): PeriodSummary {
  const dates = recs.map(r => r.meta.date.slice(0, 10)).sort();
  const byMgr = new Map<string, CallRecord[]>();
  for (const r of recs) byMgr.set(r.meta.manager, [...(byMgr.get(r.meta.manager) ?? []), r]);
  const scored = recs.filter(r => r.review?.score != null);
  const outcomes: Partial<Record<Outcome, number>> = {};
  for (const r of recs) if (r.review) outcomes[r.review.outcome] = (outcomes[r.review.outcome] ?? 0) + 1;
  return {
    from: from || dates[0] || "", to: to || dates.at(-1) || "",
    calls: recs.length, scored: scored.length, avgScore: avg(scored.map(r => r.review!.score!)),
    outcomes, missed: recs.filter(r => r.review?.missed).length,
    managers: [...byMgr.entries()].map(([m, rs]) => managerStat(m, rs)).sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1) || b.calls - a.calls),
    items: itemRates(recs), objectionTypes: objTypes(recs), weeks: weeks(recs),
  };
}
