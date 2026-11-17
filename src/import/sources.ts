// Импорт: папка с записями и выгрузки телефонии (CSV/XLSX) — Манго Офис, Sipuni, UIS/CoMagic, Битрикс24, Zadarma,
// Новофон, Билайн, МТС Exolve, Ростелеком и любые другие. Колонки узнаются по названиям, звонок сопоставляется с файлом
// по имени записи, номеру звонка или по времени и номеру клиента.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { CallMeta, Direction } from "../types.js";

export const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|wma|amr|webm|mp4|3gp)$/i;
export const MAX_FILES = 20000;

/** Записи в папке (с подпапками до 4 уровней), без ссылок и скрытых файлов */
export function scanFolder(dir: string, depth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, lvl: number) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      if (n.startsWith(".") || out.length >= MAX_FILES) continue;
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (lvl < depth) walk(p, lvl + 1); }
      else if (st.isFile() && AUDIO_EXT.test(n) && st.size >= 1024) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

export const PROVIDERS: { id: string; title: string; sign: RegExp }[] = [
  { id: "mango", title: "Манго Офис", sign: /(entry_id|from_extension|кто звонил.*кому звонили)/i },
  { id: "sipuni", title: "Sipuni", sign: /(id записи|запись существует|схема)/i },
  { id: "uis", title: "UIS / CoMagic", sign: /(communication_id|id сессии|id обращения|виртуальный номер)/i },
  { id: "bitrix24", title: "Битрикс24", sign: /(call_record_url|portal_user_id|call_type|ответственный.*тип звонка)/i },
  { id: "zadarma", title: "Zadarma", sign: /(pbx_call_id|callstart|is_recorded)/i },
  { id: "novofon", title: "Новофон", sign: /(novofon|новофон)/i },
  { id: "beeline", title: "Билайн Бизнес", sign: /(abonent|externalid|облачная атс)/i },
  { id: "mts", title: "МТС Exolve", sign: /(exolve|call_sid|mts)/i },
  { id: "rostelecom", title: "Ростелеком", sign: /(session_id|ростелеком|vats)/i },
];

/** Синонимы колонок выгрузок. Первое совпадение по порядку — главное. */
const COLS: Record<keyof ExportRow, RegExp[]> = {
  date: [/^(дата и время|дата\/время|время начала|начало|дата звонка|дата|date|start(_time)?|call_?start(_date)?|callstart|calldate|время звонка|время)$/i, /(дата|date|start|начал)/i],
  manager: [/^(сотрудник|менеджер|оператор|ответственный|ответил|employee(_full_name)?|portal_user(_id)?|abonent|agent|user|кто ответил|сотрудник \(имя\))$/i, /(сотрудник|менеджер|оператор|ответствен|employee|agent|абонент|extension|внутренн|from_extension|sip|user_id)/i],
  client: [/^(номер клиента|клиент|телефон клиента|контакт|номер контакта|contact_phone_number|phone(_number)?|clid|номер абонента)$/i, /(клиент|contact|caller|кто звонил|откуда|from_number|src|phone|номер)/i],
  direction: [/^(направление|тип звонка|тип вызова|тип|direction|call_type|вид звонка)$/i, /(направлен|тип|direction|type)/i],
  duration: [/^(длительность разговора|разговор|длительность|продолжительность|talk_duration|duration|seconds|billsec|call_duration)$/i, /(длительн|продолжит|duration|seconds|billsec)/i],
  record: [/^(запись|ссылка на запись|файл записи|имя файла|record(ing)?(_url)?|call_record_url|файл|id записи|records|call_records)$/i, /(запис|record|файл|file)/i],
  id: [/^(id|id звонка|номер звонка|call_?id|pbx_call_id|communication_id|entry_id|uniqueid|session_id|externalid)$/i, /(^id$|call_?id|uniqueid|entry_id|communication_id)/i],
};

export interface ExportRow { date: string; manager: string; client: string; direction: string; duration: string; record: string; id: string }

/** CSV с автоопределением разделителя (;, , или табуляция) и кавычками */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", "\t", ","].map(s => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

/** Читает выгрузку телефонии: CSV, XLSX или XLS. Возвращает строки и узнанного оператора. */
export async function readExport(file: string): Promise<{ provider: string; rows: ExportRow[]; columns: Partial<Record<keyof ExportRow, string>> }> {
  if (statSync(file).size > 100 * 1024 * 1024) throw new Error("Выгрузка больше 100 МБ — разбейте её по месяцам");
  const ext = extname(file).toLowerCase();
  let table: string[][];
  if (ext === ".xlsx" || ext === ".xls" || ext === ".ods") {
    const XLSX: any = await import("xlsx");
    const wb = XLSX.read(readFileSync(file), { type: "buffer", cellDates: true, dense: true });
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, dateNF: "yyyy-mm-dd hh:mm:ss" }).map((r: unknown[]) => r.map(x => (x == null ? "" : String(x))));
  } else {
    const buf = readFileSync(file);
    let text = buf.toString("utf8");
    if (text.includes("�")) text = new TextDecoder("windows-1251").decode(buf);
    table = parseCsv(text);
  }
  // строка заголовков — первая, где узнаётся хотя бы две колонки (у Манго и Sipuni сверху бывает шапка отчёта)
  let h = 0, cols: Partial<Record<keyof ExportRow, number>> = {};
  for (let i = 0; i < Math.min(10, table.length); i++) { const c = mapColumns(table[i]); if (Object.keys(c).length >= 2) { h = i; cols = c; break; } }
  const header = table[h] ?? [];
  const sig = header.join(" ") + " " + basename(file);
  const provider = PROVIDERS.find(p => p.sign.test(sig))?.title ?? "Выгрузка CSV/XLSX";
  const get = (r: string[], k: keyof ExportRow) => (cols[k] !== undefined ? String(r[cols[k]!] ?? "").trim() : "");
  const rows = table.slice(h + 1).slice(0, 200000).map(r => ({ date: get(r, "date"), manager: get(r, "manager"), client: get(r, "client"), direction: get(r, "direction"), duration: get(r, "duration"), record: get(r, "record"), id: get(r, "id") }));
  return { provider, rows, columns: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, header[i!]])) };
}

export function mapColumns(header: string[]): Partial<Record<keyof ExportRow, number>> {
  const out: Partial<Record<keyof ExportRow, number>> = {};
  const used = new Set<number>();
  const hs = header.map(x => String(x ?? "").trim());
  for (const pass of [0, 1]) {
    for (const k of Object.keys(COLS) as (keyof ExportRow)[]) {
      if (out[k] !== undefined) continue;
      const i = hs.findIndex((x, j) => x && !used.has(j) && COLS[k][pass].test(x));
      if (i >= 0) { out[k] = i; used.add(i); }
    }
  }
  return out;
}

export function parseDirection(s: string): Direction {
  const v = s.toLowerCase().trim();
  if (/^(2|in|inbound|incoming|входящ|вход)/.test(v) || /входящ|incoming|inbound/.test(v)) return "in";
  if (/^(1|out|outbound|outgoing|исходящ|исх)/.test(v) || /исходящ|outgoing|outbound/.test(v)) return "out";
  return "unknown";
}

/** Дата из выгрузки или имени файла → ISO «YYYY-MM-DDTHH:MM:SS» (местное время, без зоны) */
export function parseDate(s: string): string | null {
  if (!s) return null;
  const t = s.trim();
  if (/^\d{10}(\d{3})?$/.test(t)) { const ms = t.length === 13 ? Number(t) : Number(t) * 1000; const d = new Date(ms); return isNaN(+d) ? null : local(d); }
  let m = t.match(/(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[ T_\-]+(\d{2})[:\-.]?(\d{2})(?:[:\-.]?(\d{2}))?)?/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  m = t.match(/(\d{2})[./-](\d{2})[./-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[3]}-${m[2]}-${m[1]}T${(m[4] ?? "00").padStart(2, "0")}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  return null;
}
function local(d: Date) {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Номер телефона → +7XXXXXXXXXX (если российский), иначе цифры как есть */
export function normPhone(s: string): string {
  const d = (s ?? "").replace(/\D/g, "");
  if (d.length === 11 && (d[0] === "7" || d[0] === "8")) return "+7" + d.slice(1);
  if (d.length === 10 && d[0] === "9") return "+7" + d;
  return d.length >= 5 ? d : "";
}

/** Маска номера для отчётов: +7 9** ***-12-34 */
export function maskPhone(s: string): string {
  const p = normPhone(s);
  if (p.startsWith("+7") && p.length === 12) return `+7 ${p[2]}** ***-${p.slice(8, 10)}-${p.slice(10)}`;
  if (p.length >= 5) return "*".repeat(p.length - 4) + p.slice(-4);
  return s ? "скрыт" : "";
}

/** Сведения из имени файла записи: дата, время, номера, внутренний номер, направление */
export function parseFileName(name: string): { date: string | null; phones: string[]; ext: string | null; direction: Direction } {
  const base = basename(name).replace(AUDIO_EXT, "");
  const date = parseDate(base);
  const phones = [...base.matchAll(/(?<!\d)(?:\+?7|8)?9\d{9}(?!\d)|(?<!\d)[78]\d{10}(?!\d)/g)].map(m => normPhone(m[0])).filter(Boolean);
  const stripped = base.replace(/(?<!\d)\+?\d{10,12}(?!\d)/g, " ").replace(/\d{4}[-.]?\d{2}[-.]?\d{2}/g, " ").replace(/\d{2}[-:.]\d{2}([-:.]\d{2})?/g, " ").replace(/\d{5,}/g, " ");
  const ext = stripped.match(/(?:^|[_\-\s])(\d{2,4})(?=$|[_\-\s])/)?.[1] ?? null;
  const direction = /(^|[_\-\s.])(in|incoming|inbound|вход\w*)($|[_\-\s.])/i.test(base) ? "in" : /(^|[_\-\s.])(out|outgoing|outbound|исх\w*)($|[_\-\s.])/i.test(base) ? "out" : "unknown";
  return { date, phones, ext, direction };
}

/** Справочник менеджеров: «внутренний номер, телефон или имя из выгрузки → имя в отчётах» */
export type ManagerMap = Record<string, string>;
export function resolveManager(raw: string, map: ManagerMap = {}): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  if (map[v]) return map[v];
  const p = normPhone(v);
  if (p && map[p]) return map[p];
  const low = v.toLowerCase();
  const hit = Object.entries(map).find(([k]) => k.toLowerCase() === low);
  return hit ? hit[1] : v;
}

export const callId = (file: string, size: number, mtime: number) => createHash("sha256").update(`${basename(file)}|${size}|${Math.round(mtime)}`).digest("hex").slice(0, 16);

/** Сведения обо всех файлах: из выгрузки (если есть), иначе из имени файла и даты изменения */
export function buildMeta(files: string[], rows: ExportRow[] = [], o: { managers?: ManagerMap; provider?: string; defaultManager?: string } = {}): CallMeta[] {
  const used = new Set<number>();
  const rowsAt = rows.map(r => ({ r, at: parseDate(r.date), phone: normPhone(r.client) }));
  return files.map(f => {
    const st = statSync(f);
    const name = basename(f);
    const fn = parseFileName(name);
    // 1) имя файла или id звонка в колонке «запись»/«id»; 2) время ±90 с и номер
    let k = rowsAt.findIndex((x, i) => !used.has(i) && ((x.r.record && (x.r.record.includes(name) || name.includes(basename(x.r.record).replace(AUDIO_EXT, "")) && basename(x.r.record).replace(AUDIO_EXT, "").length >= 6)) || (x.r.id && x.r.id.length >= 4 && name.includes(x.r.id))));
    if (k < 0 && fn.date) {
      const t = Date.parse(fn.date);
      k = rowsAt.findIndex((x, i) => !used.has(i) && x.at && Math.abs(Date.parse(x.at) - t) <= 90_000 && (!fn.phones.length || !x.phone || fn.phones.includes(x.phone)));
    }
    if (k >= 0) used.add(k);
    const row = k >= 0 ? rowsAt[k] : null;
    const manager = resolveManager(row?.r.manager || fn.ext || "", o.managers) || o.defaultManager || "Без менеджера";
    const client = row?.phone || fn.phones.find(p => !o.managers?.[p]) || "";
    const direction = row ? parseDirection(row.r.direction) : fn.direction;
    return {
      id: callId(f, st.size, st.mtimeMs), file: f, manager, client,
      direction: direction === "unknown" ? fn.direction : direction,
      date: row?.at ?? fn.date ?? local(st.mtime),
      source: row ? o.provider ?? "Выгрузка" : "Папка",
      ...(row?.r.id ? { externalId: row.r.id } : {}),
    };
  });
}
