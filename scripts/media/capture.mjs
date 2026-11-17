// Съёмка настоящей работы Контроля звонков: открытые телефонные разговоры DataHive (CC BY 4.0, стерео) → разбор в приложении.
// Имена сотрудников условные («Сотрудник 1–3»): в наборе их нет. Окна выбора папки и файла подменяются в главном процессе.
import { _electron as electron } from "playwright-core";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const OUT = "media", RAW = "media/raw", DATA = resolve(process.env.ZVONKI_DATA ?? "media/calls");
mkdirSync(RAW, { recursive: true }); mkdirSync(DATA, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const DH = "https://huggingface.co/datasets/datahiveai/russian-conversations-sample/resolve/main/preview";
const meta = (await (await fetch(`${DH}/metadata.jsonl`)).text()).split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(m => m.duration_seconds < 420).slice(0, Number(process.env.MEDIA_CALLS ?? 6));
const rows = ["Имя файла;Сотрудник;Тип звонка"];
meta.forEach((m, i) => { rows.push(`${m.file_name};Сотрудник ${(i % 3) + 1};${i % 2 ? "Исходящий" : "Входящий"}`); const f = join(DATA, m.file_name); if (!existsSync(f)) return; });
for (const m of meta) { const f = join(DATA, m.file_name); if (!existsSync(f)) writeFileSync(f, Buffer.from(await (await fetch(`${DH}/${m.file_name}`)).arrayBuffer())); }
const exp = resolve(RAW, "выгрузка.csv"); writeFileSync(exp, rows.join("\n"));
log("звонков", meta.length);

const app = await electron.launch({ args: ["--no-sandbox", "app/main.mjs"], env: { ...process.env }, recordVideo: { dir: RAW, size: { width: 1440, height: 900 } } });
await app.evaluate(({ BrowserWindow, dialog }, [dir, exp]) => {
  const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.center(); w.show();
  dialog.showOpenDialog = async (_w, o) => ({ canceled: false, filePaths: [(o?.properties ?? _w?.properties ?? []).includes("openDirectory") ? dir : exp] });
}, [DATA, exp]);
const win = await app.firstWindow(); await win.waitForTimeout(3000);
const snap = async name => { await win.waitForTimeout(600); try { await win.screenshot({ path: join(OUT, name + ".png") }); } catch { const b = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); writeFileSync(join(OUT, name + ".png"), Buffer.from(b, "base64")); } log("снимок", name); };
const nav = async v => { await win.click(`nav button[data-view="${v}"]`); await win.waitForTimeout(1200); };
await snap("app-start");
await win.click("#pick-export"); await win.waitForTimeout(500);
await win.click("#pick-dir"); await win.waitForSelector("#import-box:not([hidden])"); await snap("app-import");
const t0 = Date.now();
await win.click("#imp-go"); await win.waitForTimeout(8000); await snap("app-progress");
await win.waitForSelector("#work[hidden]", { state: "attached", timeout: 3 * 3600e3 }); log("разбор, мин", ((Date.now() - t0) / 60000).toFixed(1));
await win.waitForTimeout(2500); await snap("app-calls");
// карточка звонка с наибольшим числом реплик продажи (если есть), иначе первая
await win.click("#calls tr[data-id]"); await win.waitForTimeout(1500); await snap("app-call");
for (const [i, y] of [[1, 600], [2, 1300]]) { await win.evaluate(y => document.querySelector("main").scrollTo({ top: y, behavior: "smooth" }), y); await win.waitForTimeout(1400); await snap("app-call-" + i); }
await nav("managers"); await snap("app-managers");
await win.click("#mgr-cards .mgr"); await win.waitForTimeout(1500); await snap("app-manager");
await nav("summary"); await snap("app-summary");
await nav("missed"); await snap("app-missed");
await nav("script"); await snap("app-script");
await nav("settings"); await snap("app-settings");
await win.evaluate(() => document.querySelector("main").scrollTo({ top: 1400 })); await win.waitForTimeout(800); await snap("app-settings-2");
const v = win.video(); await app.close(); copyFileSync(await v.path(), join(RAW, "app.webm"));
writeFileSync(join(RAW, "timing.json"), JSON.stringify({ minutes: (Date.now() - t0) / 60000, calls: meta.length }));
// отчёты для витрины
const home = process.env.ZVONKI_OUT;
if (home && existsSync(home)) log("отчёты в", home);
void readFileSync; // конец
