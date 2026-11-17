// Упущенные сделки → CRM и задачи: amoCRM (сделка + задача «перезвонить»), Битрикс24 (лид + задача), YouGile (задача),
// Telegram (сводка руководителю). Данные уходят только по кнопке и только в сервисы, которые пользователь подключил сам.
import { netFetch } from "../asr/net.js";
import type { CrmConfig } from "../config.js";
import { OUTCOMES } from "../analyze/review.js";
import { maskPhone } from "../import/sources.js";
import type { CallRecord } from "../types.js";
import type { PeriodSummary } from "../report/aggregate.js";

export interface SendResult { target: string; ok: boolean; link?: string; error?: string }

const ruDate = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}.${m}.${y}`; };
export function dealText(r: CallRecord): string {
  const v = r.review!;
  return [
    `Звонок ${ruDate(r.meta.date)} ${r.meta.date.slice(11, 16)}, менеджер ${r.meta.manager}.`,
    v.interest.quote ? `Клиент: «${v.interest.quote}»` : "",
    v.summary, v.missedReason ? `Почему упущена: ${v.missedReason}` : "",
    v.objections.length ? `Возражения: ${v.objections.map(o => `«${o.quote}»`).join("; ")}` : "",
    "Создано Контролем звонков",
  ].filter(Boolean).join("\n");
}

async function json(r: Response, what: string) {
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(`${what}: ${j?.error_description ?? j?.title ?? j?.error ?? j?.detail ?? `HTTP ${r.status}`}${r.status === 401 ? " — проверьте ключ" : ""}`);
  return j;
}

export const validAmoDomain = (d: string) => /^[a-z0-9][a-z0-9-]{0,62}\.(amocrm\.ru|amocrm\.com|kommo\.com)$/i.test(d.trim());
export function validBitrixWebhook(url: string): string | null {
  try { const u = new URL(url); if (u.protocol !== "https:") return "Нужен адрес https://"; if (!/\/rest\/\d+\/[\w-]+\/?$/.test(u.pathname)) return "Адрес вебхука: https://портал.bitrix24.ru/rest/1/код/"; return null; } catch { return "Это не адрес вебхука"; }
}

export async function toAmo(r: CallRecord, c: NonNullable<CrmConfig["amocrm"]>): Promise<SendResult> {
  if (!validAmoDomain(c.domain)) return { target: "amoCRM", ok: false, error: "Домен amoCRM вида компания.amocrm.ru" };
  const base = `https://${c.domain.trim().toLowerCase()}/api/v4`;
  const h = { "content-type": "application/json", authorization: `Bearer ${c.token}` };
  try {
    const lead = [{ name: `Перезвонить: звонок ${ruDate(r.meta.date)} (${r.meta.manager})`.slice(0, 250), ...(c.pipelineId ? { pipeline_id: c.pipelineId } : {}),
      _embedded: { contacts: r.meta.client ? [{ first_name: "Клиент " + maskPhone(r.meta.client), custom_fields_values: [{ field_code: "PHONE", values: [{ value: r.meta.client, enum_code: "WORK" }] }] }] : [] } }];
    const j = await json(await netFetch("integration", `${base}/leads/complex`, { method: "POST", headers: h, body: JSON.stringify(lead) }), "amoCRM");
    const id = j?.[0]?.id ?? j?._embedded?.leads?.[0]?.id;
    if (id) {
      await json(await netFetch("integration", `${base}/leads/notes`, { method: "POST", headers: h, body: JSON.stringify([{ entity_id: id, note_type: "common", params: { text: dealText(r) } }]) }), "amoCRM");
      await json(await netFetch("integration", `${base}/tasks`, { method: "POST", headers: h, body: JSON.stringify([{ text: "Перезвонить клиенту: интерес был, следующий шаг не назначен", complete_till: Math.floor(Date.now() / 1000) + 86400, entity_id: id, entity_type: "leads" }]) }), "amoCRM");
    }
    return { target: "amoCRM", ok: true, link: id ? `https://${c.domain}/leads/detail/${id}` : undefined };
  } catch (e: any) { return { target: "amoCRM", ok: false, error: String(e.message ?? e) }; }
}

export async function toBitrix(r: CallRecord, c: NonNullable<CrmConfig["bitrix24"]>): Promise<SendResult> {
  const bad = validBitrixWebhook(c.webhook);
  if (bad) return { target: "Битрикс24", ok: false, error: bad };
  const base = c.webhook.replace(/\/?$/, "/");
  const call = async (m: string, body: object) => (await json(await netFetch("integration", `${base}${m}.json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), "Битрикс24")).result;
  try {
    const lead = await call("crm.lead.add", { fields: { TITLE: `Перезвонить: звонок ${ruDate(r.meta.date)} (${r.meta.manager})`, ...(r.meta.client ? { PHONE: [{ VALUE: r.meta.client, VALUE_TYPE: "WORK" }] } : {}), COMMENTS: dealText(r), SOURCE_ID: "CALL" } });
    const owner = c.responsible ?? Number(base.match(/\/rest\/(\d+)\//)?.[1] ?? 1);
    await call("tasks.task.add", { fields: { TITLE: "Перезвонить клиенту: интерес был, следующий шаг не назначен", DESCRIPTION: dealText(r), RESPONSIBLE_ID: owner, UF_CRM_TASK: [`L_${lead}`], DEADLINE: new Date(Date.now() + 86400_000).toISOString() } });
    return { target: "Битрикс24", ok: true, link: `${base.replace(/\/rest\/.*$/, "")}/crm/lead/details/${lead}/` };
  } catch (e: any) { return { target: "Битрикс24", ok: false, error: String(e.message ?? e) }; }
}

export async function toYouGile(r: CallRecord, c: NonNullable<CrmConfig["yougile"]>): Promise<SendResult> {
  try {
    if (!/^[\w-]{8,64}$/.test(c.columnId ?? "")) throw new Error("Укажите ID колонки YouGile");
    const j = await json(await netFetch("integration", "https://ru.yougile.com/api-v2/tasks", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` }, body: JSON.stringify({ title: `Перезвонить: ${r.meta.manager}, ${ruDate(r.meta.date)}`, columnId: c.columnId, description: dealText(r).replace(/\n/g, "<br>") }) }), "YouGile");
    return { target: "YouGile", ok: true, link: j?.id ? `https://ru.yougile.com/team/` : undefined };
  } catch (e: any) { return { target: "YouGile", ok: false, error: String(e.message ?? e) }; }
}

export function summaryText(p: PeriodSummary): string {
  return [
    `Контроль звонков: ${ruDate(p.from)} — ${ruDate(p.to)}`,
    `Звонков ${p.calls}, оценено ${p.scored}, средний балл ${p.avgScore ?? "—"}`,
    `Продажи ${p.outcomes.sale ?? 0} · следующий шаг ${p.outcomes.next_step ?? 0} · отказы ${p.outcomes.refusal ?? 0} · упущено ${p.missed}`,
    "", ...p.managers.slice(0, 15).map(m => `${m.manager}: балл ${m.avgScore ?? "—"}, звонков ${m.calls}, упущено ${m.missed}${m.weakest[0] ? `, слабое место — ${m.weakest[0].title}` : ""}`),
  ].join("\n");
}

export async function toTelegram(text: string, c: NonNullable<CrmConfig["telegram"]>): Promise<SendResult> {
  try {
    if (!/^\d+:[\w-]{30,}$/.test(c.token ?? "")) throw new Error("Токен бота вида 123456:ABC…");
    if (!/^-?\d{3,20}$|^@\w{4,}$/.test(String(c.chatId ?? ""))) throw new Error("ID чата: число или @канал");
    await json(await netFetch("integration", `https://api.telegram.org/bot${c.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: c.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }) }), "Telegram");
    return { target: "Telegram", ok: true };
  } catch (e: any) { return { target: "Telegram", ok: false, error: String(e.message ?? e).replace(c.token ?? "\0", "***") }; }
}

/** Отправить упущенную сделку во все подключённые CRM */
export async function sendDeal(r: CallRecord, c: CrmConfig): Promise<SendResult[]> {
  if (!r.review?.missed && r.review?.outcome !== "no_decision") throw new Error("Это не упущенная сделка");
  const out: SendResult[] = [];
  if (c.amocrm?.domain && c.amocrm.token) out.push(await toAmo(r, c.amocrm));
  if (c.bitrix24?.webhook) out.push(await toBitrix(r, c.bitrix24));
  if (c.yougile?.key) out.push(await toYouGile(r, c.yougile));
  if (c.telegram?.token) out.push(await toTelegram(`Упущенная сделка\n${dealText(r)}\nИтог: ${OUTCOMES[r.review!.outcome]}`, c.telegram));
  if (!out.length) throw new Error("Не подключена ни одна CRM: amoCRM, Битрикс24, YouGile или Telegram — в настройках");
  return out;
}
