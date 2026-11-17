#!/usr/bin/env node
// Контроль звонков — командная строка: импорт записей, оценка, отчёты, загрузка из телефонии, общий кабинет, MCP.
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectHardware, recommend } from "@kozhevnikovai/local-ai";
import { download, plan, selectLlm, LLM_MODELS } from "./asr/models.js";
import { setOffline } from "./asr/net.js";
import { TEMPLATES, getTemplate, loadScript, scriptToMarkdown } from "./analyze/scripts.js";
import { loadConfig, parseManagers, saveConfig, setPath, getPath, SECRET_KEYS } from "./config.js";
import { buildMeta, readExport, scanFolder } from "./import/sources.js";
import { fetchRecordings, TELEPHONY } from "./import/telephony.js";
import { sendDeal, summaryText, toTelegram } from "./integrations/crm.js";
import { processCalls } from "./pipeline.js";
import { managerStat, periodSummary } from "./report/aggregate.js";
import { htmlToPdf, toXlsx } from "./report/files.js";
import { callHtml, managerHtml, periodHtml } from "./report/html.js";
import { allRecords, filterRecords, getRecord, saveRecord } from "./store.js";
import { newToken, startTeamServer } from "./team/server.js";
import type { CallMeta, Script } from "./types.js";
import { VERSION } from "./version.js";

const program = new Command();
program.name("zvonki").description("Контроль звонков: оценка звонков менеджеров по скрипту продаж — локально").version(VERSION);

const mb = (b: number) => `${(b / 1048576).toFixed(0)} МБ`;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const fail = (e: unknown) => { console.error("Ошибка: " + ((e as Error)?.message ?? e)); process.exit(1); };

async function scriptFrom(s?: string): Promise<Script | undefined> {
  if (!s) return undefined;
  return existsSync(s) ? loadScript(s) : getTemplate(s);
}

function progress(e: { index: number; count: number; file: string; stage: string; done: number; total: number; message?: string }) {
  const name = e.file.split(/[\\/]/).pop();
  if (e.stage === "saved") console.log(`  ✓ ${e.index + 1}/${e.count} ${name}`);
  else if (e.stage === "skipped") console.log(`  · ${e.index + 1}/${e.count} ${name} — уже в архиве${e.message ? ` (${e.message})` : ""}`);
  else if (e.stage === "failed") console.log(`  ✗ ${e.index + 1}/${e.count} ${name}: ${e.message}`);
}

program.command("models").description("Скачать модели (распознавание ~260 МБ + языковая модель)")
  .option("--model <id>", `языковая модель: ${LLM_MODELS.map(m => m.id).join(", ")}`)
  .option("--only-asr", "только распознавание (без оценки по скрипту)")
  .action(async o => {
    try {
      const hw = await detectHardware();
      const rec = recommend(hw);
      const id = o.model ?? loadConfig().llm.localModel ?? rec.model.id;
      selectLlm(id);
      if (o.model) saveConfig({ llm: { ...loadConfig().llm, localModel: id } });
      console.log(`Компьютер: ОЗУ ${hw.ramGb} ГБ, ${hw.gpu ? `видеокарта ${hw.gpu} ${hw.vramGb} ГБ` : "без видеокарты"}. Рекомендуем: ${rec.model.title} — ${rec.reason}`);
      const packs = o.onlyAsr ? ["asr", "speakers"] : ["asr", "speakers", "llm"];
      for (const p of plan(packs)) console.log(`  ${p.missing ? "↓" : "✓"} ${p.title} (${mb(p.size)}, ${p.license})`);
      let last = -1;
      await download(packs, e => { const pc = Math.floor((e.done / e.total) * 100); if (pc !== last && pc % 5 === 0) { last = pc; process.stdout.write(`\r  ${pc} % · ${e.file}            `); } });
      console.log("\nГотово.");
    } catch (e) { fail(e); }
  });

program.command("import").argument("<folder>", "папка с записями (mp3, wav, ogg, m4a…)")
  .description("Обработать записи из папки: расшифровка, метрики, оценка по скрипту")
  .option("--export <file>", "выгрузка телефонии (CSV/XLSX): менеджеры, номера, направление")
  .option("--manager <name>", "менеджер для всех файлов, если его нет в выгрузке")
  .option("--script <id|file>", `скрипт: ${TEMPLATES.map(t => t.id).join(", ")} или свой файл`)
  .option("--no-review", "только расшифровка и метрики, без языковой модели")
  .option("--force", "обработать заново, даже если звонок уже в архиве")
  .option("--limit <n>", "не больше N файлов", v => Number(v))
  .action(async (folder, o) => {
    try {
      const c = loadConfig();
      const files = scanFolder(resolve(folder)).slice(0, o.limit || undefined);
      if (!files.length) throw new Error("В папке нет записей звонков (mp3, wav, ogg, m4a…)");
      let rows: any[] = [], provider: string | undefined;
      if (o.export) { const x = await readExport(o.export); rows = x.rows; provider = x.provider; console.log(`Выгрузка: ${x.provider}, строк ${x.rows.length}; колонки: ${Object.entries(x.columns).map(([k, v]) => `${k}=«${v}»`).join(", ")}`); }
      const metas = buildMeta(files, rows, { managers: c.managers, provider, defaultManager: o.manager });
      console.log(`Записей: ${metas.length}. Обработка идёт на этом компьютере.`);
      const r = await processCalls(metas, { config: c, script: await scriptFrom(o.script), review: o.review, force: o.force, onProgress: progress });
      console.log(`Готово: ${r.done.length}, пропущено ${r.skipped.length}, ошибок ${r.failed.length}.${r.model ? ` Модель: ${r.model}` : ""}`);
      const missed = r.done.filter(x => x.review?.missed).length;
      if (missed) console.log(`Упущенных сделок: ${missed} — zvonki missed`);
    } catch (e) { fail(e); }
  });

program.command("fetch").description("Загрузить новые записи из телефонии по API и обработать")
  .option("--from <date>", "с даты ГГГГ-ММ-ДД (по умолчанию — с прошлой загрузки или 7 дней)")
  .option("--to <date>", "по дату (по умолчанию — сейчас)")
  .option("--no-review", "только расшифровка и метрики")
  .action(async o => {
    try {
      const c = loadConfig();
      if (!c.telephony.provider) throw new Error(`Телефония не подключена: zvonki config set telephony.provider <${Object.keys(TELEPHONY).join("|")}> и ключи`);
      setOffline(c.offline);
      const from = new Date(o.from ? o.from + "T00:00:00" : c.telephony.last ?? daysAgo(7) + "T00:00:00");
      const to = o.to ? new Date(o.to + "T23:59:59") : new Date();
      console.log(`${TELEPHONY[c.telephony.provider].title}: записи с ${from.toLocaleString("ru-RU")} по ${to.toLocaleString("ru-RU")}`);
      const got = await fetchRecordings(c.telephony, c.archiveDir, from, to, (d, t) => process.stdout.write(`\r  скачано ${d}/${t}   `));
      console.log(`\nНовых записей: ${got.metas.length}${got.failed.length ? `, не скачались ${got.failed.length}: ${got.failed.slice(0, 3).map(f => f.error).join("; ")}` : ""}`);
      const metas = got.metas.map(m => ({ ...m, manager: c.managers[m.manager] ?? m.manager }));
      const r = await processCalls(metas, { config: c, review: o.review, onProgress: progress });
      saveConfig({ telephony: { ...c.telephony, last: to.toISOString() } } as any);
      console.log(`Обработано: ${r.done.length}, ошибок ${r.failed.length}.`);
    } catch (e) { fail(e); }
  });

program.command("report").description("Отчёты: сводка за период и по каждому менеджеру")
  .option("--from <date>", "с даты ГГГГ-ММ-ДД", daysAgo(30))
  .option("--to <date>", "по дату ГГГГ-ММ-ДД", today())
  .option("--manager <name>", "только этот менеджер")
  .option("--format <list>", "html, xlsx, pdf через запятую", "html,xlsx")
  .option("--out <dir>", "папка отчётов")
  .option("--telegram", "отправить сводку в Telegram (если подключён)")
  .action(async o => {
    try {
      const c = loadConfig();
      const recs = filterRecords(allRecords(c.archiveDir), { from: o.from, to: o.to, manager: o.manager });
      if (!recs.length) throw new Error("За период нет обработанных звонков. Сначала: zvonki import <папка>");
      const out = resolve(o.out ?? c.outputDir);
      mkdirSync(out, { recursive: true });
      const fmts = String(o.format).split(",").map(s => s.trim().toLowerCase());
      const base = `звонки_${o.from}_${o.to}${o.manager ? "_" + o.manager.replace(/[^\p{L}\d]+/gu, "-") : ""}`;
      const p = periodSummary(recs, o.from, o.to);
      const html = o.manager ? managerHtml(managerStat(o.manager, recs), recs, { showPhones: c.showPhones, from: o.from, to: o.to }) : periodHtml(p, recs, { showPhones: c.showPhones });
      const made: string[] = [];
      if (fmts.includes("html")) { const f = join(out, base + ".html"); writeFileSync(f, html); made.push(f); }
      if (fmts.includes("xlsx")) made.push(await toXlsx(recs, join(out, base + ".xlsx"), { showPhones: c.showPhones, summary: p }));
      if (fmts.includes("pdf")) made.push(await htmlToPdf(html, join(out, base + ".pdf")));
      if (!o.manager && fmts.includes("html")) for (const m of p.managers) { const mine = recs.filter(r => r.meta.manager === m.manager); const f = join(out, `менеджер_${m.manager.replace(/[^\p{L}\d]+/gu, "-")}_${o.from}_${o.to}.html`); writeFileSync(f, managerHtml(m, mine, { showPhones: c.showPhones, from: o.from, to: o.to })); made.push(f); }
      console.log(`Звонков ${p.calls}, средний балл ${p.avgScore ?? "—"}, упущено ${p.missed}.`);
      for (const f of made) console.log("  " + f);
      if (o.telegram) { setOffline(c.offline); if (!c.crm.telegram?.token) throw new Error("Telegram не подключён"); const r = await toTelegram(summaryText(p), c.crm.telegram); console.log(r.ok ? "Сводка отправлена в Telegram" : "Telegram: " + r.error); }
    } catch (e) { fail(e); }
  });

program.command("call").argument("<id>", "номер звонка из архива").description("Карточка звонка")
  .option("--format <f>", "html или json", "html").option("--out <file>", "сохранить в файл")
  .action((id, o) => {
    try {
      const c = loadConfig();
      const r = getRecord(c.archiveDir, id);
      if (!r) throw new Error("Звонок не найден");
      const text = o.format === "json" ? JSON.stringify(r, null, 2) : callHtml(r, { showPhones: c.showPhones });
      if (o.out) { writeFileSync(o.out, text); console.log(o.out); } else console.log(text);
    } catch (e) { fail(e); }
  });

program.command("list").description("Звонки из архива")
  .option("--from <date>").option("--to <date>").option("--manager <name>").option("--missed", "только упущенные сделки")
  .action(o => {
    const c = loadConfig();
    const recs = filterRecords(allRecords(c.archiveDir), { from: o.from, to: o.to, manager: o.manager, missed: o.missed ? true : undefined });
    for (const r of recs) console.log(`${r.meta.id}  ${r.meta.date.replace("T", " ").slice(0, 16)}  ${r.meta.manager.padEnd(20).slice(0, 20)}  ${String(r.review?.score ?? "—").padStart(3)}  ${r.review?.missed ? "УПУЩЕНА" : r.review?.outcome ?? "—"}  ${r.review?.summary?.slice(0, 80) ?? ""}`);
    console.log(`Всего: ${recs.length}`);
  });

program.command("missed").description("Упущенные сделки: интерес был, следующего шага нет")
  .option("--from <date>", "с даты", daysAgo(30)).option("--to <date>", "по дату", today())
  .option("--send", "отправить в подключённые CRM (amoCRM, Битрикс24, YouGile, Telegram)")
  .action(async o => {
    try {
      const c = loadConfig();
      setOffline(c.offline);
      const recs = filterRecords(allRecords(c.archiveDir), { from: o.from, to: o.to, missed: true });
      for (const r of recs) {
        console.log(`${r.meta.date.replace("T", " ").slice(0, 16)}  ${r.meta.manager}  «${r.review!.interest.quote}»  ${r.followUp ? `[${r.followUp.status}]` : ""}`);
        if (o.send && !r.followUp) {
          const res = await sendDeal(r, c.crm);
          for (const x of res) console.log(`   → ${x.target}: ${x.ok ? "создано" + (x.link ? " " + x.link : "") : x.error}`);
          if (res.some(x => x.ok)) saveRecord(c.archiveDir, { ...r, followUp: { status: "crm", link: res.find(x => x.link)?.link, at: new Date().toISOString() } });
        }
      }
      console.log(`Упущенных сделок: ${recs.length}`);
    } catch (e) { fail(e); }
  });

const scripts = program.command("scripts").description("Скрипты продаж");
scripts.command("list").action(() => { for (const t of TEMPLATES) console.log(`${t.id.padEnd(10)} ${t.title} — ${t.description} (${t.items.length} пунктов)`); });
scripts.command("show").argument("<id|file>").action(async s => { try { console.log(scriptToMarkdown((await scriptFrom(s))!)); } catch (e) { fail(e); } });
scripts.command("use").argument("<id|file>", "шаблон или свой файл скрипта").description("Скрипт по умолчанию")
  .action(async s => { try { const sc = (await scriptFrom(s))!; saveConfig(existsSync(s) ? { scriptId: "custom", scriptFile: resolve(s) } : { scriptId: sc.id }); console.log(`Скрипт по умолчанию: ${sc.title} (${sc.items.length} пунктов)`); } catch (e) { fail(e); } });

program.command("managers").argument("<pairs...>", "«101=Иванов Иван» — внутренний номер, телефон или имя из выгрузки → имя в отчётах")
  .description("Справочник менеджеров").action(pairs => { const c = loadConfig(); const m = { ...c.managers, ...parseManagers(pairs.join("\n")) }; saveConfig({ managers: m }); console.log(`В справочнике: ${Object.keys(m).length}`); });

const config = program.command("config").description("Настройки");
config.command("get").argument("[key]").action(k => { const c: any = loadConfig(); for (const s of SECRET_KEYS) if (getPath(c, s)) setPath(c, s, "***"); console.log(JSON.stringify(k ? getPath(c, k) : c, null, 2)); });
config.command("set").argument("<key>").argument("<value>").action((k, v) => {
  const raw: any = {};
  const val = v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) && !/(token|key|secret|user|chatId|webhook)$/i.test(k) ? Number(v) : v;
  setPath(raw, k, val);
  saveConfig(raw);
  console.log("Сохранено: " + k);
});

program.command("serve").description("Общий кабинет отдела в браузере и приём записей с других ПК (разбор здесь)")
  .option("--port <n>", "порт", v => Number(v)).option("--lan", "открыть для локальной сети (по умолчанию — только этот компьютер)")
  .option("--no-review", "принятые записи — без оценки моделью")
  .action(async o => {
    try {
      const c = loadConfig();
      let token = c.team.token;
      if (!token) { token = newToken(); saveConfig({ team: { ...c.team, token } } as any); }
      const queue: CallMeta[] = [];
      let busy = false;
      const pump = async () => {
        if (busy) return; busy = true;
        while (queue.length) { const m = queue.shift()!; await processCalls([m], { config: loadConfig(), review: o.review, onProgress: progress }).catch(e => console.error(e.message)); }
        busy = false;
      };
      const srv = await startTeamServer({ archiveDir: c.archiveDir, port: o.port ?? c.team.port, lan: !!(o.lan ?? c.team.lan), token, showPhones: c.showPhones, onUpload: m => { queue.push(m); void pump(); } });
      console.log(`Кабинет: ${srv.url}\nПриём записей: POST /api/upload (заголовок Authorization: Bearer <ключ>, X-File-Name, X-Manager). Остановить — Ctrl+C.`);
    } catch (e) { fail(e); }
  });

program.command("mcp").description("MCP-сервер для Claude Desktop и других агентов (stdio)").action(async () => { await (await import("./mcp.js")).runMcp(); });

program.command("hardware").description("Какая языковая модель подойдёт этому компьютеру").action(async () => {
  const hw = await detectHardware(); const r = recommend(hw);
  console.log(`ОЗУ ${hw.ramGb} ГБ, ядер ${hw.cores}, ${hw.gpu ? `видеокарта ${hw.gpu} ${hw.vramGb} ГБ` : "без видеокарты"}`);
  for (const x of r.options) console.log(`  ${x.ok ? "✓" : "✗"} ${x.model.title} — ${x.why}`);
  console.log(`Рекомендуем: ${r.model.title}. ${r.reason}`);
});

program.parseAsync().catch(fail);
