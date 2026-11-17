// Фоновый процесс: распознавание и оценка не тормозят окно. Методы вызываются из главного процесса.
import * as core from "../dist/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = process.parentPort;
const send = m => port.postMessage(m);
const net = () => send({ type: "net", ...core.netStats() });

let downloading = null;
let hw = null;
let llm = null;
let stop = null;
let team = null;

async function models(c) {
  hw ??= await core.detectHardware();
  const r = core.recommend(hw);
  if (!c.llm.localModel) { core.saveConfig({ llm: { localModel: r.model.id } }); c = core.loadConfig(); }
  return { selected: core.selectLlm(c.llm.localModel), recommended: r.model.id, reason: r.reason, hw,
    options: r.options.map(o => ({ id: o.model.id, tier: o.model.tier, title: o.model.title, vendor: o.model.vendor, note: o.model.note, size: o.model.file.size, ok: o.ok, why: o.why })) };
}
async function getLlm(c) { return (llm ??= await core.createLLM(c.llm)); }
async function freeLlm() { const m = llm; llm = null; await m?.dispose().catch(() => {}); }

const brief = r => ({ id: r.meta.id, date: r.meta.date, manager: r.meta.manager, client: r.meta.client, direction: r.meta.direction, source: r.meta.source, duration: r.metrics.duration, score: r.review?.score ?? null, outcome: r.review?.outcome ?? null, missed: !!r.review?.missed, summary: r.review?.summary ?? "", interest: r.review?.interest?.quote ?? "", followUp: r.followUp ?? null, talkRatio: r.metrics.talkRatio });
const phone = (c, p) => (c.showPhones ? p : core.maskPhone(p));

async function runProcess(metas, c, o = {}) {
  const ac = new AbortController();
  stop = ac;
  try {
    const wantReview = o.review !== false;
    const r = await core.processCalls(metas, {
      config: c, review: wantReview, force: !!o.force, signal: ac.signal,
      getLlm: wantReview && (c.llm.provider === "openai" || !core.missing(["llm"]).length) ? () => getLlm(c) : undefined,
      onProgress: e => send({ type: "progress", ...e, file: e.file.split(/[\\/]/).pop() }),
    });
    net();
    return { done: r.done.length, skipped: r.skipped.length, failed: r.failed.map(f => ({ file: f.file.split(/[\\/]/).pop(), error: f.error })), missed: r.done.filter(x => x.review?.missed).length, model: r.model };
  } finally { stop = null; }
}

const methods = {
  async status() {
    let c = core.loadConfig();
    const llmInfo = await models(c);
    c = core.loadConfig();
    return {
      version: core.VERSION, config: c, llm: llmInfo, missing: core.missing().map(f => f.path), missingAsr: core.missing(["asr", "speakers"]).map(f => f.path),
      packs: core.plan(), downloading: !!downloading, net: core.netStats(),
      templates: core.TEMPLATES.map(t => ({ id: t.id, title: t.title, description: t.description, items: t.items })),
      telephony: Object.entries(core.TELEPHONY).map(([id, t]) => ({ id, ...t })), team: team ? { url: team.url, lan: team.lan } : null,
      calls: core.allRecords(c.archiveDir).length,
    };
  },
  async download({ packs } = {}) {
    if (downloading) return downloading;
    downloading = core.download(packs, e => send({ type: "progress", stage: "download", ...e })).then(() => true).finally(() => { downloading = null; net(); });
    return downloading;
  },
  async setModel({ id }) { await freeLlm(); core.saveConfig({ llm: { ...core.loadConfig().llm, localModel: id } }); return methods.status(); },
  saveConfig({ patch }) { const c = core.saveConfig(patch); core.setOffline(c.offline); if (patch.llm) void freeLlm(); return c; },
  async script() { const c = core.loadConfig(); const s = await core.resolveScript(c); return s; },
  async parseScript({ file }) { const s = await core.loadScript(file); return s; },
  async useScript({ id, file }) {
    if (file) { await core.loadScript(file); core.saveConfig({ scriptId: "custom", scriptFile: file }); }
    else { core.getTemplate(id); core.saveConfig({ scriptId: id, scriptFile: "" }); }
    return core.resolveScript(core.loadConfig());
  },
  async preview({ folder, files, exportFile }) {
    const c = core.loadConfig();
    const list = files?.length ? files : core.scanFolder(folder);
    const x = exportFile ? await core.readExport(exportFile) : null;
    const metas = core.buildMeta(list, x?.rows ?? [], { managers: c.managers, provider: x?.provider });
    const done = new Set(core.allRecords(c.archiveDir).filter(r => r.review).map(r => r.meta.id));
    return { count: metas.length, fresh: metas.filter(m => !done.has(m.id)).length, provider: x?.provider ?? null, columns: x?.columns ?? null, managers: [...new Set(metas.map(m => m.manager))].slice(0, 50) };
  },
  async process({ folder, files, exportFile, review, force, manager }) {
    const c = core.loadConfig();
    const list = files?.length ? files : core.scanFolder(folder);
    if (!list.length) throw new Error("В папке нет записей звонков (mp3, wav, ogg, m4a…)");
    const x = exportFile ? await core.readExport(exportFile) : null;
    return runProcess(core.buildMeta(list, x?.rows ?? [], { managers: c.managers, provider: x?.provider, defaultManager: manager }), c, { review, force });
  },
  stop() { stop?.abort(); return true; },
  async fetch({ from, to, auto } = {}) {
    const c = core.loadConfig();
    core.setOffline(c.offline);
    if (!c.telephony.provider) throw new Error("Телефония не подключена");
    const f = new Date(from ? from + "T00:00:00" : c.telephony.last ?? new Date(Date.now() - 7 * 86400_000).toISOString());
    const t = to ? new Date(to + "T23:59:59") : new Date();
    const got = await core.fetchRecordings(c.telephony, c.archiveDir, f, t, (d, n) => send({ type: "progress", stage: "fetch", done: d, total: n }));
    const metas = got.metas.map(m => ({ ...m, manager: c.managers[m.manager] ?? m.manager }));
    const r = await runProcess(metas, c);
    core.saveConfig({ telephony: { ...c.telephony, last: t.toISOString() } });
    if (auto) send({ type: "fetched", count: r.done, missed: r.missed });
    return { ...r, downloaded: got.metas.length, fetchFailed: got.failed.length, fetchErrors: got.failed.slice(0, 3).map(x => x.error) };
  },
  async checkTelephony() {
    const c = core.loadConfig();
    core.setOffline(c.offline);
    const list = await core.listRemote(c.telephony, new Date(Date.now() - 86400_000), new Date());
    net();
    return { ok: true, calls: list.length };
  },
  list({ filter } = {}) {
    const c = core.loadConfig();
    return core.filterRecords(core.allRecords(c.archiveDir), filter ?? {}).slice(0, 2000).map(r => ({ ...brief(r), client: phone(c, r.meta.client) }));
  },
  get({ id }) {
    const c = core.loadConfig();
    const r = core.getRecord(c.archiveDir, id);
    if (!r) throw new Error("Звонок не найден");
    return { ...r, meta: { ...r.meta, client: phone(c, r.meta.client) }, hints: core.metricHints(r.metrics), labels: { outcomes: core.OUTCOMES, objections: core.OBJECTION_TYPES, interest: core.INTEREST } };
  },
  async swap({ id }) {
    const c = core.loadConfig();
    const r = core.getRecord(c.archiveDir, id);
    if (!r) throw new Error("Звонок не найден");
    r.transcript = core.swapRoles(r.transcript);
    r.metrics = core.computeMetrics(r.transcript.turns, r.transcript.duration);
    r.review = undefined;
    core.saveRecord(c.archiveDir, r);
    return methods.rereview({ id });
  },
  async rereview({ id }) {
    const c = core.loadConfig();
    const r = core.getRecord(c.archiveDir, id);
    if (!r) throw new Error("Звонок не найден");
    const script = await core.resolveScript(c);
    r.review = await core.reviewCall(await getLlm(c), r.transcript, script, { callId: id, date: r.meta.date });
    core.saveRecord(c.archiveDir, r);
    return methods.get({ id });
  },
  setManager({ id, manager }) {
    const c = core.loadConfig();
    const r = core.getRecord(c.archiveDir, id);
    if (!r) throw new Error("Звонок не найден");
    r.meta.manager = String(manager).trim().slice(0, 100) || "Без менеджера";
    core.saveRecord(c.archiveDir, r);
    return true;
  },
  followUp({ id, status, note }) {
    const c = core.loadConfig();
    const r = core.getRecord(c.archiveDir, id);
    if (!r) throw new Error("Звонок не найден");
    r.followUp = status ? { status, note: note?.slice(0, 500), at: new Date().toISOString() } : undefined;
    core.saveRecord(c.archiveDir, r);
    return brief(r);
  },
  async sendDeal({ id }) {
    const c = core.loadConfig();
    core.setOffline(c.offline);
    const r = core.getRecord(c.archiveDir, id);
    if (!r) throw new Error("Звонок не найден");
    const res = await core.sendDeal(r, c.crm);
    if (res.some(x => x.ok)) { r.followUp = { status: "crm", link: res.find(x => x.link)?.link, at: new Date().toISOString() }; core.saveRecord(c.archiveDir, r); }
    net();
    return res;
  },
  async checkCrm({ target }) {
    const c = core.loadConfig();
    core.setOffline(c.offline);
    if (target === "telegram") return core.toTelegram("Контроль звонков: проверка подключения", c.crm.telegram ?? {});
    const ok = target === "amocrm" ? core.validAmoDomain(c.crm.amocrm?.domain ?? "") && !!c.crm.amocrm?.token : target === "bitrix24" ? !core.validBitrixWebhook(c.crm.bitrix24?.webhook ?? "") : !!c.crm.yougile?.key;
    return { target, ok, error: ok ? undefined : "Проверьте адрес и ключ" };
  },
  summary({ from, to }) {
    const c = core.loadConfig();
    const recs = core.filterRecords(core.allRecords(c.archiveDir), { from, to });
    return { summary: core.periodSummary(recs, from, to), labels: { outcomes: core.OUTCOMES, objections: core.OBJECTION_TYPES } };
  },
  manager({ name, from, to }) {
    const c = core.loadConfig();
    const recs = core.filterRecords(core.allRecords(c.archiveDir), { from, to, manager: name });
    return { stat: core.managerStat(name, recs), calls: recs.map(r => ({ ...brief(r), client: phone(c, r.meta.client) })), labels: { objections: core.OBJECTION_TYPES } };
  },
  async reportFiles({ from, to, manager, formats, dir }) {
    const c = core.loadConfig();
    const recs = core.filterRecords(core.allRecords(c.archiveDir), { from, to, manager });
    if (!recs.length) throw new Error("За период нет звонков");
    const out = dir || c.outputDir;
    mkdirSync(out, { recursive: true });
    const base = join(out, `звонки_${from}_${to}${manager ? "_" + manager.replace(/[^\p{L}\d]+/gu, "-") : ""}`);
    const p = core.periodSummary(recs, from, to);
    const html = manager ? core.managerHtml(core.managerStat(manager, recs), recs, { showPhones: c.showPhones, from, to }) : core.periodHtml(p, recs, { showPhones: c.showPhones });
    const files = [];
    if (formats.includes("html")) { writeFileSync(base + ".html", html); files.push(base + ".html"); }
    if (formats.includes("xlsx")) files.push(await core.toXlsx(recs, base + ".xlsx", { showPhones: c.showPhones, summary: p }));
    return { files, ...(formats.includes("pdf") ? { pdfHtml: html, pdfPath: base + ".pdf" } : {}) };
  },
  async callFile({ id }) {
    const c = core.loadConfig();
    const r = core.getRecord(c.archiveDir, id);
    if (!r) throw new Error("Звонок не найден");
    mkdirSync(c.outputDir, { recursive: true });
    const f = join(c.outputDir, `звонок_${r.meta.date.slice(0, 16).replace(/[:T]/g, "-")}_${r.meta.id}.html`);
    writeFileSync(f, core.callHtml(r, { showPhones: c.showPhones }));
    return f;
  },
  async telegramSummary({ from, to }) {
    const c = core.loadConfig();
    core.setOffline(c.offline);
    const recs = core.filterRecords(core.allRecords(c.archiveDir), { from, to });
    return core.toTelegram(core.summaryText(core.periodSummary(recs, from, to)), c.crm.telegram ?? {});
  },
  async teamStart() {
    const c = core.loadConfig();
    if (team) return { url: team.url };
    let token = c.team.token;
    if (!token) { token = core.newToken(); core.saveConfig({ team: { ...c.team, token } }); }
    const queue = [];
    let busy = false;
    const pump = async () => { if (busy) return; busy = true; while (queue.length) { await runProcess([queue.shift()], core.loadConfig()).catch(() => {}); send({ type: "team", queued: queue.length }); } busy = false; };
    const srv = await core.startTeamServer({ archiveDir: c.archiveDir, port: c.team.port, lan: c.team.lan, token, showPhones: c.showPhones, onUpload: m => { queue.push(m); void pump(); } });
    team = { url: srv.url, lan: c.team.lan, close: () => srv.close() };
    return { url: srv.url };
  },
  teamStop() { team?.close(); team = null; return true; },
  netStats() { return core.netStats(); },
};

port.on("message", async e => {
  const { id, method, args, secrets } = e.data;
  core.setSecrets(secrets);
  try {
    const fn = methods[method];
    if (!fn) throw new Error("Неизвестный метод: " + method);
    send({ id, result: await fn(args ?? {}) });
  } catch (err) { send({ id, error: String(err?.message ?? err) }); }
});
