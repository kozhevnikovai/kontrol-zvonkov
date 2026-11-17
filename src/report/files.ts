// Отчёты в файлы: HTML, XLSX (листы «Менеджеры», «Звонки», «Упущенные сделки», «Возражения», «Скрипт»), PDF.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { INTEREST, OBJECTION_TYPES, OUTCOMES } from "../analyze/review.js";
import { maskPhone } from "../import/sources.js";
import type { CallRecord } from "../types.js";
import { periodSummary, type PeriodSummary } from "./aggregate.js";

/** Защита от формул в Excel: значение, начинающееся с = + - @, превращается в текст */
export const safeCell = (v: unknown) => {
  if (typeof v === "number" || v == null) return v ?? "";
  const s = String(v);
  // номера телефонов (+7 …) и отрицательные числа — не формулы
  return /^[=@\t\r]|^[+-](?![\d (])/.test(s) ? "'" + s : s;
};

export async function toXlsx(recs: CallRecord[], file: string, o: { showPhones?: boolean; summary?: PeriodSummary } = {}): Promise<string> {
  const XLSX: any = await import("xlsx");
  const p = o.summary ?? periodSummary(recs);
  const ph = (x: string) => (o.showPhones ? x : maskPhone(x));
  const sheet = (rows: unknown[][], widths: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(safeCell)));
    ws["!cols"] = widths.map(w => ({ wch: w }));
    if (rows.length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
    return ws;
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet([["Менеджер", "Звонков", "Оценено", "Средний балл", "Продажи", "Следующий шаг", "Упущено", "Возражений", "Отработано, %", "Доля речи, %", "Слабое место"],
    ...p.managers.map(s => [s.manager, s.calls, s.scored, s.avgScore ?? "", s.sales, s.nextSteps, s.missed, s.objections, s.handled ?? "", s.talkRatio ?? "", s.weakest[0]?.title ?? ""])], [24, 9, 9, 12, 9, 13, 9, 11, 13, 12, 36]), "Менеджеры");
  XLSX.utils.book_append_sheet(wb, sheet([["Дата", "Менеджер", "Клиент", "Направление", "Длительность, с", "Балл", "Итог", "Интерес", "Следующий шаг", "Срок", "Упущена", "Говорит менеджер, %", "Вопросов", "Перебиваний", "Резюме", "Файл"],
    ...recs.map(r => [r.meta.date.replace("T", " "), r.meta.manager, ph(r.meta.client), r.meta.direction === "in" ? "входящий" : r.meta.direction === "out" ? "исходящий" : "", Math.round(r.metrics.duration), r.review?.score ?? "", r.review ? OUTCOMES[r.review.outcome] : "не оценён", r.review ? INTEREST[r.review.interest.level] : "", r.review?.nextStep.text ?? "", r.review?.nextStep.due ?? "", r.review?.missed ? "да" : "", r.metrics.talkRatio, r.metrics.questions, r.metrics.interruptions, r.review?.summary ?? "", r.meta.file.split(/[\\/]/).pop()])],
    [17, 22, 18, 11, 10, 7, 16, 10, 30, 11, 9, 12, 9, 11, 50, 30]), "Звонки");
  XLSX.utils.book_append_sheet(wb, sheet([["Дата", "Менеджер", "Клиент", "Что сказал клиент", "Почему упущена", "Статус"],
    ...recs.filter(r => r.review?.missed).map(r => [r.meta.date.replace("T", " "), r.meta.manager, ph(r.meta.client), r.review!.interest.quote, r.review!.missedReason, r.followUp?.status === "done" ? "перезвонили" : r.followUp?.status === "crm" ? "в CRM" : "на перезвон"])], [17, 22, 18, 50, 50, 14]), "Упущенные сделки");
  XLSX.utils.book_append_sheet(wb, sheet([["Дата", "Менеджер", "Тип", "Клиент сказал", "Ответ менеджера", "Отработано", "Как лучше (совет)"],
    ...recs.flatMap(r => (r.review?.objections ?? []).map(x => [r.meta.date.replace("T", " "), r.meta.manager, OBJECTION_TYPES[x.type], x.quote, x.answer, x.handled === "yes" ? "да" : x.handled === "partial" ? "частично" : "нет", x.better]))], [17, 22, 24, 50, 50, 11, 50]), "Возражения");
  XLSX.utils.book_append_sheet(wb, sheet([["Пункт скрипта", "Выполнение, %", "Да", "Частично", "Нет"], ...p.items.map(i => [i.title, i.rate, i.yes, i.partial, i.no])], [44, 14, 8, 10, 8]), "Скрипт");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  return file;
}

/** Chrome или Edge для печати PDF из командной строки */
export function findBrowser(): string | null {
  const c = process.platform === "win32"
    ? [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean).flatMap(d => [join(d!, "Microsoft", "Edge", "Application", "msedge.exe"), join(d!, "Google", "Chrome", "Application", "chrome.exe")])
    : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
  return [process.env.ZVONKI_CHROME, ...c].find(p => p && existsSync(p)) ?? null;
}

/** PDF из HTML через Chrome/Edge без интерфейса. В приложении вместо этого печатает само окно Electron. */
export async function htmlToPdf(html: string, out: string): Promise<string> {
  const exe = findBrowser();
  if (!exe) throw new Error("Для PDF из командной строки нужен Chrome или Edge. В приложении PDF сохраняется без них.");
  const dir = mkdtempSync(join(tmpdir(), "zvonki-pdf-"));
  const src = join(dir, "report.html");
  writeFileSync(src, html);
  mkdirSync(join(out, ".."), { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => execFile(exe, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--disable-extensions", "--no-pdf-header-footer", `--user-data-dir=${join(dir, "profile")}`, `--print-to-pdf=${out}`, pathToFileURL(src).href], { timeout: 120_000, windowsHide: true }, e => (e && !existsSync(out) ? reject(new Error("PDF не получился: " + e.message)) : resolve())));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}
