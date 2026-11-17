// Телефония, CRM и общий кабинет — на локальных тестовых серверах (без сети и без настоящих ключей).
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _beeline, _dataApi, _mango, _sipuni, mangoSign, sipuniHash, zadarmaSign, httpsOnly } from "../src/import/telephony.js";
import { dealText, toTelegram, validAmoDomain, validBitrixWebhook } from "../src/integrations/crm.js";
import { startTeamServer, newToken } from "../src/team/server.js";
import { setOffline } from "../src/asr/net.js";
import { audioFile } from "../src/mcp.js";
import type { CallMeta } from "../src/types.js";

setOffline(false);
const tmp = () => mkdtempSync(join(tmpdir(), "kz-i-"));

type H = (req: IncomingMessage, body: string) => { status?: number; body: string | Buffer; type?: string };
async function mock(h: H): Promise<{ url: string; srv: Server; seen: { url: string; body: string; headers: any }[] }> {
  const seen: { url: string; body: string; headers: any }[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", c => (b += c)); req.on("end", () => {
      seen.push({ url: req.url!, body: b, headers: req.headers });
      const r = h(req, b);
      res.writeHead(r.status ?? 200, { "content-type": r.type ?? "application/json" }); res.end(r.body);
    });
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, srv, seen };
}
const from = new Date("2026-11-10T00:00:00"), to = new Date("2026-11-11T00:00:00");

describe("подписи API телефонии", () => {
  it("Zadarma: base64(hex(HMAC-SHA1(method+params+md5(params))))", () => {
    const { q, sign } = zadarmaSign("/v1/statistics/pbx/", { start: "2026-11-10 00:00:00", end: "2026-11-11 00:00:00", version: "2" }, "TEST_ONLY_secret");
    expect(q).toBe("end=2026-11-11+00%3A00%3A00&start=2026-11-10+00%3A00%3A00&version=2");
    const md5 = createHash("md5").update(q).digest("hex");
    expect(sign).toBe(Buffer.from(createHmac("sha1", "TEST_ONLY_secret").update("/v1/statistics/pbx/" + q + md5).digest("hex")).toString("base64"));
  });
  it("Манго: sha256(key + json + salt); Sipuni: md5 значений по алфавиту ключей + секрет", () => {
    expect(mangoSign("k", '{"a":1}', "s")).toBe(createHash("sha256").update('k{"a":1}s').digest("hex"));
    expect(sipuniHash({ to: "2", from: "1", user: "u" }, "sec")).toBe(createHash("md5").update("1+2+u+sec").digest("hex"));
  });
  it("ссылки на записи — только https", () => {
    expect(() => httpsOnly("http://x.ru/a.mp3")).toThrow();
    expect(() => httpsOnly("file:///etc/passwd")).toThrow();
    expect(httpsOnly("https://x.ru/a.mp3")).toBe("https://x.ru/a.mp3");
  });
});

describe("телефония на тестовом сервере", () => {
  it("Манго: запрос отчёта, CSV, загрузка записи", async () => {
    let n = 0;
    const m = await mock(req => {
      if (req.url === "/stats/request") return { body: JSON.stringify({ key: "K1" }) };
      if (req.url === "/stats/result") return n++ === 0 ? { status: 204, body: "" } : { type: "text/csv", body: "[MToxMDc4];1762765200;1762765290;101;;;79161234567;;entry1\n[];1762765300;1762765310;;79005554433;102;;;entry2\n" };
      if (req.url === "/queries/recording/post") return { type: "audio/mpeg", body: Buffer.alloc(4096, 1) };
      return { status: 404, body: "" };
    });
    const list = await _mango({ provider: "mango", key: "TEST_ONLY_k", secret: "TEST_ONLY_s", everyMinutes: 0, minSeconds: 0 }, from, to, m.url);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "entry1", manager: "101", client: "+79161234567", direction: "out", duration: 90 });
    const body = new URLSearchParams(m.seen[0].body);
    expect(body.get("sign")).toBe(mangoSign("TEST_ONLY_k", body.get("json")!, "TEST_ONLY_s"));
    expect((await (await list[0].fetchRecord()).arrayBuffer()).byteLength).toBe(4096);
    m.srv.close();
  });
  it("Sipuni: CSV и запись по ID", async () => {
    const m = await mock(req => req.url === "/statistic/export"
      ? { type: "text/csv", body: "Тип;Статус;Время;Схема;Откуда;Куда;Кто ответил;Длительность звонка;Длительность разговора;Запись существует;ID записи\nИсходящий;Отвечен;10.11.2026 10:00:00;;201;89161234567;Иванов;100;90;1;rec-1\nВходящий;Не отвечен;10.11.2026 11:00:00;;89005554433;201;;10;0;0;\n" }
      : { type: "audio/mpeg", body: Buffer.alloc(2048) });
    const list = await _sipuni({ provider: "sipuni", user: "123", secret: "TEST_ONLY_s", everyMinutes: 0, minSeconds: 0 }, from, to, m.url);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "rec-1", manager: "Иванов", client: "+79161234567", direction: "out", date: "2026-11-10T10:00:00" });
    await list[0].fetchRecord();
    expect(new URLSearchParams(m.seen[1].body).get("hash")).toBe(createHash("md5").update("rec-1+123+TEST_ONLY_s").digest("hex"));
    m.srv.close();
  });
  it("UIS/CoMagic/Новофон: get.calls_report и ссылка на запись", async () => {
    const m = await mock(req => req.url === "/api" ? { body: JSON.stringify({ result: { data: [{ id: 77, start_time: "2026-11-10 10:00:00", direction: "in", contact_phone_number: "79161234567", talk_duration: 61, call_records: ["abc"], employees: [{ employee_full_name: "Анна" }] }, { id: 78, call_records: [] }] } }) } : { type: "audio/mpeg", body: Buffer.alloc(2048) });
    const list = await _dataApi({ provider: "uis", token: "TEST_ONLY_t", everyMinutes: 0, minSeconds: 0 }, from, to, "uis", { api: m.url + "/api", media: m.url + "/media" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "77", manager: "Анна", direction: "in" });
    expect(JSON.parse(m.seen[0].body)).toMatchObject({ method: "get.calls_report", params: { access_token: "TEST_ONLY_t" } });
    await list[0].fetchRecord();
    expect(m.seen[1].url).toBe("/media/77/abc/");
    m.srv.close();
  });
  it("Билайн: список записей и загрузка с токеном", async () => {
    const m = await mock(req => req.url!.startsWith("/records?") ? { body: JSON.stringify([{ id: "r1", phone: "9161234567", direction: "OUTBOUND", date: 1762765200000, duration: 65000, abonent: { firstName: "Анна", lastName: "Иванова" } }]) } : { type: "audio/mpeg", body: Buffer.alloc(2048) });
    const list = await _beeline({ provider: "beeline", token: "TEST_ONLY_t", everyMinutes: 0, minSeconds: 0 }, from, to, m.url);
    expect(list[0]).toMatchObject({ manager: "Иванова Анна", client: "+79161234567", direction: "out", duration: 65 });
    await list[0].fetchRecord();
    expect(m.seen[1].headers["x-mpbx-api-auth-token"]).toBe("TEST_ONLY_t");
    m.srv.close();
  });
  it("строгий офлайн блокирует запросы", async () => {
    setOffline(true);
    await expect(_beeline({ provider: "beeline", token: "x", everyMinutes: 0, minSeconds: 0 }, from, to, "http://127.0.0.1:9")).rejects.toThrow(/офлайн/);
    setOffline(false);
  });
});

describe("CRM", () => {
  it("проверка адресов и токенов", async () => {
    expect(validAmoDomain("shop.amocrm.ru")).toBe(true);
    expect(validAmoDomain("evil.com/x?.amocrm.ru")).toBe(false);
    expect(validBitrixWebhook("https://a.bitrix24.ru/rest/1/abc123/")).toBeNull();
    expect(validBitrixWebhook("http://a.bitrix24.ru/rest/1/abc/")).toMatch(/https/);
    expect((await toTelegram("x", { token: "bad", chatId: "1" })).ok).toBe(false);
  });
});

describe("общий кабинет отдела", () => {
  let srv: any, base: string, token: string, archive: string;
  const got: CallMeta[] = [];
  const req = (path: string, o: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}) => new Promise<{ status: number; body: string; headers: any }>((resolve, reject) => {
    const u = new URL(base + path);
    const r = request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, method: o.method ?? "GET", headers: o.headers }, res => { let b = ""; res.on("data", c => (b += c)); res.on("end", () => resolve({ status: res.statusCode!, body: b, headers: res.headers })); });
    r.on("error", reject); if (o.body) r.write(o.body); r.end();
  });
  beforeAll(async () => {
    archive = tmp(); token = newToken();
    srv = await startTeamServer({ archiveDir: archive, port: 0, lan: false, token, onUpload: m => got.push(m) });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterAll(() => srv.close());
  it("без ключа — 401, с неверным адресом (DNS rebinding) — 421", async () => {
    expect((await req("/")).status).toBe(401);
    expect((await req("/", { headers: { host: "evil.example:80", authorization: "Bearer " + token } })).status).toBe(421);
    expect((await req("/health")).status).toBe(200);
  });
  it("ключ в ссылке → cookie, страница со строгим CSP", async () => {
    const r = await req("/?key=" + encodeURIComponent(token));
    expect(r.status).toBe(303);
    const cookie = String(r.headers["set-cookie"]).split(";")[0];
    expect(cookie).toMatch(/HttpOnly|zvonki_key/);
    const page = await req("/", { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(page.body).toContain("Звонки отдела");
  });
  it("приём записи: аудио — в очередь, другое — отказ", async () => {
    const h = { authorization: "Bearer " + token };
    expect((await req("/api/upload", { method: "POST", headers: { ...h, "x-file-name": "x.exe" }, body: Buffer.alloc(10) })).status).toBe(400);
    const ok = await req("/api/upload", { method: "POST", headers: { ...h, "x-file-name": encodeURIComponent("звонок 1.mp3"), "x-manager": encodeURIComponent("Анна"), "x-client": "89161234567", "x-direction": "out" }, body: Buffer.alloc(4096, 7) });
    expect(ok.status).toBe(201);
    expect(got[0]).toMatchObject({ manager: "Анна", client: "+79161234567", direction: "out" });
    expect(got[0].file.startsWith(join(archive, "inbox", "upload"))).toBe(true);
    expect((await req("/api/upload", { method: "POST", headers: { ...h, "x-file-name": "big.mp3", "content-length": String(400 * 1024 * 1024) } })).status).toBe(413);
  });
  it("перебор ключа ограничен", async () => {
    for (let i = 0; i < 10; i++) await req("/", { headers: { authorization: "Bearer wrong" } });
    expect((await req("/", { headers: { authorization: "Bearer wrong" } })).status).toBe(429);
  });
  it("короткий ключ не принимается", () => {
    expect(() => startTeamServer({ archiveDir: archive, port: 0, lan: false, token: "short" })).toThrow();
  });
});

describe("MCP открывает только аудиофайлы", () => {
  it("не аудио и несуществующие — отказ", () => {
    const d = tmp();
    writeFileSync(join(d, "a.txt"), "x");
    expect(() => audioFile(join(d, "a.txt"))).toThrow(/запис/);
    expect(() => audioFile(join(d, "нет.mp3"))).toThrow(/не найден/);
    writeFileSync(join(d, "ok.mp3"), Buffer.alloc(2048));
    expect(audioFile(join(d, "ok.mp3"))).toBe(join(d, "ok.mp3"));
  });
  it("текст сделки для CRM", () => {
    expect(dealText({ meta: { date: "2026-11-12T10:00:00", manager: "Анна" }, review: { interest: { quote: "сколько стоит" }, summary: "s", missedReason: "r", objections: [] } } as any)).toMatch(/Анна[\s\S]*сколько стоит/);
  });
});
