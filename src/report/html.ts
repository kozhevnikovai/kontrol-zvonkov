// HTML-отчёты в светлом стиле приложений kozhevnikovai: карточка звонка, отчёт по менеджеру, сводка за период.
// Один файл, шрифты встроены, работает без интернета. Все данные экранируются.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { INTEREST, OBJECTION_TYPES, OUTCOMES } from "../analyze/review.js";
import { metricHints } from "../analyze/metrics.js";
import { fmtTime, roleLabel } from "../asr/transcribe.js";
import { maskPhone } from "../import/sources.js";
import type { CallRecord, ItemStatus, ObjectionType } from "../types.js";
import { VERSION } from "../version.js";
import type { ManagerStat, PeriodSummary } from "./aggregate.js";

const require = createRequire(import.meta.url);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const ruDate = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-"); return d ? `${d}.${m}.${y}` : iso; };
const ruDateTime = (iso: string) => `${ruDate(iso)}${iso.length >= 16 ? " " + iso.slice(11, 16) : ""}`;
const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с` : `${Math.round(s)} с`);

let fonts = "";
function fontFaces(): string {
  if (fonts) return fonts;
  const CYR = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116", LAT = "U+0000-00FF,U+2000-206F,U+20AC,U+2122,U+2190-2193";
  const f: [string, number, string][] = [["geologica-cyrillic-400-normal.woff2", 400, CYR], ["geologica-latin-400-normal.woff2", 400, LAT], ["geologica-cyrillic-600-normal.woff2", 600, CYR], ["geologica-latin-600-normal.woff2", 600, LAT]];
  fonts = f.map(([file, w, r]) => {
    try { return `@font-face{font-family:"Geologica";font-weight:${w};src:url(data:font/woff2;base64,${readFileSync(require.resolve(`@fontsource/geologica/files/${file}`)).toString("base64")}) format("woff2");unicode-range:${r}}`; } catch { return ""; }
  }).join("\n");
  return fonts;
}

const CSS = `
:root{--bg:#FBFBFA;--card:#fff;--ink:#1A1A19;--pencil:#5C5C57;--line:#E8E8E5;--plate:#F1F1EE;--acc:#C2410C;--ok:#1F7A4A;--okbg:#E7F3EC;--warn:#9A5B00;--warnbg:#FFF3DF;--bad:#B3261E;--badbg:#FCE9E7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 Geologica,"Segoe UI",system-ui,sans-serif}
.sheet{max-width:1000px;margin:32px auto;padding:0 20px 40px}
.kicker{font-size:13px;font-weight:600;color:var(--acc)}
h1{font-size:28px;line-height:1.2;margin:6px 0 6px;font-weight:600;letter-spacing:-.01em}h2{font-size:18px;margin:0 0 12px;font-weight:600}h3{font-size:15px;margin:14px 0 6px}
.meta{color:var(--pencil);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.04);break-inside:avoid}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:18px 0 6px}.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px}.tile b{display:block;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.tile span{font-size:13px;color:var(--pencil)}
.tile.ok b{color:var(--ok)}.tile.warn b{color:var(--warn)}.tile.bad b{color:var(--bad)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--plate);color:var(--pencil);font-weight:600;font-size:13px}tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.st{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:1px 9px;white-space:nowrap}.st.yes{color:var(--ok);background:var(--okbg)}.st.partial{color:var(--warn);background:var(--warnbg)}.st.no{color:var(--bad);background:var(--badbg)}.st.na{color:var(--pencil);background:var(--plate)}
q{color:var(--pencil);font-size:13px}q:before{content:"«"}q:after{content:"»"}
.tc{font-size:12px;color:var(--pencil);font-variant-numeric:tabular-nums;white-space:nowrap}
.note{font-size:13px;color:var(--pencil)}.warnline{color:var(--warn);font-size:13px}
.bar{height:8px;border-radius:4px;background:var(--plate);overflow:hidden;min-width:80px}.bar i{display:block;height:100%;background:var(--acc)}
.chat p{margin:4px 0;display:grid;grid-template-columns:54px 92px 1fr;gap:10px}.chat .who{font-size:12px;color:var(--pencil)}.chat .m .who{color:var(--acc);font-weight:600}
.score{font-size:44px;font-weight:600;line-height:1}.score small{font-size:16px;color:var(--pencil);font-weight:400}
.flag{display:inline-block;background:var(--badbg);color:var(--bad);border-radius:8px;padding:2px 10px;font-size:13px;font-weight:600}
.advice{background:var(--plate);border-radius:10px;padding:10px 14px;margin-top:10px}
ul{padding-left:20px;margin:4px 0}li{margin:3px 0}
footer{margin-top:28px;font-size:12px;color:var(--pencil)}
a{color:var(--acc)}
@media print{body{background:#fff}.sheet{margin:0;max-width:none}.card{box-shadow:none}}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="Контроль звонков ${VERSION}"><title>${esc(title)}</title><style>${fontFaces()}${CSS}</style></head><body><main class="sheet">${body}<footer>Контроль звонков ${esc(VERSION)} · расшифровка и оценка сделаны на этом компьютере · цифры и «упущенные сделки» считает код по цитатам из записи</footer></main></body></html>`;
}

const STATUS: Record<ItemStatus, string> = { yes: "Да", partial: "Частично", no: "Нет", na: "Не применимо" };
const scoreClass = (s: number | null) => (s == null ? "" : s >= 75 ? "ok" : s >= 50 ? "warn" : "bad");
const pct = (v: number | null) => (v == null ? "—" : `${v} %`);
const phone = (p: string, show: boolean) => (show ? p : maskPhone(p)) || "—";
const DIR = { in: "Входящий", out: "Исходящий", unknown: "—" } as const;

export interface HtmlOptions { showPhones?: boolean; /** Ссылки в общем кабинете */ links?: { manager: (name: string) => string; call: (id: string) => string } }
const mLink = (name: string, o: HtmlOptions) => (o.links ? `<a href="${esc(o.links.manager(name))}">${esc(name)}</a>` : esc(name));
const cLink = (r: CallRecord, o: HtmlOptions) => (o.links ? `<a href="${esc(o.links.call(r.meta.id))}">${esc(ruDateTime(r.meta.date))}</a>` : esc(ruDateTime(r.meta.date)));

/** Карточка звонка */
export function callHtml(r: CallRecord, o: HtmlOptions = {}): string {
  const v = r.review, m = r.metrics;
  const tiles = [
    `<div class="tile ${scoreClass(v?.score ?? null)}"><b>${v?.score ?? "—"}</b><span>Балл по скрипту</span></div>`,
    `<div class="tile"><b>${esc(dur(m.duration))}</b><span>Длительность</span></div>`,
    `<div class="tile ${m.talkRatio > 70 ? "warn" : ""}"><b>${m.talkRatio} %</b><span>Говорит менеджер</span></div>`,
    `<div class="tile"><b>${m.questions}</b><span>Вопросов задано</span></div>`,
    `<div class="tile ${m.interruptions >= 3 ? "warn" : ""}"><b>${m.interruptions}</b><span>Перебиваний</span></div>`,
  ].join("");
  const hints = metricHints(m);
  const items = v ? `<div class="card"><h2>Скрипт</h2><table><tr><th>Пункт</th><th>Выполнен</th><th>Цитата</th></tr>${v.items.map(i => `<tr><td>${esc(i.title)}</td><td><span class="st ${i.status}">${STATUS[i.status]}</span>${i.unverified ? `<div class="warnline">нет цитаты — проверьте</div>` : ""}</td><td>${i.quote ? `<span class="tc">${fmtTime(i.t ?? 0)}</span> <q>${esc(i.quote)}</q>` : `<span class="note">${esc(i.comment ?? "")}</span>`}</td></tr>`).join("")}</table></div>` : "";
  const objs = v?.objections.length ? `<div class="card"><h2>Возражения</h2><table><tr><th>Клиент</th><th>Ответ менеджера</th><th>Как лучше</th></tr>${v.objections.map(x => `<tr><td><b>${esc(OBJECTION_TYPES[x.type])}</b><br><span class="tc">${fmtTime(x.t ?? 0)}</span> <q>${esc(x.quote)}</q></td><td><span class="st ${x.handled === "yes" ? "yes" : x.handled === "partial" ? "partial" : "no"}">${x.handled === "yes" ? "Отработал" : x.handled === "partial" ? "Частично" : "Не ответил"}</span>${x.answer ? `<br><q>${esc(x.answer)}</q>` : ""}</td><td class="note">${esc(x.better)}</td></tr>`).join("")}</table></div>` : "";
  const deal = v ? `<div class="card"><h2>Сделка</h2>
    ${v.missed ? `<p><span class="flag">Упущенная сделка</span> ${esc(v.missedReason)}</p>` : ""}
    <p><b>Итог:</b> ${esc(OUTCOMES[v.outcome])} · <b>Интерес клиента:</b> ${esc(INTEREST[v.interest.level])}${v.interest.quote ? ` — <q>${esc(v.interest.quote)}</q>` : ""}</p>
    <p><b>Следующий шаг:</b> ${v.nextStep.agreed ? `${esc(v.nextStep.text)}${v.nextStep.due ? ` · до ${ruDate(v.nextStep.due)}` : ""} <q>${esc(v.nextStep.quote)}</q>` : "не назначен"}</p>
    ${v.summary ? `<p>${esc(v.summary)}</p>` : ""}
    ${v.advice.length ? `<div class="advice"><b>Советы менеджеру</b> <span class="note">(предложение модели)</span><ul>${v.advice.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}
    ${v.warnings.map(w => `<p class="warnline">${esc(w)}</p>`).join("")}</div>` : "";
  const chat = `<div class="card"><h2>Расшифровка</h2><div class="chat">${r.transcript.turns.map(t => `<p class="${t.role === "manager" ? "m" : "c"}"><span class="tc">${fmtTime(t.start)}</span><span class="who">${roleLabel(t.role)}</span><span>${esc(t.text)}</span></p>`).join("")}</div>
    <p class="note">${r.transcript.layout === "stereo" ? "Стереозапись: менеджер и клиент разделены по каналам." : "Моно: голоса разделены автоматически."} ${r.transcript.roles.confident ? "" : "Роли определены по порядку реплик — если перепутаны, нажмите «Поменять роли» в приложении."}</p></div>`;
  return page(`Звонок ${r.meta.manager} ${ruDateTime(r.meta.date)}`, `
    <div class="kicker">Контроль звонков · карточка звонка</div>
    <h1>${esc(r.meta.manager)} · ${esc(ruDateTime(r.meta.date))}</h1>
    <div class="meta">${DIR[r.meta.direction]} · клиент ${esc(phone(r.meta.client, !!o.showPhones))} · ${esc(r.meta.source)}${v ? ` · модель ${esc(v.model)}` : ""}</div>
    <div class="tiles">${tiles}</div>
    ${hints.length ? `<div class="card"><h2>По метрикам</h2><ul>${hints.map(h => `<li>${esc(h)}</li>`).join("")}</ul></div>` : ""}
    ${deal}${items}${objs}${chat}`);
}

function itemTable(items: { title: string; rate: number; yes: number; partial: number; no: number }[]) {
  if (!items.length) return `<p class="note">Нет оценённых звонков.</p>`;
  return `<table><tr><th>Пункт скрипта</th><th class="num">Выполнение</th><th></th><th class="num">Да / частично / нет</th></tr>${items.map(i => `<tr><td>${esc(i.title)}</td><td class="num">${i.rate} %</td><td style="width:30%"><div class="bar"><i style="width:${i.rate}%"></i></div></td><td class="num">${i.yes} / ${i.partial} / ${i.no}</td></tr>`).join("")}</table>`;
}
function objTable(o: Partial<Record<ObjectionType, number>>) {
  const e = Object.entries(o).sort((a, b) => b[1]! - a[1]!);
  if (!e.length) return `<p class="note">Возражений не было.</p>`;
  return `<table><tr><th>Возражение</th><th class="num">Сколько раз</th></tr>${e.map(([k, n]) => `<tr><td>${esc(OBJECTION_TYPES[k as ObjectionType])}</td><td class="num">${n}</td></tr>`).join("")}</table>`;
}
function trend(w: { week: string; calls: number; avgScore: number | null }[]) {
  const pts = w.filter(x => x.avgScore != null);
  if (pts.length < 2) return "";
  const W = 600, H = 120, P = 24;
  const xy = pts.map((p, i) => [P + (i * (W - 2 * P)) / (pts.length - 1), H - P - ((p.avgScore! / 100) * (H - 2 * P))]);
  return `<h3>Средний балл по неделям</h3><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Средний балл по неделям"><polyline fill="none" stroke="#C2410C" stroke-width="2.5" points="${xy.map(p => p.join(",")).join(" ")}"/>${xy.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#C2410C"/><text x="${p[0]}" y="${p[1] - 8}" font-size="11" text-anchor="middle" fill="#1A1A19">${pts[i].avgScore}</text><text x="${p[0]}" y="${H - 4}" font-size="10" text-anchor="middle" fill="#5C5C57">${esc(pts[i].week.slice(5))}</text>`).join("")}</svg>`;
}

function missedTable(recs: CallRecord[], o: HtmlOptions) {
  const m = recs.filter(r => r.review?.missed);
  if (!m.length) return `<p class="note">Упущенных сделок нет.</p>`;
  return `<table><tr><th>Дата</th><th>Менеджер</th><th>Клиент</th><th>Что сказал клиент</th><th>Статус</th></tr>${m.map(r => `<tr><td class="num">${cLink(r, o)}</td><td>${mLink(r.meta.manager, o)}</td><td class="num">${esc(phone(r.meta.client, !!o.showPhones))}</td><td><q>${esc(r.review!.interest.quote)}</q><div class="note">${esc(r.review!.summary)}</div></td><td>${r.followUp?.status === "done" ? "перезвонили" : r.followUp?.status === "crm" ? "в CRM" : "на перезвон"}</td></tr>`).join("")}</table>`;
}

/** Отчёт по менеджеру */
export function managerHtml(s: ManagerStat, recs: CallRecord[], o: HtmlOptions & { from?: string; to?: string } = {}): string {
  return page(`Отчёт: ${s.manager}`, `
    <div class="kicker">Контроль звонков · отчёт по менеджеру</div>
    <h1>${esc(s.manager)}</h1>
    <div class="meta">${o.from ? `${ruDate(o.from)} — ${ruDate(o.to ?? o.from)} · ` : ""}${s.calls} звонков, оценено ${s.scored}</div>
    <div class="tiles">
      <div class="tile ${scoreClass(s.avgScore)}"><b>${s.avgScore ?? "—"}</b><span>Средний балл</span></div>
      <div class="tile"><b>${s.sales}</b><span>Продаж и записей</span></div>
      <div class="tile"><b>${s.nextSteps}</b><span>Назначен следующий шаг</span></div>
      <div class="tile ${s.missed ? "bad" : ""}"><b>${s.missed}</b><span>Упущенных сделок</span></div>
      <div class="tile"><b>${pct(s.handled)}</b><span>Возражений отработано</span></div>
      <div class="tile"><b>${pct(s.talkRatio)}</b><span>Доля речи</span></div>
    </div>
    ${s.weakest.length ? `<div class="card"><h2>Над чем поработать</h2><ul>${s.weakest.map(i => `<li>${esc(i.title)} — выполняется в ${i.rate} % звонков</li>`).join("")}</ul></div>` : ""}
    <div class="card"><h2>Скрипт</h2>${itemTable(s.items)}${trend(s.weeks)}</div>
    <div class="card"><h2>Возражения</h2>${objTable(s.objectionTypes)}</div>
    <div class="card"><h2>Упущенные сделки</h2>${missedTable(recs, o)}</div>
    <div class="card"><h2>Звонки</h2><table><tr><th>Дата</th><th>Клиент</th><th class="num">Длительность</th><th class="num">Балл</th><th>Итог</th></tr>${recs.map(r => `<tr><td class="num">${cLink(r, o)}</td><td class="num">${esc(phone(r.meta.client, !!o.showPhones))}</td><td class="num">${esc(dur(r.metrics.duration))}</td><td class="num">${r.review?.score ?? "—"}</td><td>${esc(r.review ? OUTCOMES[r.review.outcome] : "не оценён")}${r.review?.missed ? ` <span class="st no">упущена</span>` : ""}</td></tr>`).join("")}</table></div>`);
}

/** Сводка за период по отделу */
export function periodHtml(p: PeriodSummary, recs: CallRecord[], o: HtmlOptions = {}): string {
  return page(`Сводка ${ruDate(p.from)} — ${ruDate(p.to)}`, `
    <div class="kicker">Контроль звонков · сводка за период</div>
    <h1>Звонки отдела: ${esc(ruDate(p.from))} — ${esc(ruDate(p.to))}</h1>
    <div class="meta">${p.calls} звонков, оценено по скрипту ${p.scored}, менеджеров ${p.managers.length}</div>
    <div class="tiles">
      <div class="tile ${scoreClass(p.avgScore)}"><b>${p.avgScore ?? "—"}</b><span>Средний балл</span></div>
      <div class="tile"><b>${p.outcomes.sale ?? 0}</b><span>Продаж и записей</span></div>
      <div class="tile"><b>${p.outcomes.next_step ?? 0}</b><span>Следующий шаг</span></div>
      <div class="tile"><b>${p.outcomes.refusal ?? 0}</b><span>Отказов</span></div>
      <div class="tile ${p.missed ? "bad" : ""}"><b>${p.missed}</b><span>Упущенных сделок</span></div>
    </div>
    <div class="card"><h2>Рейтинг менеджеров</h2><table><tr><th>Менеджер</th><th class="num">Звонков</th><th class="num">Балл</th><th class="num">Продажи</th><th class="num">След. шаг</th><th class="num">Упущено</th><th class="num">Возражения</th><th>Слабое место</th></tr>${p.managers.map(s => `<tr><td>${mLink(s.manager, o)}</td><td class="num">${s.calls}</td><td class="num">${s.avgScore ?? "—"}</td><td class="num">${s.sales}</td><td class="num">${s.nextSteps}</td><td class="num">${s.missed}</td><td class="num">${pct(s.handled)}</td><td class="note">${esc(s.weakest[0]?.title ?? "—")}</td></tr>`).join("")}</table>${trend(p.weeks)}</div>
    <div class="card"><h2>Упущенные сделки — на перезвон</h2>${missedTable(recs, o)}</div>
    <div class="card"><h2>Скрипт по отделу</h2>${itemTable(p.items)}</div>
    <div class="card"><h2>Частые возражения</h2>${objTable(p.objectionTypes)}</div>`);
}
