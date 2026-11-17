// Общий кабинет отдела и разбор на «сервере» отдела: один компьютер в локальной сети показывает руководителю и менеджерам
// сводку, отчёты и карточки звонков в браузере, а также принимает записи с других компьютеров и разбирает их у себя.
// Доступ — только по ключу. По умолчанию слушает только этот компьютер (127.0.0.1); локальная сеть — по явной настройке.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { allRecords, filterRecords, getRecord } from "../store.js";
import { managerStat, periodSummary } from "../report/aggregate.js";
import { callHtml, esc, managerHtml, periodHtml } from "../report/html.js";
import { AUDIO_EXT, callId, normPhone, parseDate, parseDirection } from "../import/sources.js";
import type { CallMeta } from "../types.js";

export interface TeamServerOptions {
  archiveDir: string;
  port: number;
  /** true — доступен в локальной сети (0.0.0.0), иначе только с этого компьютера */
  lan: boolean;
  token: string;
  showPhones?: boolean;
  /** Новая запись принята — поставить в очередь разбора */
  onUpload?: (meta: CallMeta) => void;
}

export const MAX_UPLOAD = 300 * 1024 * 1024;
export const newToken = () => randomBytes(24).toString("base64url");
const COOKIE = "zvonki_key";

function same(a: string, b: string) {
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

const SEC_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cache-control": "no-store",
};

function send(res: ServerResponse, code: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) {
  res.writeHead(code, { ...SEC_HEADERS, "content-type": type, ...extra });
  res.end(body);
}

const nav = (html: string, links: string) => html.replace('<main class="sheet">', `<main class="sheet"><p style="font-size:13px"><a href="./">Сводка</a>${links}</p>`);

export function startTeamServer(o: TeamServerOptions): Promise<Server & { url: string }> {
  if (!o.token || o.token.length < 16) throw new Error("Для кабинета нужен ключ доступа не короче 16 символов");
  const fails = new Map<string, { n: number; until: number }>();
  const srv = createServer(async (req, res) => {
    try { await handle(req, res); } catch (e: any) { send(res, 500, "Ошибка: " + esc(e?.message ?? e), "text/plain; charset=utf-8"); }
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const ip = req.socket.remoteAddress ?? "";
    const url = new URL(req.url ?? "/", "http://x");
    // защита от DNS rebinding: без доступа из сети принимаем только адреса этого компьютера
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!o.lan && !["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(res, 421, "Неверный адрес", "text/plain; charset=utf-8");
    if (url.pathname === "/health") return send(res, 200, "ok", "text/plain; charset=utf-8");
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return send(res, 429, "Слишком много попыток. Подождите минуту.", "text/plain; charset=utf-8");
    const cookie = (req.headers.cookie ?? "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const qkey = url.searchParams.get("key") ?? "";
    const key = bearer || qkey || decodeURIComponent(cookie);
    if (!key || !same(key, o.token)) {
      const x = fails.get(ip) ?? { n: 0, until: 0 };
      x.n++; if (x.n >= 10) { x.until = Date.now() + 60_000; x.n = 0; }
      fails.set(ip, x);
      return send(res, 401, `<!doctype html><meta charset="utf-8"><title>Контроль звонков</title><p style="font:16px system-ui;margin:40px">Нужен ключ доступа. Откройте ссылку из приложения «Контроль звонков» (Настройки → Общий кабинет).</p>`);
    }
    fails.delete(ip);
    if (qkey && req.method === "GET") {
      url.searchParams.delete("key");
      return send(res, 303, "", "text/plain", { location: url.pathname + (url.search || ""), "set-cookie": `${COOKIE}=${encodeURIComponent(o.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }

    if (req.method === "POST" && url.pathname === "/api/upload") return upload(req, res);
    if (req.method !== "GET") return send(res, 405, "Метод не поддерживается", "text/plain; charset=utf-8");

    const recs = allRecords(o.archiveDir);
    const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
    const okDate = (d: string) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!okDate(from) || !okDate(to)) return send(res, 400, "Дата в формате ГГГГ-ММ-ДД", "text/plain; charset=utf-8");
    const sel = filterRecords(recs, { from: from || undefined, to: to || undefined });
    const q = from ? `&from=${from}&to=${to}` : "";
    const show = { showPhones: !!o.showPhones, links: { manager: (n: string) => `manager?name=${encodeURIComponent(n)}${q}`, call: (id: string) => `call?id=${id}` } };
    if (url.pathname === "/") {
      const p = periodSummary(sel, from, to);
      return send(res, 200, periodHtml(p, sel, show));
    }
    if (url.pathname === "/manager") {
      const name = url.searchParams.get("name") ?? "";
      const mine = sel.filter(r => r.meta.manager === name);
      if (!mine.length) return send(res, 404, "Нет звонков этого менеджера", "text/plain; charset=utf-8");
      return send(res, 200, nav(managerHtml(managerStat(name, mine), mine, { ...show, from: from || undefined, to: to || undefined }), ` · ${esc(name)}`));
    }
    if (url.pathname === "/call") {
      const r = getRecord(o.archiveDir, url.searchParams.get("id") ?? "");
      if (!r) return send(res, 404, "Звонок не найден", "text/plain; charset=utf-8");
      return send(res, 200, nav(callHtml(r, show), ` · <a href="manager?name=${encodeURIComponent(r.meta.manager)}">${esc(r.meta.manager)}</a>`));
    }
    if (url.pathname === "/api/summary") return send(res, 200, JSON.stringify(periodSummary(sel, from, to)), "application/json; charset=utf-8");
    if (url.pathname === "/api/calls") return send(res, 200, JSON.stringify(sel.slice(0, 1000).map(r => ({ id: r.meta.id, date: r.meta.date, manager: r.meta.manager, score: r.review?.score ?? null, outcome: r.review?.outcome ?? null, missed: !!r.review?.missed }))), "application/json; charset=utf-8");
    return send(res, 404, "Не найдено", "text/plain; charset=utf-8");
  }

  /** Приём записи: тело запроса — сам файл; сведения — в заголовках X-File-Name, X-Manager, X-Client, X-Direction, X-Date */
  function upload(req: IncomingMessage, res: ServerResponse) {
    const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "")).replace(/[^\p{L}\d._ -]/gu, "_").slice(0, 120);
    // отказ до чтения тела: закрываем соединение, чтобы не принимать лишние данные
    const refuse = (code: number, msg: string) => { send(res, code, msg, "text/plain; charset=utf-8", { connection: "close" }); req.resume(); res.on("finish", () => req.socket.destroy()); };
    if (!AUDIO_EXT.test(name)) return refuse(400, "Нужен файл записи: mp3, wav, ogg, m4a…");
    const len = Number(req.headers["content-length"] ?? 0);
    if (len > MAX_UPLOAD) return refuse(413, "Запись больше 300 МБ");
    const dir = join(o.archiveDir, "inbox", "upload");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}_${name}`);
    const out = createWriteStream(file, { flags: "wx" });
    let size = 0, tooBig = false;
    req.on("data", c => { size += c.length; if (size > MAX_UPLOAD && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); send(res, 413, "Запись больше 300 МБ", "text/plain; charset=utf-8"); req.destroy(); } });
    req.pipe(out);
    out.on("finish", () => {
      if (tooBig) return;
      const h = (k: string) => decodeURIComponent(String(req.headers[k] ?? "")).slice(0, 100);
      const st = statSync(file);
      const meta: CallMeta = { id: callId(file, st.size, st.mtimeMs), file, manager: h("x-manager") || "Без менеджера", client: normPhone(h("x-client")), direction: parseDirection(h("x-direction")), date: parseDate(h("x-date")) ?? new Date().toISOString().slice(0, 19), source: "Загрузка в кабинет" };
      o.onUpload?.(meta);
      send(res, 201, JSON.stringify({ id: meta.id, queued: !!o.onUpload }), "application/json; charset=utf-8");
    });
    out.on("error", e => { if (!tooBig) send(res, 500, "Не удалось сохранить: " + e.message, "text/plain; charset=utf-8"); });
  }

  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(o.port, o.lan ? "0.0.0.0" : "127.0.0.1", () => {
      srv.requestTimeout = 30 * 60_000;
      resolve(Object.assign(srv, { url: `http://${o.lan ? "<адрес-этого-ПК>" : "127.0.0.1"}:${o.port}/?key=${encodeURIComponent(o.token)}` }));
    });
  });
}

