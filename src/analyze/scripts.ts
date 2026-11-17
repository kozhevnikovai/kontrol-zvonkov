// Скрипты продаж: пять шаблонов и разбор своего файла (MD, TXT, DOCX, XLSX/CSV).
// Формат своего файла: каждый пункт — отдельная строка; «Пункт — что считается выполнением (вес 2, обязательно)».
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { Script, ScriptItem } from "../types.js";

const it = (id: string, title: string, hint: string, weight = 1, required = false): ScriptItem => ({ id, title, hint, weight, ...(required ? { required } : {}) });

export const TEMPLATES: Script[] = [
  {
    id: "incoming", title: "Входящий звонок", description: "Клиент звонит сам: заявка, вопрос о цене или наличии",
    items: [
      it("greet", "Приветствие с названием компании и именем", "Менеджер назвал компанию и представился в начале звонка", 1, true),
      it("name", "Узнал имя клиента", "Спросил, как обращаться, и обращался по имени"),
      it("needs", "Выявил потребность", "Задал хотя бы два вопроса о задаче, сроках, бюджете или ситуации клиента", 2, true),
      it("present", "Презентация под потребность", "Рассказал о продукте через пользу для задачи клиента, а не списком характеристик", 2),
      it("price", "Озвучил цену и условия", "Назвал цену, сроки или условия, когда клиент спросил или пора было"),
      it("objections", "Отработал возражения", "На сомнение клиента ответил по существу, не спорил и не сдавался сразу", 2),
      it("next", "Предложил следующий шаг", "Предложил конкретное действие: заказ, встречу, замер, счёт, КП", 3, true),
      it("fix", "Зафиксировал договорённость", "Проговорил дату, время или канал следующего контакта", 2),
      it("contact", "Получил контакт", "Уточнил телефон, почту или мессенджер для связи"),
      it("bye", "Резюме и прощание", "Кратко повторил договорённости и вежливо попрощался"),
    ],
  },
  {
    id: "cold-b2b", title: "Холодный звонок B2B", description: "Первый звонок компании, которая вас не ждёт",
    items: [
      it("intro", "Представился и назвал причину звонка", "Имя, компания и зачем звонит — в первые 30 секунд", 1, true),
      it("time", "Проверил удобство разговора", "Спросил, удобно ли говорить, или договорился о времени"),
      it("lpr", "Вышел на лицо, принимающее решение", "Выяснил, кто решает, или попросил соединить с ним", 2),
      it("situation", "Вопросы о текущей ситуации", "Узнал, как сейчас устроено то, что он предлагает улучшить", 2, true),
      it("pain", "Нашёл задачу или боль", "Клиент сам назвал проблему, которую можно решить", 2),
      it("value", "Ценностное предложение", "Объяснил, что получит бизнес клиента: деньги, время, риски", 2),
      it("objections", "Отработал возражения", "«Не интересно», «у нас есть поставщик», «пришлите на почту» — ответ по существу", 2),
      it("next", "Договорился о следующем шаге", "Встреча, демонстрация, КП с датой созвона", 3, true),
      it("contact", "Подтвердил контакт и канал", "Почта, мессенджер или прямой телефон ЛПР"),
    ],
  },
  {
    id: "booking", title: "Запись на услугу (B2C)", description: "Салон, клиника, автосервис, обучение",
    items: [
      it("greet", "Приветствие с названием и именем", "Назвал компанию и представился", 1, true),
      it("name", "Узнал имя клиента", "Спросил имя и обращался по имени"),
      it("service", "Уточнил услугу и задачу", "Понял, что именно нужно клиенту, задал уточняющие вопросы", 2),
      it("offer-time", "Предложил конкретное время", "Сам предложил 1–2 варианта даты и времени, а не «когда вам удобно?»", 2),
      it("price", "Цена и что входит", "Назвал стоимость или диапазон и что в неё входит"),
      it("booked", "Запись подтверждена", "Проговорил дату, время и адрес или специалиста", 3, true),
      it("upsell", "Предложил сопутствующую услугу", "Допродажа: дополнительная услуга, абонемент, товар"),
      it("remind", "Предупредил о напоминании", "Сказал, что напомнит, или уточнил канал для напоминания"),
      it("bye", "Вежливо попрощался", "Поблагодарил и попрощался"),
    ],
  },
  {
    id: "followup", title: "Дожим после КП", description: "Звонок после отправленного предложения",
    items: [
      it("remind", "Напомнил, кто и о чём", "Представился и напомнил о предложении", 1, true),
      it("received", "Узнал, изучили ли КП", "Спросил, получили ли и посмотрели ли предложение"),
      it("feedback", "Выяснил впечатление и вопросы", "Что понравилось, что смущает, чего не хватает", 2),
      it("process", "Выяснил, кто и как решает", "ЛПР, согласование, бюджет, сроки решения", 2),
      it("objections", "Отработал возражения", "Цена, сроки, конкуренты — ответ по существу", 2),
      it("deadline", "Узнал срок решения", "Когда клиент примет решение"),
      it("next", "Следующий шаг с датой", "Встреча, счёт, договор или звонок в конкретный день", 3, true),
      it("summary", "Резюме договорённостей", "Повторил, кто что делает и когда"),
    ],
  },
  {
    id: "repeat", title: "Повторная продажа", description: "Звонок клиенту, который уже покупал",
    items: [
      it("greet", "Приветствие по имени", "Обратился к клиенту по имени, назвал компанию", 1, true),
      it("result", "Спросил о прошлой покупке", "Узнал, как работает купленный продукт или услуга", 2),
      it("reason", "Повод звонка", "Объяснил, почему звонит именно сейчас: новинка, акция, срок обслуживания"),
      it("offer", "Предложение под клиента", "Предложил то, что подходит именно ему", 2),
      it("objections", "Отработал возражения", "Ответ по существу на сомнения", 2),
      it("next", "Следующий шаг", "Заказ, счёт, визит или звонок в конкретный день", 3, true),
      it("bye", "Вежливо попрощался", "Поблагодарил за покупку и попрощался"),
    ],
  },
];

export function getTemplate(id: string): Script {
  const s = TEMPLATES.find(x => x.id === id);
  if (!s) throw new Error(`Неизвестный шаблон скрипта: ${id}. Есть: ${TEMPLATES.map(x => x.id).join(", ")}`);
  return s;
}

const slug = (_s: string, i: number) => "p" + (i + 1);

/** Строки → пункты скрипта. Заголовки, пустые строки и строки-реплики в кавычках пропускаем. */
export function parseScript(text: string, title = "Мой скрипт"): Script {
  const items: ScriptItem[] = [];
  let stop: string[] | undefined;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    // заголовки — не пункты; первый заголовок «# …» становится названием скрипта
    if (/^#{1,6}\s/.test(line)) { if (/^#\s/.test(line) && title === "Мой скрипт" && !items.length) title = line.replace(/^#+\s*/, "").slice(0, 80); continue; }
    if (/^стоп-слова\s*:/i.test(line)) { stop = line.replace(/^стоп-слова\s*:/i, "").split(/[,;]/).map(s => s.trim()).filter(Boolean).slice(0, 50); continue; }
    for (let k = 0; k < 2; k++) line = line.replace(/^([-*•]|\d+[.)]|\[\s?[xX ]?\s?\])\s*/, "").trim();
    if (!line || /^[«"„]/.test(line) || line.length < 3) continue;
    let weight = 1, required = false;
    const opt = line.match(/\(([^()]*(вес|обязательно)[^()]*)\)\s*$/i);
    if (opt) {
      const w = opt[1].match(/вес\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i);
      if (w) weight = Math.max(0.5, Math.min(10, Number(w[1].replace(",", "."))));
      required = /обязательно/i.test(opt[1]);
      line = line.slice(0, opt.index).trim();
    }
    const [head, ...rest] = line.split(/\s+[—–-]\s+|:\s+/);
    const t = head.trim().slice(0, 120);
    if (!t) continue;
    items.push({ id: slug(t, items.length), title: t, hint: (rest.join(" — ").trim() || t).slice(0, 300), weight, ...(required ? { required } : {}) });
    if (items.length >= 40) break;
  }
  if (items.length < 2) throw new Error("В скрипте нашлось меньше двух пунктов. Каждый пункт — отдельная строка, например: «Выявил потребность — задал 2 вопроса о задаче (вес 2)»");
  return { id: "custom", title, description: "Свой скрипт", items, ...(stop ? { stopWords: stop } : {}) };
}

/** Текст из DOCX: абзацы document.xml */
async function docxText(file: string): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(readFileSync(file));
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("Это не документ Word (.docx)");
  if (xml.length > 20_000_000) throw new Error("Документ слишком большой для скрипта");
  return xml.split(/<\/w:p>/).map(p => {
    const num = /<w:numPr>/.test(p) ? "- " : "";
    return num + [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join("")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }).join("\n");
}

/** Скрипт из файла: .md, .txt, .docx, .xlsx/.csv (первая колонка — пункт, вторая — подсказка, третья — вес) */
export async function loadScript(file: string): Promise<Script> {
  const ext = extname(file).toLowerCase();
  if (ext === ".json") {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(s.items) || s.items.length < 2) throw new Error("В JSON-скрипте нет пунктов");
    return { id: String(s.id ?? "custom").slice(0, 40), title: String(s.title ?? "Мой скрипт").slice(0, 80), description: String(s.description ?? ""), items: s.items.slice(0, 40).map((x: any, i: number) => ({ id: String(x.id ?? "p" + (i + 1)).slice(0, 40), title: String(x.title).slice(0, 120), hint: String(x.hint ?? x.title).slice(0, 300), weight: Math.max(0.5, Math.min(10, Number(x.weight) || 1)), ...(x.required ? { required: true } : {}) })), ...(Array.isArray(s.stopWords) ? { stopWords: s.stopWords.map(String).slice(0, 50) } : {}) };
  }
  if (ext === ".docx") return parseScript(await docxText(file), "Мой скрипт");
  if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
    const XLSX: any = await import("xlsx");
    const wb = ext === ".csv" ? XLSX.read(readFileSync(file, "utf8"), { type: "string" }) : XLSX.read(readFileSync(file), { type: "buffer" });
    const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
    const lines = rows.filter(r => r?.[0] && !/^(пункт|этап|шаг|item)$/i.test(String(r[0]).trim()))
      .map(r => `${String(r[0]).trim()}${r[1] ? " — " + String(r[1]).trim() : ""}${r[2] ? ` (вес ${String(r[2]).trim()})` : ""}`);
    return parseScript(lines.join("\n"));
  }
  if (ext === ".md" || ext === ".txt" || ext === "") return parseScript(readFileSync(file, "utf8"));
  throw new Error("Скрипт читается из .md, .txt, .docx, .xlsx, .csv или .json");
}

export function scriptToMarkdown(s: Script): string {
  return [`# ${s.title}`, "", ...s.items.map(i => `- ${i.title} — ${i.hint} (вес ${i.weight}${i.required ? ", обязательно" : ""})`), ...(s.stopWords?.length ? ["", `Стоп-слова: ${s.stopWords.join(", ")}`] : [])].join("\n");
}
