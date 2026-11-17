import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMeta, maskPhone, mapColumns, normPhone, parseCsv, parseDate, parseDirection, parseFileName, readExport, resolveManager, scanFolder } from "../src/import/sources.js";
import { computeMetrics, metricHints } from "../src/analyze/metrics.js";
import { managerScore, pickManager, swapRoles, callText } from "../src/asr/transcribe.js";
import { getTemplate, loadScript, parseScript, TEMPLATES } from "../src/analyze/scripts.js";
import { emptyReview, finalize, locate, mergeParts, scoreOf, splitTurns, systemPrompt, type RawReview } from "../src/analyze/review.js";
import type { CallRecord, CallTranscript, Turn } from "../src/types.js";
import { allRecords, deleteRecord, filterRecords, getRecord, lock, saveRecord } from "../src/store.js";
import { isoWeek, managerStat, periodSummary } from "../src/report/aggregate.js";
import { callHtml, managerHtml, periodHtml } from "../src/report/html.js";
import { safeCell, toXlsx } from "../src/report/files.js";
import { loadConfig, parseManagers, saveConfig } from "../src/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "kz-"));

// Реплики для проверки правил кода (не evals качества: те — на открытых записях, см. evals/)
const T = (start: number, end: number, role: "manager" | "client", text: string): Turn => ({ start, end, role, text });
const turns: Turn[] = [
  T(0, 4, "client", "Алло."),
  T(4.5, 12, "manager", "Добрый день, компания Окна Плюс, меня зовут Анна. Вы оставляли заявку на замер?"),
  T(12.5, 16, "client", "Да, хотели узнать, сколько стоят пластиковые окна в квартиру."),
  T(16.5, 30, "manager", "Подскажите, сколько окон и какой этаж? Нужен ли монтаж откосов?"),
  T(30.5, 36, "client", "Три окна, пятый этаж. Но у вас, наверное, дорого, мне соседи говорили."),
  T(36.2, 50, "manager", "Понимаю. Цена зависит от профиля, есть вариант эконом от двенадцати тысяч за окно, замер бесплатный."),
  T(50.5, 55, "client", "Ну давайте замер, если бесплатно."),
  T(55.5, 64, "manager", "Отлично, записываю на замер в четверг в десять утра, мастер позвонит за час."),
  T(64.5, 66, "client", "Хорошо, договорились."),
];
const tr: CallTranscript = { file: "t.mp3", duration: 70, layout: "stereo", turns, roles: { source: "channel", managerChannel: 0, confident: true }, stats: { asrSeconds: 1, rtf: 0.1, device: "CPU" } };

describe("импорт и выгрузки телефонии", () => {
  it("CSV с ; и кавычками, заголовок не в первой строке", async () => {
    const d = tmp(), f = join(d, "mango.csv");
    writeFileSync(f, 'Отчёт по звонкам за ноябрь\n"Дата/время";"Тип вызова";"Кто звонил";"Сотрудник";"Длительность";"Запись"\n"12.11.2026 10:15:00";"Входящий";"+7 (916) 123-45-67";"101";"95";"rec_001.mp3"\n');
    const x = await readExport(f);
    expect(x.rows).toHaveLength(1);
    expect(x.rows[0]).toMatchObject({ date: "12.11.2026 10:15:00", direction: "Входящий", manager: "101", record: "rec_001.mp3" });
    expect(normPhone(x.rows[0].client)).toBe("+79161234567");
  });
  it("CSV в windows-1251", async () => {
    const d = tmp(), f = join(d, "sip.csv");
    const enc = new TextEncoder();
    // «Дата;Сотрудник;Клиент» в cp1251
    const cp = (s: string) => Buffer.from([...s].map(ch => { const c = ch.charCodeAt(0); return c >= 0x410 && c <= 0x44f ? c - 0x410 + 0xc0 : c; }));
    writeFileSync(f, Buffer.concat([cp("Дата;Сотрудник;Клиент\n"), enc.encode("2026-11-12 10:00;Ivan;89161234567\n")]));
    const x = await readExport(f);
    expect(x.rows[0].manager).toBe("Ivan");
  });
  it("колонки узнаются по синонимам", () => {
    expect(mapColumns(["callstart", "sip", "clid", "seconds", "pbx_call_id"])).toMatchObject({ date: 0, manager: 1, client: 2, duration: 3, id: 4 });
    expect(mapColumns(["CALL_START_DATE", "PORTAL_USER_ID", "PHONE_NUMBER", "CALL_TYPE", "CALL_RECORD_URL"])).toMatchObject({ date: 0, manager: 1, client: 2, direction: 3, record: 4 });
  });
  it("даты, направление, телефоны", () => {
    expect(parseDate("12.11.2026 9:05")).toBe("2026-11-12T09:05:00");
    expect(parseDate("20261112-101500")).toBe("2026-11-12T10:15:00");
    expect(parseDate("2026-11-12 10:15:30")).toBe("2026-11-12T10:15:30");
    expect(parseDate("abc")).toBeNull();
    expect(parseDirection("Исходящий")).toBe("out");
    expect(parseDirection("2")).toBe("in");
    expect(parseDirection("incoming")).toBe("in");
    expect(maskPhone("89161234567")).toBe("+7 9** ***-45-67");
    expect(normPhone("9161234567")).toBe("+79161234567");
  });
  it("имя файла записи", () => {
    const p = parseFileName("2026-11-12_10-15-00_79161234567_101_out.mp3");
    expect(p).toMatchObject({ date: "2026-11-12T10:15:00", phones: ["+79161234567"], ext: "101", direction: "out" });
  });
  it("сопоставление файлов с выгрузкой: по имени и по времени ± 90 с", () => {
    const d = tmp();
    const a = join(d, "rec_001.mp3"), b = join(d, "20261112-111000_79005554433.mp3");
    writeFileSync(a, Buffer.alloc(2048)); writeFileSync(b, Buffer.alloc(2048));
    const rows = [
      { date: "12.11.2026 10:15", manager: "101", client: "+79161234567", direction: "Входящий", duration: "95", record: "rec_001.mp3", id: "" },
      { date: "12.11.2026 11:10:40", manager: "Петров", client: "89005554433", direction: "исходящий", duration: "60", record: "", id: "" },
    ];
    const m = buildMeta(scanFolder(d), rows, { managers: { "101": "Анна Иванова" }, provider: "Манго Офис" });
    const byFile = Object.fromEntries(m.map(x => [x.file.split(/[\\/]/).pop(), x]));
    expect(byFile["rec_001.mp3"]).toMatchObject({ manager: "Анна Иванова", direction: "in", client: "+79161234567", source: "Манго Офис" });
    expect(byFile["20261112-111000_79005554433.mp3"]).toMatchObject({ manager: "Петров", direction: "out" });
  });
  it("папка: только аудио, без скрытых и пустых", () => {
    const d = tmp();
    writeFileSync(join(d, "a.mp3"), Buffer.alloc(2048)); writeFileSync(join(d, ".b.mp3"), Buffer.alloc(2048));
    writeFileSync(join(d, "c.txt"), "x"); writeFileSync(join(d, "d.wav"), "x");
    expect(scanFolder(d).map(f => f.split(/[\\/]/).pop())).toEqual(["a.mp3"]);
  });
  it("справочник менеджеров", () => {
    expect(parseManagers("101 = Анна\n+79001234567=Пётр\nмусор")).toEqual({ "101": "Анна", "+79001234567": "Пётр" });
    expect(resolveManager("89001234567", { "+79001234567": "Пётр" })).toBe("Пётр");
  });
});

describe("метрики (считает код)", () => {
  it("доля речи, вопросы, пауза, стоп-слова", () => {
    const m = computeMetrics(turns, 70, ["наверное", "к сожалению"]);
    expect(m.talkRatio).toBe(Math.round((m.managerTalk / (m.managerTalk + m.clientTalk)) * 100));
    expect(m.questions).toBe(3);
    expect(m.interruptions).toBe(0);
    expect(m.stopWords).toEqual([]); // «наверное» сказал клиент, а не менеджер
    expect(m.longestPause).toBeCloseTo(0.5, 1);
  });
  it("перебивание: менеджер начал, когда клиент говорил ещё ≥ 0,5 с", () => {
    const m = computeMetrics([T(0, 10, "client", "длинная фраза клиента"), T(5, 12, "manager", "перебил")], 12);
    expect(m.interruptions).toBe(1);
  });
  it("подсказки по порогам", () => {
    expect(metricHints({ ...computeMetrics(turns, 70), talkRatio: 85, duration: 120 }).join(" ")).toMatch(/85 %/);
  });
});

describe("роли: кто менеджер", () => {
  it("по приветствию", () => {
    const g0 = [{ start: 0, text: "Алло." }], g1 = [{ start: 2, text: "Добрый день, компания Окна Плюс, меня зовут Анна." }];
    expect(pickManager([g0, g1], {})).toMatchObject({ manager: 1, source: "greeting", confident: true });
    expect(managerScore(g0)).toBeLessThan(0);
  });
  it("по направлению, если приветствия нет", () => {
    const g0 = [{ start: 0, text: "Да." }], g1 = [{ start: 3, text: "Угу." }];
    expect(pickManager([g0, g1], { direction: "in" }).manager).toBe(0);
    expect(pickManager([g0, g1], { direction: "out" }).manager).toBe(1);
  });
  it("настройка и знакомый голос важнее", () => {
    expect(pickManager([[], []], { setting: 1 })).toMatchObject({ manager: 1, source: "setting" });
    expect(pickManager([[], []], { known: 0 })).toMatchObject({ manager: 0, source: "voice" });
  });
  it("поменять роли", () => {
    const s = swapRoles(tr);
    expect(s.turns[1].role).toBe("client");
    expect(s.roles.managerChannel).toBe(1);
    expect(callText(s)).toMatch(/\[00:04\] Клиент: Добрый день/);
  });
});

describe("скрипты", () => {
  it("пять шаблонов с весами и обязательными пунктами", () => {
    expect(TEMPLATES).toHaveLength(5);
    for (const t of TEMPLATES) { expect(t.items.length).toBeGreaterThanOrEqual(7); expect(t.items.some(i => i.required)).toBe(true); expect(new Set(t.items.map(i => i.id)).size).toBe(t.items.length); }
    expect(() => getTemplate("нет")).toThrow();
  });
  it("свой скрипт из Markdown: заголовок, вес, обязательность, стоп-слова", () => {
    const s = parseScript("# Скрипт салона\n\n1. Поздоровался — назвал салон (обязательно)\n- Выявил потребность — 2 вопроса (вес 2)\n- [ ] Записал на время: дата и время (вес 3, обязательно)\n«Здравствуйте, салон...»\nСтоп-слова: не знаю, наверное");
    expect(s.title).toBe("Скрипт салона");
    expect(s.items.map(i => [i.title, i.weight, !!i.required])).toEqual([["Поздоровался", 1, true], ["Выявил потребность", 2, false], ["Записал на время", 3, true]]);
    expect(s.stopWords).toEqual(["не знаю", "наверное"]);
    expect(() => parseScript("один пункт")).toThrow();
  });
  it("свой скрипт из Word и Excel", async () => {
    const d = tmp();
    const JSZip = (await import("jszip")).default;
    const z = new JSZip();
    z.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>Приветствие — назвал компанию</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Следующий шаг &amp; дата (вес 3)</w:t></w:r></w:p></w:body></w:document>`);
    writeFileSync(join(d, "s.docx"), await z.generateAsync({ type: "nodebuffer" }));
    const s = await loadScript(join(d, "s.docx"));
    expect(s.items.map(i => i.title)).toEqual(["Приветствие", "Следующий шаг & дата"]);
    const XLSX: any = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Пункт", "Подсказка", "Вес"], ["Выявил потребность", "2 вопроса", 2], ["Закрыл на встречу", "дата", 3]]), "Скрипт");
    writeFileSync(join(d, "s.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    expect((await loadScript(join(d, "s.xlsx"))).items.map(i => i.weight)).toEqual([2, 3]);
  });
});

const script = getTemplate("incoming");
const raw = (over: Partial<RawReview> = {}): RawReview => ({
  is_sales: true,
  items: [
    { id: "greet", status: "yes", quote: "компания Окна Плюс, меня зовут Анна", comment: "" },
    { id: "name", status: "no", quote: "", comment: "имя не спросила" },
    { id: "needs", status: "yes", quote: "сколько окон и какой этаж", comment: "" },
    { id: "present", status: "partial", quote: "есть вариант эконом от двенадцати тысяч за окно", comment: "" },
    { id: "price", status: "yes", quote: "от двенадцати тысяч за окно, замер бесплатный", comment: "" },
    { id: "objections", status: "yes", quote: "Понимаю. Цена зависит от профиля", comment: "" },
    { id: "next", status: "yes", quote: "записываю на замер в четверг в десять утра", comment: "" },
    { id: "fix", status: "yes", quote: "мастер позвонит за час", comment: "" },
    { id: "contact", status: "yes", quote: "продиктуйте вашу почту для договора", comment: "" },
    { id: "bye", status: "na", quote: "", comment: "" },
  ],
  objections: [{ type: "price", client_quote: "у вас, наверное, дорого", manager_answer: "Цена зависит от профиля, есть вариант эконом", handled: "yes", better: "" }],
  next_step: { agreed: true, text: "Замер", due: "в четверг", quote: "записываю на замер в четверг в десять утра" },
  interest: { level: "high", quote: "хотели узнать, сколько стоят пластиковые окна" },
  outcome: "sale", summary: "Клиент записан на замер.", advice: ["Спросить имя клиента"],
  ...over,
});

describe("оценка: код проверяет цитаты и считает балл", () => {
  it("цитата ищется у нужной стороны", () => {
    expect(locate(turns, "сколько окон и какой этаж", "manager")).toBe(16.5);
    expect(locate(turns, "сколько окон и какой этаж", "client")).toBeNull();
    expect(locate(turns, "одно", "manager")).toBeNull();
  });
  it("выдуманная цитата не засчитывается, «не применимо» без оснований → «нет»", () => {
    const v = finalize(raw(), tr, script, "abcdef0123456789", "2026-11-12T10:00:00", "test");
    const by = Object.fromEntries(v.items.map(i => [i.id, i]));
    expect(by.contact).toMatchObject({ status: "no", unverified: true });
    expect(by.bye.status).toBe("no");
    expect(by.greet.t).toBe(4.5);
    expect(v.quotes.verified).toBeLessThan(v.quotes.total);
    expect(v.warnings.join(" ")).toMatch(/без точной цитаты/);
  });
  it("балл по весам считает код", () => {
    const v = finalize(raw(), tr, script, "abcdef0123456789", "2026-11-12T10:00:00", "test");
    expect(v.score).toBe(scoreOf(v.items, script));
    // да: greet 1 + needs 2 + price 1 + objections 2 + next 3 + fix 2 = 11; частично: present 2/2 = 1; всего весов 16
    expect(v.score).toBe(Math.round((12 / 16) * 100));
  });
  it("следующий шаг и срок: от даты звонка", () => {
    const v = finalize(raw(), tr, script, "abcdef0123456789", "2026-11-12T10:00:00", "test");
    expect(v.nextStep.agreed).toBe(true);
    expect(v.nextStep.due).toBe("2026-11-19"); // 12.11.2026 — четверг, «в четверг» — следующий
    expect(v.missed).toBe(false);
  });
  it("упущенная сделка: интерес подтверждён, шага нет", () => {
    const v = finalize(raw({ next_step: { agreed: true, text: "Перезвонить", due: "", quote: "перезвоню вам завтра обязательно" }, outcome: "no_decision" }), tr, script, "abcdef0123456789", "2026-11-12T10:00:00", "test");
    expect(v.nextStep.agreed).toBe(false); // цитаты нет в записи
    expect(v.missed).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/следующий шаг/);
  });
  it("интерес без слов клиента снижается, упущенной сделки нет", () => {
    const v = finalize(raw({ interest: { level: "high", quote: "очень хочу купить прямо сейчас" }, next_step: { agreed: false, text: "", due: "", quote: "" }, outcome: "no_decision" }), tr, script, "abcdef0123456789", "2026-11-12", "test");
    expect(v.interest.level).toBe("low");
    expect(v.missed).toBe(false);
  });
  it("не продажа: балла нет, пункты «не применимо»", () => {
    const v = finalize(raw({ is_sales: false, outcome: "not_sales" }), tr, script, "abcdef0123456789", "2026-11-12", "test");
    expect(v.score).toBeNull();
    expect(v.items.every(i => i.status === "na")).toBe(true);
    expect(v.objections).toEqual([]);
  });
  it("возражения без слов клиента отбрасываются; без ответа менеджера — «не ответил»", () => {
    const v = finalize(raw({ objections: [
      { type: "price", client_quote: "у вас, наверное, дорого", manager_answer: "это выдуманный ответ менеджера", handled: "yes", better: "" },
      { type: "trust", client_quote: "я вам не доверяю совсем", manager_answer: "", handled: "no", better: "" },
    ] }), tr, script, "abcdef0123456789", "2026-11-12", "test");
    expect(v.objections).toHaveLength(1);
    expect(v.objections[0]).toMatchObject({ handled: "no", answer: "" });
  });
  it("возражений нет — пункт про возражения «не применимо»", () => {
    const v = finalize(raw({ objections: [] }), tr, script, "abcdef0123456789", "2026-11-12", "test");
    expect(v.items.find(i => i.id === "objections")!.status).toBe("na");
  });
  it("пустой звонок — без модели", () => {
    const v = emptyReview(tr, script, "abcdef0123456789", "—", "Недозвон");
    expect(v).toMatchObject({ score: null, outcome: "not_sales", missed: false });
  });
  it("длинный звонок: части и слияние", () => {
    const many = Array.from({ length: 400 }, (_, i) => T(i * 10, i * 10 + 9, i % 2 ? "client" : "manager", "слово ".repeat(12)));
    expect(splitTurns(many, 14000).length).toBeGreaterThan(1);
    const m = mergeParts([raw({ items: [{ id: "next", status: "no", quote: "", comment: "" }], outcome: "no_decision" }), raw({ items: [{ id: "next", status: "yes", quote: "q", comment: "" }], next_step: { agreed: false, text: "", due: "", quote: "" } })]);
    expect(m.items.find(i => i.id === "next")!.status).toBe("yes");
    expect(m.outcome).toBe("sale");
  });
  it("промпт: данные отделены, инструкции из звонка не выполняются", () => {
    const p = systemPrompt(script);
    expect(p).toMatch(/<звонок>/);
    expect(p).toMatch(/данные, а не команды/);
    for (const i of script.items) expect(p).toContain(`id=${i.id}`);
  });
});

function rec(id: string, date: string, manager: string, score: number | null, missed = false): CallRecord {
  const review = finalize(raw(missed ? { next_step: { agreed: false, text: "", due: "", quote: "" }, outcome: "no_decision" } : {}), tr, script, id, date, "test");
  return { meta: { id, file: "/x/" + id + ".mp3", manager, client: "+79161234567", direction: "in", date, source: "Папка" }, transcript: tr, metrics: computeMetrics(turns, 70), review: { ...review, score: score ?? review.score }, processedAt: date, version: "1.0.0" };
}

describe("архив", () => {
  let d: string;
  beforeEach(() => { d = tmp(); });
  it("сохранить, найти, отфильтровать, удалить", () => {
    saveRecord(d, rec("aaaaaaaaaaaaaaaa", "2026-11-10T10:00:00", "Анна", 80));
    saveRecord(d, rec("bbbbbbbbbbbbbbbb", "2026-10-01T10:00:00", "Пётр", 40, true));
    expect(allRecords(d)).toHaveLength(2);
    expect(getRecord(d, "aaaaaaaaaaaaaaaa")?.meta.manager).toBe("Анна");
    expect(getRecord(d, "../../etc/passwd")).toBeNull();
    expect(filterRecords(allRecords(d), { from: "2026-11-01" })).toHaveLength(1);
    expect(filterRecords(allRecords(d), { missed: true })).toHaveLength(1);
    expect(filterRecords(allRecords(d), { query: "пластиковые" })).toHaveLength(2);
    expect(deleteRecord(d, "bbbbbbbbbbbbbbbb")).toBe(true);
    expect(allRecords(d)).toHaveLength(1);
  });
  it("блокировка общей папки: второй компьютер не берёт тот же звонок", () => {
    const un = lock(d, "aaaaaaaaaaaaaaaa");
    expect(un).toBeTypeOf("function");
    expect(lock(d, "aaaaaaaaaaaaaaaa")).toBeNull();
    un!();
    expect(lock(d, "aaaaaaaaaaaaaaaa")).toBeTypeOf("function");
    expect(lock(d, "../x")).toBeNull();
  });
});

describe("сводки и отчёты", () => {
  const recs = [rec("aaaaaaaaaaaaaaaa", "2026-11-10T10:00:00", "Анна", 80), rec("bbbbbbbbbbbbbbbb", "2026-11-11T10:00:00", "Анна", 60, true), rec("cccccccccccccccc", "2026-11-11T12:00:00", "Пётр <script>", 40)];
  it("рейтинг менеджеров и упущенные", () => {
    const p = periodSummary(recs);
    expect(p.managers[0].manager).toBe("Анна");
    expect(p.managers[0].avgScore).toBe(70);
    expect(p.missed).toBe(1);
    expect(isoWeek("2026-11-12")).toBe("2026-W46");
    expect(managerStat("Анна", recs.slice(0, 2)).missed).toBe(1);
  });
  it("HTML экранирует данные из записи и маскирует номера", () => {
    const evil = rec("dddddddddddddddd", "2026-11-11T12:00:00", "<img src=x onerror=alert(1)>", 50);
    evil.transcript = { ...tr, turns: [...tr.turns, T(66, 68, "client", "<script>alert(1)</script>")] };
    const h = callHtml(evil);
    expect(h).not.toMatch(/<script>alert|<img src=x/);
    expect(h).toContain("+7 9** ***-45-67");
    expect(callHtml(evil, { showPhones: true })).toContain("+79161234567");
    expect(periodHtml(periodSummary(recs), recs)).not.toContain("Пётр <script>");
    expect(managerHtml(managerStat("Анна", recs), recs)).toContain("Упущенные сделки");
  });
  it("Excel: листы и защита от формул", async () => {
    expect(safeCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(safeCell(5)).toBe(5);
    const f = await toXlsx(recs, join(tmp(), "r.xlsx"));
    const XLSX: any = await import("xlsx");
    const wb = XLSX.read(readFileSync(f), { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Менеджеры", "Звонки", "Упущенные сделки", "Возражения", "Скрипт"]);
    expect(XLSX.utils.sheet_to_json(wb.Sheets["Звонки"], { header: 1 })[1][2]).toBe("+7 9** ***-45-67");
  });
});

describe("настройки", () => {
  it("сохраняются, ключи из окружения, порт и минуты проверяются", () => {
    process.env.ZVONKI_HOME = tmp();
    process.env.ZVONKI_TELEPHONY_TOKEN = "TEST_ONLY_token";
    const c = saveConfig({ managers: { "101": "Анна" }, team: { port: 80, lan: false } as any, telephony: { provider: "uis", everyMinutes: 99999, minSeconds: 20 } as any, managerChannel: 5 as any });
    expect(c.team.port).toBe(8787);
    expect(c.telephony.everyMinutes).toBe(1440);
    expect(c.managerChannel).toBe("auto");
    expect(loadConfig().telephony.token).toBe("TEST_ONLY_token");
    expect(loadConfig().offline).toBe(true);
    delete process.env.ZVONKI_TELEPHONY_TOKEN;
  });
});

void utimesSync;
