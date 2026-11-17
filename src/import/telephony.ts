// Загрузка записей звонков из телефонии по API (ключ пользователя): Манго Офис, Sipuni, UIS, CoMagic, Новофон,
// Битрикс24, Zadarma, Билайн Бизнес. Записи скачиваются в папку «входящие» архива и дальше обрабатываются локально.
// Это одно из немногих мест, где программа ходит в сеть, — только когда пользователь подключил телефонию сам.
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { netFetch } from "../asr/net.js";
import type { TelephonyConfig } from "../config.js";
import type { CallMeta, Direction } from "../types.js";
import { callId, normPhone } from "./sources.js";

export interface RemoteCall { id: string; date: string; manager: string; client: string; direction: Direction; duration: number; fetchRecord: () => Promise<Response> }

export const TELEPHONY: Record<Exclude<TelephonyConfig["provider"], "">, { title: string; fields: string[]; help: string[] }> = {
  mango: { title: "Манго Офис", fields: ["key", "secret"], help: ["Личный кабинет → Интеграции → API Коннектор", "Скопируйте «Уникальный код АТС» (ключ) и «Ключ для создания подписи» (соль)", "Включите право на получение статистики и записей"] },
  sipuni: { title: "Sipuni", fields: ["user", "secret"], help: ["Кабинет Sipuni → Настройки → Интеграции → API", "Номер пользователя (user) и секретный ключ"] },
  uis: { title: "UIS", fields: ["token"], help: ["Кабинет UIS → Настройки → Пользователи API", "Создайте пользователя с правом «Отчёт по звонкам» и скопируйте постоянный токен"] },
  comagic: { title: "CoMagic", fields: ["token"], help: ["Кабинет CoMagic → Настройки → Пользователи API", "Постоянный токен с правом «Отчёт по звонкам»"] },
  novofon: { title: "Новофон", fields: ["token"], help: ["Кабинет Новофон → Настройки → API", "Постоянный токен Data API с правом на отчёт по звонкам"] },
  bitrix24: { title: "Битрикс24 (телефония)", fields: ["webhook"], help: ["Битрикс24 → Разработчикам → Другое → Входящий вебхук", "Права: «Телефония» (telephony), «Пользователи» (user), «Диск» (disk)", "Скопируйте адрес вида https://ваш-портал.bitrix24.ru/rest/1/код/"] },
  zadarma: { title: "Zadarma", fields: ["key", "secret"], help: ["Кабинет Zadarma → Настройки → API и интеграции", "Ключ (key) и секрет (secret)", "Включите запись разговоров в настройках АТС"] },
  beeline: { title: "Билайн Бизнес (облачная АТС)", fields: ["token"], help: ["Кабинет облачной АТС → Настройки → API", "Скопируйте токен X-MPBX-API-AUTH-TOKEN"] },
};

const fmt = (d: Date, sep = " ") => { const p = (x: number) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${sep}${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const iso = (s: string) => s.replace(" ", "T").slice(0, 19);
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const need = (c: TelephonyConfig, ...k: (keyof TelephonyConfig)[]) => { for (const x of k) if (!c[x]) throw new Error(`Не задан ключ телефонии: ${x}`); };

async function ok(r: Response, what: string) {
  if (r.ok) return r;
  const t = await r.text().catch(() => "");
  throw new Error(`${what}: ответ ${r.status}${r.status === 401 || r.status === 403 ? " — проверьте ключ и права" : ""} ${t.slice(0, 200)}`);
}

// ── Zadarma: подпись base64(hex(HMAC-SHA1(method + params + md5(params), secret)))
export function zadarmaSign(method: string, params: Record<string, string>, secret: string) {
  const q = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]).replace(/%20/g, "+")}`).join("&");
  return { q, sign: Buffer.from(createHmac("sha1", secret).update(method + q + md5(q)).digest("hex")).toString("base64") };
}
async function zadarma(c: TelephonyConfig, from: Date, to: Date, base = "https://api.zadarma.com"): Promise<RemoteCall[]> {
  need(c, "key", "secret");
  const get = async (method: string, params: Record<string, string>) => {
    const { q, sign } = zadarmaSign(method, params, c.secret!);
    const r = await ok(await netFetch("integration", `${base}${method}?${q}`, { headers: { Authorization: `${c.key}:${sign}` } }), "Zadarma");
    return r.json() as Promise<any>;
  };
  const j = await get("/v1/statistics/pbx/", { start: fmt(from), end: fmt(to), version: "2" });
  return (j.stats ?? []).filter((s: any) => s.is_recorded === "true" || s.is_recorded === true || s.is_recorded === 1).map((s: any) => ({
    id: String(s.pbx_call_id ?? s.call_id), date: iso(String(s.callstart)), manager: String(s.sip ?? s.extension ?? ""),
    client: normPhone(String(s.clid ?? s.destination ?? "")), direction: (s.call_type === "out" || s.direction === "out" ? "out" : s.call_type === "in" || s.direction === "in" ? "in" : "unknown") as Direction,
    duration: Number(s.seconds ?? 0),
    fetchRecord: async () => {
      const rr = await get("/v1/pbx/record/request/", { pbx_call_id: String(s.pbx_call_id), lifetime: "3600" });
      const link = rr.link ?? rr.links?.[0];
      if (!link) throw new Error("Zadarma не отдала ссылку на запись");
      return netFetch("integration", httpsOnly(link));
    },
  }));
}

// ── Манго Офис: sign = sha256(key + json + salt), отчёт — асинхронно: stats/request → stats/result (CSV через «;»)
export const mangoSign = (key: string, json: string, salt: string) => createHash("sha256").update(key + json + salt).digest("hex");
async function mango(c: TelephonyConfig, from: Date, to: Date, base = "https://app.mango-office.ru/vpbx"): Promise<RemoteCall[]> {
  need(c, "key", "secret");
  const post = (path: string, data: object) => {
    const json = JSON.stringify(data);
    const body = new URLSearchParams({ vpbx_api_key: c.key!, sign: mangoSign(c.key!, json, c.secret!), json });
    return netFetch("integration", `${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  };
  const fields = "records, start, finish, from_extension, from_number, to_extension, to_number, disconnect_reason, entry_id";
  const req: any = await (await ok(await post("/stats/request", { date_from: String(Math.floor(+from / 1000)), date_to: String(Math.floor(+to / 1000)), fields }), "Манго Офис")).json();
  if (!req.key) throw new Error("Манго Офис не принял запрос статистики");
  let csv = "";
  for (let i = 0; i < 20; i++) {
    const r = await post("/stats/result", { key: req.key });
    if (r.status === 204) { await new Promise(res => setTimeout(res, 1500)); continue; }
    csv = await (await ok(r, "Манго Офис")).text();
    break;
  }
  return csv.split(/\r?\n/).filter(Boolean).flatMap(line => {
    const [records, start, finish, fromExt, fromNum, toExt, toNum, , entry] = line.split(";");
    const recs = (records ?? "").replace(/[\[\]]/g, "").split(",").map(s => s.trim()).filter(Boolean);
    if (!recs.length) return [];
    const out = !!fromExt && !toExt;
    return [{
      id: String(entry || recs[0]), date: iso(fmt(new Date(Number(start) * 1000))), manager: String(out ? fromExt : toExt || ""),
      client: normPhone(out ? toNum : fromNum), direction: (out ? "out" : "in") as Direction, duration: Math.max(0, Number(finish) - Number(start)),
      fetchRecord: async () => post("/queries/recording/post", { recording_id: recs[0], action: "download" }),
    }];
  });
}

// ── Sipuni: hash = md5(значения параметров в алфавитном порядке ключей через «+» + «+» + секрет)
export function sipuniHash(params: Record<string, string>, secret: string) {
  return md5([...Object.keys(params).sort().map(k => params[k]), secret].join("+"));
}
async function sipuni(c: TelephonyConfig, from: Date, to: Date, base = "https://sipuni.com/api"): Promise<RemoteCall[]> {
  need(c, "user", "secret");
  const d = (x: Date) => `${String(x.getDate()).padStart(2, "0")}.${String(x.getMonth() + 1).padStart(2, "0")}.${x.getFullYear()}`;
  const p: Record<string, string> = { anonymous: "1", firstTime: "0", from: d(from), fromNumber: "", rating: "", showTreeId: "0", state: "0", timeFrom: "", timeTo: "", to: d(to), toAnswer: "", toNumber: "", tree: "", type: "0", user: c.user! };
  const body = new URLSearchParams({ ...p, hash: sipuniHash(p, c.secret!) });
  const text = await (await ok(await netFetch("integration", `${base}/statistic/export`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }), "Sipuni")).text();
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map(l => l.split(";"));
  const h = rows[0] ?? [];
  const col = (re: RegExp) => h.findIndex(x => re.test(x));
  const ci = { type: col(/^тип/i), date: col(/^время|^дата/i), from: col(/^откуда/i), to: col(/^куда/i), who: col(/^кто ответил|^сотрудник/i), dur: col(/длительность разговора|^длительность/i), rec: col(/^id записи/i), has: col(/запись существует/i) };
  return rows.slice(1).filter(r => ci.rec >= 0 && r[ci.rec] && (ci.has < 0 || /1|да/i.test(r[ci.has]))).map(r => {
    const out = /исход/i.test(r[ci.type] ?? "");
    const id = r[ci.rec];
    return {
      id, date: iso(r[ci.date] ? r[ci.date].replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1") : ""), manager: String(r[ci.who] ?? ""),
      client: normPhone(out ? r[ci.to] : r[ci.from]), direction: (out ? "out" : "in") as Direction, duration: Number(r[ci.dur] ?? 0),
      fetchRecord: () => netFetch("integration", `${base}/statistic/record`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, user: c.user!, hash: md5([id, c.user!, c.secret!].join("+")) }).toString() }),
    };
  });
}

// ── UIS / CoMagic / Новофон: Data API JSON-RPC, get.calls_report; запись — по ссылке на медиа сервиса
const DATA_API: Record<string, { api: string; media: string }> = {
  uis: { api: "https://dataapi.uiscom.ru/v2.0", media: "https://app.uiscom.ru/system/media/talk" },
  comagic: { api: "https://dataapi.comagic.ru/v2.0", media: "https://app.comagic.ru/system/media/talk" },
  novofon: { api: "https://dataapi.novofon.ru/v2.0", media: "https://my.novofon.ru/system/media/talk" },
};
async function dataApi(c: TelephonyConfig, from: Date, to: Date, kind: "uis" | "comagic" | "novofon", hosts = DATA_API[kind]): Promise<RemoteCall[]> {
  need(c, "token");
  const body = { jsonrpc: "2.0", id: 1, method: "get.calls_report", params: { access_token: c.token, date_from: fmt(from), date_till: fmt(to), limit: 10000, fields: ["id", "start_time", "direction", "contact_phone_number", "talk_duration", "call_records", "employees"] } };
  const j: any = await (await ok(await netFetch("integration", hosts.api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), TELEPHONY[kind].title)).json();
  if (j.error) throw new Error(`${TELEPHONY[kind].title}: ${j.error.message ?? "ошибка API"}`);
  return (j.result?.data ?? []).filter((x: any) => x.call_records?.length).map((x: any) => ({
    id: String(x.id), date: iso(String(x.start_time)), manager: String(x.employees?.[0]?.employee_full_name ?? ""),
    client: normPhone(String(x.contact_phone_number ?? "")), direction: (x.direction === "out" ? "out" : x.direction === "in" ? "in" : "unknown") as Direction,
    duration: Number(x.talk_duration ?? 0),
    fetchRecord: () => netFetch("integration", `${hosts.media}/${encodeURIComponent(String(x.id))}/${encodeURIComponent(String(x.call_records[0]))}/`),
  }));
}

// ── Битрикс24: voximplant.statistic.get; запись — CALL_RECORD_URL или файл на Диске (disk.file.get → DOWNLOAD_URL)
async function bitrix(c: TelephonyConfig, from: Date, to: Date): Promise<RemoteCall[]> {
  need(c, "webhook");
  const base = httpsOnly(c.webhook!).replace(/\/?$/, "/");
  if (!/\/rest\/\d+\/[\w-]+\/$/.test(base)) throw new Error("Адрес вебхука Битрикс24 должен выглядеть так: https://портал.bitrix24.ru/rest/1/код/");
  const call = async (m: string, body: object) => { const j: any = await (await ok(await netFetch("integration", `${base}${m}.json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), "Битрикс24")).json(); if (j.error) throw new Error(`Битрикс24: ${j.error_description ?? j.error}`); return j; };
  const out: any[] = [];
  let start = 0;
  for (let i = 0; i < 50; i++) {
    const j = await call("voximplant.statistic.get", { FILTER: { ">=CALL_START_DATE": from.toISOString(), "<=CALL_START_DATE": to.toISOString() }, SORT: "CALL_START_DATE", ORDER: "ASC", start });
    out.push(...(j.result ?? []));
    if (j.next === undefined) break;
    start = j.next;
  }
  const users = new Map<string, string>();
  const userName = async (id: string) => {
    if (!id) return "";
    if (!users.has(id)) { const u = await call("user.get", { ID: id }).catch(() => null); const x = u?.result?.[0]; users.set(id, x ? `${x.LAST_NAME ?? ""} ${x.NAME ?? ""}`.trim() : id); }
    return users.get(id)!;
  };
  const res: RemoteCall[] = [];
  for (const s of out.filter(x => x.CALL_RECORD_URL || x.RECORD_FILE_ID)) {
    res.push({
      id: String(s.CALL_ID ?? s.ID), date: iso(String(s.CALL_START_DATE).slice(0, 19)), manager: await userName(String(s.PORTAL_USER_ID ?? "")),
      client: normPhone(String(s.PHONE_NUMBER ?? "")), direction: (String(s.CALL_TYPE) === "1" ? "out" : String(s.CALL_TYPE) === "2" ? "in" : "unknown") as Direction,
      duration: Number(s.CALL_DURATION ?? 0),
      fetchRecord: async () => {
        if (s.RECORD_FILE_ID) { const f = await call("disk.file.get", { id: s.RECORD_FILE_ID }); if (f.result?.DOWNLOAD_URL) return netFetch("integration", httpsOnly(f.result.DOWNLOAD_URL)); }
        return netFetch("integration", httpsOnly(String(s.CALL_RECORD_URL)));
      },
    });
  }
  return res;
}

// ── Билайн Бизнес: облачная АТС, заголовок X-MPBX-API-AUTH-TOKEN
async function beeline(c: TelephonyConfig, from: Date, to: Date, base = "https://cloudpbx.beeline.ru/apis/portal"): Promise<RemoteCall[]> {
  need(c, "token");
  const h = { "X-MPBX-API-AUTH-TOKEN": c.token! };
  const q = new URLSearchParams({ dateFrom: from.toISOString(), dateTo: to.toISOString() });
  const list: any[] = await (await ok(await netFetch("integration", `${base}/records?${q}`, { headers: h }), "Билайн")).json();
  return (Array.isArray(list) ? list : []).map(x => ({
    id: String(x.id), date: iso(fmt(new Date(Number(x.date)))), manager: [x.abonent?.lastName, x.abonent?.firstName].filter(Boolean).join(" ") || String(x.abonent?.extension ?? x.abonent?.userId ?? ""),
    client: normPhone(String(x.phone ?? "")), direction: (/OUT/i.test(x.direction) ? "out" : /IN/i.test(x.direction) ? "in" : "unknown") as Direction,
    duration: Math.round(Number(x.duration ?? 0) / 1000),
    fetchRecord: () => netFetch("integration", `${base}/records/${encodeURIComponent(String(x.id))}/download`, { headers: h }),
  }));
}

export function httpsOnly(u: string): string {
  const url = new URL(u);
  if (url.protocol !== "https:") throw new Error("Разрешены только https-ссылки");
  return url.href;
}

/** Список звонков с записями за период */
export async function listRemote(c: TelephonyConfig, from: Date, to: Date): Promise<RemoteCall[]> {
  switch (c.provider) {
    case "zadarma": return zadarma(c, from, to);
    case "mango": return mango(c, from, to);
    case "sipuni": return sipuni(c, from, to);
    case "uis": case "comagic": case "novofon": return dataApi(c, from, to, c.provider);
    case "bitrix24": return bitrix(c, from, to);
    case "beeline": return beeline(c, from, to);
    default: throw new Error("Телефония не подключена");
  }
}

const MAX_RECORD = 300 * 1024 * 1024;
const EXT: Record<string, string> = { "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/webm": ".webm" };

/** Скачать новые записи за период в папку «входящие». Уже скачанные пропускаются. */
export async function fetchRecordings(c: TelephonyConfig, dir: string, from: Date, to: Date, onProgress?: (done: number, total: number) => void): Promise<{ metas: CallMeta[]; failed: { id: string; error: string }[] }> {
  const all = (await listRemote(c, from, to)).filter(x => x.duration >= (c.minSeconds ?? 0));
  const inbox = join(dir, "inbox", c.provider);
  mkdirSync(inbox, { recursive: true });
  const metas: CallMeta[] = [], failed: { id: string; error: string }[] = [];
  for (const [i, x] of all.entries()) {
    const safe = x.id.replace(/[^\w.-]/g, "_").slice(0, 60);
    const base = `${x.date.slice(0, 19).replace(/[:T]/g, "-")}_${safe}`;
    try {
      let file = [".mp3", ".wav", ".ogg", ".m4a", ".webm"].map(e => join(inbox, base + e)).find(existsSync);
      if (!file) {
        const r = await ok(await x.fetchRecord(), TELEPHONY[c.provider as keyof typeof TELEPHONY]?.title ?? "Телефония");
        const len = Number(r.headers.get("content-length") ?? 0);
        if (len > MAX_RECORD) throw new Error("запись больше 300 МБ");
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_RECORD) throw new Error("запись больше 300 МБ");
        if (buf.length < 1024) throw new Error("пустая запись");
        file = join(inbox, base + (EXT[(r.headers.get("content-type") ?? "").split(";")[0].trim()] ?? ".mp3"));
        writeFileSync(file, buf);
      }
      metas.push({ id: callId(file, 0, 0).slice(0, 4) + createHash("sha256").update(c.provider + x.id).digest("hex").slice(0, 12), file, manager: x.manager, client: x.client, direction: x.direction, date: x.date, source: TELEPHONY[c.provider as keyof typeof TELEPHONY]?.title ?? c.provider, externalId: x.id });
    } catch (e: any) { failed.push({ id: x.id, error: String(e?.message ?? e) }); }
    onProgress?.(i + 1, all.length);
  }
  return { metas, failed };
}

export { zadarma as _zadarma, mango as _mango, sipuni as _sipuni, dataApi as _dataApi, beeline as _beeline };
