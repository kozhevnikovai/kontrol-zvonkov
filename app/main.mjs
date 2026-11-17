// Контроль звонков — настольное приложение (Electron). Главный процесс: окно, фоновый обработчик, ключи, PDF, загрузка по расписанию.
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell, utilityProcess } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.commandLine.appendSwitch("lang", "ru");
if (process.platform === "win32") app.setAppUserModelId("ai.kozhevnikov.kontrol-zvonkov");

// ── Ключи телефонии, CRM и кабинета шифруются средствами ОС (DPAPI / связка ключей), расшифровываются только в памяти
const SECRET_KEYS = ["llm.apiKey", "telephony.key", "telephony.secret", "telephony.token", "telephony.webhook", "crm.amocrm.token", "crm.bitrix24.webhook", "crm.yougile.key", "crm.telegram.token", "team.token"];
const getPath = (o, k) => k.split(".").reduce((a, x) => a?.[x], o);
const setPath = (o, k, v) => { const ks = k.split("."); let c = o; for (const x of ks.slice(0, -1)) c = c[x] ??= {}; c[ks.at(-1)] = v; };
const delPath = (o, k) => { const ks = k.split("."); const p = ks.slice(0, -1).reduce((a, x) => a?.[x], o); if (p) delete p[ks.at(-1)]; };
const home = () => process.env.ZVONKI_HOME || (process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "KontrolZvonkov") : join(homedir(), ".kontrolzvonkov"));
const cfgFile = () => join(home(), "config.json");
const raw = () => { try { return JSON.parse(readFileSync(cfgFile(), "utf8")); } catch { return {}; } };
const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
const enc = v => (v && canEncrypt() ? "enc:" + safeStorage.encryptString(v).toString("base64") : v);
function secrets() {
  const c = raw(), out = {};
  for (const k of SECRET_KEYS) {
    const v = getPath(c, k);
    if (typeof v === "string" && v.startsWith("enc:")) { try { out[k] = safeStorage.decryptString(Buffer.from(v.slice(4), "base64")); } catch { out[k] = ""; } }
  }
  return out;
}
/** В интерфейс ключи не отдаём: только «задан / не задан» */
function maskConfig(c) {
  const set = {};
  for (const k of SECRET_KEYS) { set[k] = !!getPath(c, k); if (getPath(c, k)) setPath(c, k, ""); }
  return { ...c, secretsSet: set };
}

let win, worker;
const pending = new Map();
let seq = 0;
let busy = false;

function startWorker() {
  worker = utilityProcess.fork(join(here, "worker.mjs"), [], { serviceName: "Контроль звонков: обработка", stdio: "pipe", env: { ...process.env } });
  // журнал обработчика — для диагностики (без содержимого звонков: только служебные сообщения библиотек и ошибки)
  mkdirSync(home(), { recursive: true });
  const logTo = c => { try { appendFileSync(join(home(), "worker.log"), c); } catch { /* нет доступа */ } process.stderr.write(c); };
  worker.stdout?.on("data", logTo); worker.stderr?.on("data", logTo);
  worker.on("message", m => {
    if (["progress", "net", "fetched", "team"].includes(m.type)) {
      if (m.type === "fetched" && m.count > 0 && !win?.isFocused() && Notification.isSupported()) new Notification({ title: "Контроль звонков", body: `Загружено и разобрано звонков: ${m.count}${m.missed ? `, упущенных сделок: ${m.missed}` : ""}` }).show();
      return win?.webContents.send(m.type, m);
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  worker.on("exit", code => { if (code) try { appendFileSync(join(home(), "worker.log"), `[${new Date().toISOString()}] обработчик завершился, код ${code}\n`); } catch { /* нет доступа */ } const why = code === 132 || code === 3221225501 ? "Языковая модель не запустилась на этом компьютере. Расшифровка и метрики работают: снимите галочку «Оценить по скрипту» или оценивайте звонки в Claude Desktop" : "Обработчик завершился — попробуйте ещё раз";
    for (const p of pending.values()) p.reject(new Error(why)); pending.clear(); worker = null; });
}
function call(method, args) {
  if (!worker) startWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args, secrets: secrets() }); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 940, minHeight: 640, title: "Контроль звонков", backgroundColor: "#FBFBFA",
    icon: join(here, "ui", "icon.png"),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.on("close", e => {
    if (!busy) return;
    const r = dialog.showMessageBoxSync(win, { type: "warning", buttons: ["Не закрывать", "Закрыть"], defaultId: 0, cancelId: 0, title: "Контроль звонков", message: "Идёт разбор звонков", detail: "Разобранные звонки уже сохранены, остальные можно будет обработать заново. Всё равно закрыть?" });
    if (r === 0) e.preventDefault();
  });
  win.loadFile(join(here, "ui", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { openUrl(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", e => e.preventDefault());
}

function openUrl(u) { if (typeof u === "string" && /^https:\/\//i.test(u)) shell.openExternal(u); }
const OPENABLE = new Set([".html", ".xlsx", ".pdf", ".json", ".md", ".txt", ".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac", ".webm", ".amr", ".wma"]);
function openPath(p) {
  try {
    if (typeof p !== "string" || !existsSync(p)) return "Файл не найден";
    if (statSync(p).isDirectory() || OPENABLE.has(extname(p).toLowerCase())) return shell.openPath(p);
    return "Этот тип файла приложение не открывает";
  } catch (e) { return e.message; }
}

/** PDF из HTML-отчёта: скрытое окно без доступа к Node, печать средствами Chromium */
async function printPdf(html, out) {
  const tmp = join(tmpdir(), `zvonki-${process.pid}-${Date.now()}.html`);
  writeFileSync(tmp, html);
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  try {
    await w.loadURL(pathToFileURL(tmp).href);
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, pdf);
    return out;
  } finally { w.destroy(); try { (await import("node:fs")).rmSync(tmp, { force: true }); } catch { /* занят */ } }
}

ipcMain.handle("core", async (e, method, args) => {
  if (e.sender !== win?.webContents) throw new Error("Нет доступа");
  if (method === "saveConfig") {
    const patch = structuredClone(args?.patch ?? {});
    for (const k of SECRET_KEYS) {
      const v = getPath(patch, k);
      if (v === undefined) continue;
      if (v === "") delPath(patch, k); // пустое поле — ключ не меняем
      else if (v === "\u0000clear") setPath(patch, k, ""); // кнопка «Отключить»
      else setPath(patch, k, enc(v));
    }
    return maskConfig(await call("saveConfig", { patch }));
  }
  if (method === "process" || method === "fetch") busy = true;
  try {
    const r = await call(method, args);
    if (method === "status") r.config = maskConfig(r.config);
    if (method === "reportFiles" && r?.pdfHtml) { r.files.push(await printPdf(r.pdfHtml, r.pdfPath)); delete r.pdfHtml; }
    return r;
  } finally { if (method === "process" || method === "fetch") busy = false; }
});

ipcMain.handle("pick-dir", async () => { const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle("pick-file", async (_e, kind) => {
  const filters = kind === "export" ? [{ name: "Выгрузка телефонии", extensions: ["csv", "xlsx", "xls", "ods"] }]
    : kind === "script" ? [{ name: "Скрипт продаж", extensions: ["md", "txt", "docx", "xlsx", "csv", "json"] }]
      : [{ name: "Записи звонков", extensions: ["mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "amr", "webm", "wma"] }];
  const r = await dialog.showOpenDialog(win, { properties: kind === "audio" ? ["openFile", "multiSelections"] : ["openFile"], filters });
  return r.canceled ? null : kind === "audio" ? r.filePaths : r.filePaths[0];
});
ipcMain.handle("open", (_e, p) => openPath(p));
ipcMain.handle("open-url", (_e, u) => openUrl(u));
ipcMain.handle("version", () => pkg.version);
ipcMain.handle("copy", async (_e, t) => { const { clipboard } = await import("electron"); clipboard.writeText(String(t).slice(0, 2000)); });

// Загрузка из телефонии по расписанию, пока приложение открыто
let timer = null;
async function schedule() {
  clearInterval(timer);
  try {
    const st = await call("status", {});
    const m = st.config.telephony?.everyMinutes ?? 0;
    if (st.config.telephony?.provider && m > 0) timer = setInterval(() => { if (!busy) { busy = true; call("fetch", { auto: true }).catch(() => {}).finally(() => { busy = false; }); } }, m * 60_000);
  } catch { /* настроек ещё нет */ }
}
ipcMain.handle("reschedule", () => schedule());

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();
  schedule();
  if (process.env.ZVONKI_SMOKE) smoke(process.env.ZVONKI_SMOKE);
});

// Самопроверка собранного приложения (CI): обработчик, модели распознавания, разбор папки, отчёт, снимок окна
async function smoke(dir) {
  const fail = e => { console.error("SMOKE FAIL", e?.message ?? e); app.exit(1); };
  setTimeout(() => fail("таймаут"), 900_000);
  try {
    await new Promise(r => win.webContents.once("did-finish-load", r));
    const st = await call("status", {});
    if (st.missingAsr.length) await call("download", { packs: ["asr", "speakers"] });
    const r = await call("process", { folder: dir, review: false });
    const rep = await call("reportFiles", { from: "2000-01-01", to: "2100-01-01", formats: ["html", "xlsx", "pdf"], dir: process.env.ZVONKI_SMOKE_OUT ?? tmpdir() });
    if (rep.pdfHtml) rep.files.push(await printPdf(rep.pdfHtml, rep.pdfPath));
    await win.webContents.executeJavaScript("window.__kzShow && window.__kzShow('calls')", true).catch(() => {});
    await new Promise(res => setTimeout(res, 1500));
    const png = await win.webContents.capturePage();
    writeFileSync(join(process.env.ZVONKI_SMOKE_OUT ?? tmpdir(), "smoke.png"), png.toPNG());
    console.log("SMOKE OK", JSON.stringify({ version: st.version, done: r.done, failed: r.failed, files: rep.files.map(f => f.split(/[\\/]/).pop()) }));
    if (!r.done || r.failed.length) return fail("звонки не разобраны");
    app.exit(0);
  } catch (e) { fail(e); }
}
app.on("window-all-closed", () => { worker?.kill(); app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
