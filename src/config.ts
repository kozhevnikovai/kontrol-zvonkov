// Настройки: один JSON в папке программы. Ключи в приложении шифруются средствами ОС (DPAPI / связка ключей) — в файле «enc:…».
// CLI и MCP берут ключи из переменных окружения или из значений, заданных через CLI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir, selectLlm } from "./asr/models.js";
import type { LLMOptions } from "./analyze/llm.js";

export interface Config {
  /** Папка архива звонков. Сетевая папка — общий архив отдела (несколько ПК пишут в одну папку) */
  archiveDir: string;
  /** Папка отчётов */
  outputDir: string;
  /** Шаблон скрипта или «custom» */
  scriptId: string;
  /** Путь к своему скрипту (MD, TXT, DOCX, XLSX, JSON) */
  scriptFile: string;
  /** Канал менеджера в стереозаписях: auto, 0 (левый), 1 (правый) */
  managerChannel: "auto" | 0 | 1;
  /** Справочник: внутренний номер / телефон / имя из выгрузки → имя менеджера */
  managers: Record<string, string>;
  /** Показывать номера клиентов полностью (по умолчанию маска +7 9** ***-12-34) */
  showPhones: boolean;
  /** Строгий офлайн: интеграции, API телефонии и облачная модель заблокированы */
  offline: boolean;
  /** Узнавать менеджеров по голосу (отпечаток CAM++ хранится локально) */
  voices: boolean;
  /** Словарь компании (названия товаров), по строке на термин, варианты через «=» */
  glossary: string;
  llm: LLMOptions;
  telephony: TelephonyConfig;
  crm: CrmConfig;
  team: TeamConfig;
}

export interface TelephonyConfig {
  provider: "" | "mango" | "sipuni" | "uis" | "comagic" | "novofon" | "bitrix24" | "zadarma" | "beeline";
  /** Ключи: mango {key, salt}; sipuni {user, secret}; uis/comagic/novofon {token}; bitrix24 {webhook}; zadarma {key, secret}; beeline {token} */
  key?: string; secret?: string; user?: string; token?: string; webhook?: string;
  /** Загружать новые записи каждые N минут, пока приложение открыто (0 — вручную) */
  everyMinutes: number;
  /** Последняя загрузка (ISO) */
  last?: string;
  /** Только звонки длиннее, с (короткие — недозвоны) */
  minSeconds: number;
}

export interface CrmConfig {
  amocrm?: { domain: string; token: string; pipelineId?: number };
  bitrix24?: { webhook: string; responsible?: number };
  yougile?: { key: string; columnId: string };
  telegram?: { token: string; chatId: string };
}

export interface TeamConfig {
  /** Общий кабинет отдела в локальной сети: порт */
  port: number;
  /** Ключ доступа к кабинету и приёму записей */
  token?: string;
  /** Открыть кабинет для локальной сети (иначе только этот компьютер) */
  lan: boolean;
}

export function defaultOutputDir(): string {
  const docs = process.env.USERPROFILE ? join(process.env.USERPROFILE, "Documents") : process.env.HOME ? join(process.env.HOME, "Documents") : homeDir();
  return join(docs, "Контроль звонков");
}

export const DEFAULTS: Config = {
  archiveDir: "", outputDir: "", scriptId: "incoming", scriptFile: "", managerChannel: "auto", managers: {}, showPhones: false,
  offline: true, voices: false, glossary: "", llm: { provider: "local" },
  telephony: { provider: "", everyMinutes: 0, minSeconds: 20 }, crm: {}, team: { port: 8787, lan: false },
};

export const configFile = () => join(homeDir(), "config.json");

export const SECRET_KEYS = ["llm.apiKey", "telephony.key", "telephony.secret", "telephony.token", "telephony.webhook", "crm.amocrm.token", "crm.bitrix24.webhook", "crm.yougile.key", "crm.telegram.token", "team.token"] as const;
const ENV: Record<string, string> = Object.fromEntries(SECRET_KEYS.map(k => [k, "ZVONKI_" + k.toUpperCase().replace(/\./g, "_")]));

let secrets: Record<string, string> = {};
/** Расшифрованные ключи от главного процесса приложения (только в памяти) */
export function setSecrets(s: Record<string, string> | undefined) { secrets = s ?? {}; }

export const getPath = (o: any, k: string) => k.split(".").reduce((a, x) => a?.[x], o);
export function setPath(o: any, k: string, v: unknown) {
  const ks = k.split(".");
  let cur = o;
  for (const x of ks.slice(0, -1)) cur = cur[x] ??= {};
  cur[ks.at(-1)!] = v;
}

export function rawConfig(): any {
  try { return existsSync(configFile()) ? JSON.parse(readFileSync(configFile(), "utf8")) : {}; } catch { return {}; }
}

export function loadConfig(): Config {
  const c = rawConfig();
  selectLlm(c.llm?.localModel);
  const out: Config = {
    ...DEFAULTS, ...c,
    llm: { ...DEFAULTS.llm, ...c.llm },
    telephony: { ...DEFAULTS.telephony, ...c.telephony },
    crm: { ...c.crm },
    team: { ...DEFAULTS.team, ...c.team },
    managers: { ...c.managers },
    archiveDir: c.archiveDir || process.env.ZVONKI_ARCHIVE || join(homeDir(), "calls"),
    outputDir: c.outputDir || process.env.ZVONKI_OUT || defaultOutputDir(),
  };
  if (process.env.ZVONKI_OFFLINE === "0") out.offline = false;
  for (const k of SECRET_KEYS) {
    const v = getPath(out, k), env = process.env[ENV[k]];
    if (env) setPath(out, k, env);
    else if (typeof v === "string" && v.startsWith("enc:")) setPath(out, k, secrets[k] ?? "");
  }
  return out;
}

/** Сохраняет изменения. Ключи, не переданные в patch, не трогаются и не расшифровываются на диск. */
export function saveConfig(patch: Partial<Config> & Record<string, any>): Config {
  const raw = rawConfig();
  const next: any = { ...raw, ...patch };
  for (const g of ["llm", "telephony", "team"] as const) if (patch[g] && raw[g]) next[g] = { ...raw[g], ...patch[g] };
  if (patch.crm && raw.crm) { next.crm = { ...raw.crm }; for (const [k, v] of Object.entries(patch.crm)) next.crm[k] = v ? { ...raw.crm[k], ...v } : undefined; }
  for (const k of SECRET_KEYS) if (getPath(patch, k) === undefined && getPath(raw, k) !== undefined) setPath(next, k, getPath(raw, k));
  if (!["auto", 0, 1].includes(next.managerChannel)) next.managerChannel = "auto";
  if (next.team) { const p = Number(next.team.port); next.team.port = Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : 8787; }
  if (next.telephony) { next.telephony.everyMinutes = Math.max(0, Math.min(1440, Number(next.telephony.everyMinutes) || 0)); next.telephony.minSeconds = Math.max(0, Math.min(600, Number(next.telephony.minSeconds ?? 20))); }
  if (next.managers && typeof next.managers === "object") next.managers = Object.fromEntries(Object.entries(next.managers).slice(0, 2000).map(([k, v]) => [String(k).slice(0, 100), String(v).slice(0, 100)]));
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(next, null, 2));
  return loadConfig();
}

/** Справочник менеджеров из текста: строка «101 = Иванов Иван» */
export function parseManagers(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/); if (m) out[m[1]] = m[2]; }
  return out;
}
