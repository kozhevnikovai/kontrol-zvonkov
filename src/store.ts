// Архив звонков: по файлу JSON на звонок в папке архива (YYYY-MM/<id>.json). Папка может быть сетевой —
// тогда это общий архив отдела: несколько компьютеров обрабатывают записи, блокировка не даёт разобрать звонок дважды.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { CallRecord, Outcome } from "./types.js";

const SAFE_ID = /^[a-f0-9]{8,64}$/;
const month = (iso: string) => (/^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : "без-даты");

export function recordPath(dir: string, rec: Pick<CallRecord, "meta">) {
  if (!SAFE_ID.test(rec.meta.id)) throw new Error("Неверный номер звонка");
  return join(dir, month(rec.meta.date), rec.meta.id + ".json");
}

export function saveRecord(dir: string, rec: CallRecord) {
  const p = recordPath(dir, rec);
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = p + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, p);
  cache.delete(dir);
}

interface Entry { path: string; mtime: number; rec: CallRecord }
const cache = new Map<string, Map<string, Entry>>();

/** Все звонки архива (с кэшем по времени изменения файла) */
export function allRecords(dir: string): CallRecord[] {
  if (!existsSync(dir)) return [];
  const old = cache.get(dir) ?? new Map<string, Entry>();
  const next = new Map<string, Entry>();
  for (const m of readdirSync(dir)) {
    const md = join(dir, m);
    try { if (!statSync(md).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(md)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!SAFE_ID.test(id)) continue;
      const p = join(md, f);
      let mt = 0;
      try { mt = statSync(p).mtimeMs; } catch { continue; }
      const was = old.get(id);
      if (was && was.path === p && was.mtime === mt) { next.set(id, was); continue; }
      try { next.set(id, { path: p, mtime: mt, rec: JSON.parse(readFileSync(p, "utf8")) }); } catch { /* повреждённый файл пропускаем */ }
    }
  }
  cache.set(dir, next);
  return [...next.values()].map(e => e.rec).sort((a, b) => b.meta.date.localeCompare(a.meta.date));
}

export function getRecord(dir: string, id: string): CallRecord | null {
  if (!SAFE_ID.test(id)) return null;
  allRecords(dir);
  return cache.get(dir)?.get(id)?.rec ?? null;
}

export function deleteRecord(dir: string, id: string): boolean {
  if (!SAFE_ID.test(id)) return false;
  allRecords(dir);
  const e = cache.get(dir)?.get(id);
  if (!e) return false;
  rmSync(e.path, { force: true });
  cache.delete(dir);
  return true;
}

export interface Filter { from?: string; to?: string; manager?: string; missed?: boolean; outcome?: Outcome; maxScore?: number; query?: string }

export function filterRecords(recs: CallRecord[], f: Filter = {}): CallRecord[] {
  const q = f.query?.toLowerCase().trim();
  return recs.filter(r =>
    (!f.from || r.meta.date.slice(0, 10) >= f.from) && (!f.to || r.meta.date.slice(0, 10) <= f.to) &&
    (!f.manager || r.meta.manager === f.manager) && (f.missed === undefined || !!r.review?.missed === f.missed) &&
    (!f.outcome || r.review?.outcome === f.outcome) && (f.maxScore === undefined || (r.review?.score ?? 101) <= f.maxScore) &&
    (!q || r.transcript.turns.some(t => t.text.toLowerCase().includes(q)) || r.meta.manager.toLowerCase().includes(q)));
}

/** Блокировка звонка на время обработки (общая папка отдела). Зависшая блокировка старше 2 часов снимается. */
export function lock(dir: string, id: string): (() => void) | null {
  if (!SAFE_ID.test(id)) return null;
  const d = join(dir, ".locks");
  mkdirSync(d, { recursive: true });
  const p = join(d, id + ".lock");
  try { if (Date.now() - statSync(p).mtimeMs > 2 * 3600_000) rmSync(p, { force: true }); } catch { /* нет блокировки */ }
  try {
    const fd = openSync(p, "wx");
    writeFileSync(fd, `${hostname()} ${process.pid} ${new Date().toISOString()}`);
    closeSync(fd);
    return () => rmSync(p, { force: true });
  } catch { return null; }
}
