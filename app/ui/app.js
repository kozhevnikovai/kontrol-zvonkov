// Интерфейс Контроля звонков. Всё, что приходит из записей и настроек, выводится через textContent или esc().
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const kz = window.kz;
const EARLY_ACCESS = "https://github.com/kozhevnikovai/kontrol-zvonkov/issues/new?template=early-access.yml";

let st = null;          // status из обработчика
let exportFile = null;  // выгрузка телефонии для следующего разбора
let pending = null;     // { folder } или { files }
let labels = { outcomes: {}, objections: {}, interest: {} };

function toast(text, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind; t.textContent = text; t.onclick = () => t.remove();
  $("#toasts").append(t); setTimeout(() => t.remove(), kind === "err" ? 9000 : 5000);
}
async function core(m, a) { try { return await kz.core(m, a); } catch (e) { toast(String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "err"); throw e; } }

const day = d => d.toISOString().slice(0, 10);
const since = n => (Number(n) ? day(new Date(Date.now() - Number(n) * 86400_000)) : undefined);
const ruDT = iso => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}.${m}.${y.slice(2)} ${iso.slice(11, 16)}`; };
const dur = s => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `0:${String(Math.round(s)).padStart(2, "0")}`);
const tc = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const scCls = s => (s == null ? "" : s >= 75 ? "ok" : s >= 50 ? "warn" : "bad");
const score = s => `<span class="sc ${scCls(s)}">${s ?? "—"}</span>`;
const STATUS = { yes: "Да", partial: "Частично", no: "Нет", na: "—" };
const mb = b => (b >= 1e9 ? `${(b / 1073741824).toFixed(1)} ГБ` : `${Math.round(b / 1048576)} МБ`);

// ── Навигация
function show(view) {
  $$("main section").forEach(s => (s.hidden = s.id !== "v-" + view));
  $$("nav button").forEach(b => b.classList.toggle("on", b.dataset.view === view || (view === "call" && b.dataset.view === "calls")));
  ({ calls: loadCalls, managers: loadManagers, summary: loadSummary, missed: loadMissed, script: loadScript, settings: loadSettings })[view]?.();
}
$$("nav button").forEach(b => (b.onclick = () => show(b.dataset.view)));
document.addEventListener("click", e => { const g = e.target.closest("[data-go]"); if (g) show(g.dataset.go); });

// ── Статус, модели
async function refresh() {
  st = await core("status");
  $("#ver").textContent = "v" + st.version;
  const needAsr = st.missingAsr.length > 0;
  $("#gate").hidden = !needAsr;
  $("#drop").classList.toggle("off", needAsr);
  $("#fetch").hidden = !st.config.telephony?.provider;
  $("#s-tg").hidden = !st.config.secretsSet?.["crm.telegram.token"];
  renderModels("#models-setup"); renderModels("#models");
  $("#packs").innerHTML = st.packs.map(p => `<li><span>${esc(p.title)} <small>${esc(p.license)}</small></span><b>${p.missing ? mb(p.size) : "✓ есть"}</b></li>`).join("");
  net(st.net);
  return st;
}
function renderModels(sel) {
  const box = $(sel); if (!box || !st) return;
  $("#hw") && ($("#hw").textContent = `Компьютер: ОЗУ ${st.llm.hw.ramGb} ГБ, ${st.llm.hw.gpu ? `видеокарта ${st.llm.hw.gpu}, ${st.llm.hw.vramGb} ГБ` : "без видеокарты"}. ${st.llm.reason}`);
  box.innerHTML = st.llm.options.map(o => `<label class="model ${o.id === st.llm.selected ? "on" : ""} ${o.ok ? "" : "no"}"><input type="radio" name="${sel}" value="${esc(o.id)}" ${o.id === st.llm.selected ? "checked" : ""}><span><b>${esc(o.title)}</b> · ${esc(o.vendor)} · ${mb(o.size)}${o.id === st.llm.recommended ? " · рекомендуем" : ""}<small>${esc(o.note)}</small><small class="${o.ok ? "" : "err"}">${esc(o.why)}</small></span></label>`).join("");
  box.querySelectorAll("input").forEach(i => (i.onchange = async () => { st = await core("setModel", { id: i.value }); renderModels("#models-setup"); renderModels("#models"); await refresh(); if (st.missing.length) toast("Новую модель нужно скачать — вкладка «Первый запуск»"); }));
}
function net(n) { if (!n) return; const el = $("#net"); el.classList.toggle("sent", n.sentBytes > 0); el.querySelector("span").textContent = `Сеть: ${n.sentBytes ? mb(n.sentBytes) : "0 байт"} данных звонков`; el.querySelector("small").textContent = n.sentBytes ? "отправлено в подключённые сервисы" : "всё обрабатывается на этом компьютере"; }
kz.on("net", net);

async function download(packs) {
  $("#dl-box").hidden = false;
  job("Загрузка моделей", 0, "");
  try { await core("download", { packs }); toast("Модели скачаны", "ok"); } finally { $("#job").hidden = true; await refresh(); if (!st.missingAsr.length) show("calls"); }
}
$("#dl").onclick = () => download();
$("#dl-asr").onclick = () => download(["asr", "speakers"]);

function job(title, pct, sub) {
  $("#job").hidden = false; $("#job-t").textContent = title; $("#job-s").textContent = sub;
  $("#job .bar i").style.width = `${pct}%`;
}
$("#job").onclick = () => show($("#job-t").textContent.startsWith("Загрузка") ? "setup" : "calls");

const STAGE = { decode: "чтение записи", vad: "поиск речи", voices: "голоса", asr: "распознавание", review: "оценка по скрипту", saved: "готово", skipped: "уже в архиве", failed: "ошибка", fetch: "загрузка из телефонии" };
kz.on("progress", e => {
  if (e.stage === "download") {
    const pct = Math.floor((e.done / e.total) * 100);
    $("#dlbar i").style.width = pct + "%"; $("#dlbar span").textContent = pct + " %";
    $("#dl-info").textContent = `${mb(e.done)} из ${mb(e.total)} · ${e.file}`;
    return job("Загрузка моделей", pct, `${mb(e.done)} из ${mb(e.total)}`);
  }
  if (e.stage === "fetch") return job("Загрузка из телефонии", Math.floor((e.done / Math.max(1, e.total)) * 100), `${e.done} из ${e.total}`);
  const inner = e.total ? e.done / e.total : e.stage === "saved" ? 1 : 0;
  const pct = Math.floor(((e.index + inner) / e.count) * 100);
  const s = `${e.index + 1} из ${e.count} · ${e.file} · ${STAGE[e.stage] ?? e.stage}${e.message ? ": " + e.message : ""}`;
  $("#wbar i").style.width = pct + "%"; $("#wbar span").textContent = pct + " %"; $("#work-s").textContent = s;
  job("Разбор звонков", pct, s);
  if (e.stage === "saved" && !$("#v-calls").hidden) loadCalls();
});

// ── Звонки: импорт
async function preview(sel) {
  pending = sel;
  const p = await core("preview", { ...sel, exportFile });
  $("#import-box").hidden = false;
  $("#import-info").innerHTML = `Записей: <b>${p.count}</b>, новых: <b>${p.fresh}</b>${p.provider ? ` · выгрузка: ${esc(p.provider)}` : ""}<br><span class="note">Менеджеры: ${esc(p.managers.slice(0, 12).join(", ") || "—")}${p.managers.length > 12 ? "…" : ""}</span>`;
  $("#imp-review").checked = !st.missing.some(f => f.startsWith("llm/"));
}
$("#pick-dir").onclick = async () => { const d = await kz.pickDir(); if (d) preview({ folder: d }); };
$("#pick-files").onclick = async () => { const f = await kz.pickFile("audio"); if (f?.length) preview({ files: f }); };
$("#pick-export").onclick = async () => { const f = await kz.pickFile("export"); if (f) { exportFile = f; $("#export-name").textContent = f.split(/[\\/]/).pop(); if (pending) preview(pending); } };
$("#imp-cancel").onclick = () => { $("#import-box").hidden = true; pending = null; };
$("#imp-go").onclick = async () => {
  if (!pending) return;
  if ($("#imp-review").checked && st.missing.some(f => f.startsWith("llm/"))) return toast("Для оценки нужна языковая модель — скачайте её или снимите галочку", "err");
  $("#import-box").hidden = true; $("#work").hidden = false;
  try {
    const r = await core("process", { ...pending, exportFile, review: $("#imp-review").checked });
    toast(`Готово: ${r.done}, уже в архиве ${r.skipped}${r.failed.length ? `, ошибок ${r.failed.length}: ${r.failed[0].error}` : ""}${r.missed ? `. Упущенных сделок: ${r.missed}` : ""}`, r.failed.length ? "err" : "ok");
  } finally { $("#work").hidden = true; $("#job").hidden = true; pending = null; loadCalls(); }
};
$("#work-stop").onclick = () => core("stop");
$("#fetch").onclick = async () => {
  $("#work").hidden = false;
  try { const r = await core("fetch", {}); toast(`Из телефонии: скачано ${r.downloaded}, разобрано ${r.done}${r.fetchFailed ? `, не скачалось ${r.fetchFailed}` : ""}`, "ok"); }
  finally { $("#work").hidden = true; $("#job").hidden = true; loadCalls(); }
};
const drop = $("#drop");
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove("over");
  const paths = [...e.dataTransfer.files].map(f => kz.pathOf(f)).filter(Boolean);
  if (!paths.length) return;
  const audio = paths.filter(p => /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|amr|webm|wma)$/i.test(p));
  const exp = paths.find(p => /\.(csv|xlsx|xls|ods)$/i.test(p));
  if (exp) { exportFile = exp; $("#export-name").textContent = exp.split(/[\\/]/).pop(); }
  if (audio.length) preview({ files: audio }); else if (!exp) preview({ folder: paths[0] });
};

// ── Список звонков
let qTimer = null;
$("#f-q").oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadCalls, 250); };
$("#f-period").onchange = loadCalls; $("#f-mgr").onchange = loadCalls;
async function loadCalls() {
  const all = await core("list", { filter: { from: since($("#f-period").value), query: $("#f-q").value || undefined, manager: $("#f-mgr").value || undefined } });
  const mgrs = [...new Set(all.map(c => c.manager))].sort();
  const cur = $("#f-mgr").value;
  if (!cur) $("#f-mgr").innerHTML = `<option value="">Все менеджеры</option>` + mgrs.map(m => `<option>${esc(m)}</option>`).join("");
  $("#calls-empty").hidden = all.length > 0;
  $("#calls").hidden = !all.length;
  $("#calls").innerHTML = all.length ? `<tr><th>Дата</th><th>Менеджер</th><th>Клиент</th><th class="num">Длит.</th><th class="num">Балл</th><th>Итог</th><th>О чём</th></tr>` + all.map(c => `<tr data-id="${esc(c.id)}"><td class="num">${ruDT(c.date)}</td><td>${esc(c.manager)}</td><td class="num">${esc(c.client || "—")}</td><td class="num">${dur(c.duration)}</td><td class="num">${score(c.score)}</td><td>${c.outcome ? esc(labels.outcomes[c.outcome] ?? c.outcome) : '<span class="note">не оценён</span>'}${c.missed ? ' <span class="st no">упущена</span>' : ""}</td><td class="note">${esc(c.summary.slice(0, 120))}</td></tr>`).join("") : "";
  $$("#calls tr[data-id]").forEach(tr => (tr.onclick = () => openCall(tr.dataset.id)));
  updateMissedBadge();
}

// ── Карточка звонка
async function openCall(id) {
  const r = await core("get", { id });
  labels = r.labels;
  show("call");
  const v = r.review, m = r.metrics;
  $("#call").innerHTML = `
    <div class="kicker">Звонок</div>
    <h1>${esc(r.meta.manager)} · ${ruDT(r.meta.date)}</h1>
    <p class="lead small">${r.meta.direction === "in" ? "Входящий" : r.meta.direction === "out" ? "Исходящий" : ""} · клиент ${esc(r.meta.client || "—")} · ${esc(r.meta.source)}${v ? ` · ${esc(v.model)}` : ""}</p>
    <div class="row wrap"><button class="ghost" id="c-file">Открыть запись</button><button class="ghost" id="c-html">Отчёт HTML</button><button class="ghost" id="c-swap">Поменять роли</button><button class="ghost" id="c-re" ${st.missing.some(f => f.startsWith("llm/")) ? "disabled" : ""}>Оценить заново</button><button class="ghost" id="c-mgr">Изменить менеджера</button></div>
    <div class="tile-row" style="grid-template-columns:repeat(5,minmax(0,1fr))">
      <div><b>${v?.score ?? "—"}</b>Балл по скрипту</div><div><b>${dur(m.duration)}</b>Длительность</div><div><b>${m.talkRatio} %</b>Говорит менеджер</div><div><b>${m.questions}</b>Вопросов</div><div><b>${m.interruptions}</b>Перебиваний</div>
    </div>
    ${r.hints.length ? `<div class="panel"><h2>По метрикам</h2><ul>${r.hints.map(h => `<li>${esc(h)}</li>`).join("")}</ul></div>` : ""}
    ${v ? `<div class="panel"><h2>Сделка</h2>
      ${v.missed ? `<p><span class="flag">Упущенная сделка</span> ${esc(v.missedReason)}</p>` : ""}
      <p><b>Итог:</b> ${esc(labels.outcomes[v.outcome])} · <b>Интерес:</b> ${esc(labels.interest[v.interest.level])}${v.interest.quote ? ` <q>${esc(v.interest.quote)}</q>` : ""}</p>
      <p><b>Следующий шаг:</b> ${v.nextStep.agreed ? `${esc(v.nextStep.text)}${v.nextStep.due ? " · до " + esc(v.nextStep.due.split("-").reverse().join(".")) : ""} <q>${esc(v.nextStep.quote)}</q>` : "не назначен"}</p>
      <p>${esc(v.summary)}</p>
      ${v.advice.length ? `<div class="advice"><b>Советы менеджеру</b> <span class="note">(предложение модели)</span><ul>${v.advice.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}
      ${v.warnings.map(w => `<p class="warnline">${esc(w)}</p>`).join("")}
      ${v.missed ? `<div class="row"><button class="primary" id="c-crm">В CRM</button><button class="ghost" id="c-done">Перезвонили</button></div>` : ""}</div>
    <div class="two"><div class="panel"><h2>Скрипт</h2><table>${v.items.map(i => `<tr><td>${esc(i.title)}${i.quote ? `<br><span class="tc">${tc(i.t ?? 0)}</span> <q>${esc(i.quote)}</q>` : ""}${i.unverified ? '<div class="warnline">нет цитаты — проверьте</div>' : ""}</td><td><span class="st ${i.status}">${STATUS[i.status]}</span></td></tr>`).join("")}</table></div>
    <div class="panel"><h2>Возражения</h2>${v.objections.length ? v.objections.map(o => `<p><b>${esc(labels.objections[o.type])}</b> <span class="st ${o.handled === "yes" ? "yes" : o.handled === "partial" ? "partial" : "no"}">${o.handled === "yes" ? "отработал" : o.handled === "partial" ? "частично" : "не ответил"}</span><br><q>${esc(o.quote)}</q>${o.answer ? `<br>Ответ: <q>${esc(o.answer)}</q>` : ""}${o.better ? `<br><span class="note">Лучше: ${esc(o.better)}</span>` : ""}</p>`).join("") : '<p class="note">Возражений не было.</p>'}</div></div>` : `<div class="panel"><p class="note">Звонок не оценён по скрипту. Нажмите «Оценить заново», когда будет скачана языковая модель.</p></div>`}
    <div class="panel"><h2>Расшифровка</h2><div class="chat">${r.transcript.turns.map(t => `<p class="${t.role === "manager" ? "m" : "c"}"><span class="tc">${tc(t.start)}</span><span class="who">${t.role === "manager" ? "Менеджер" : "Клиент"}</span><span>${esc(t.text)}</span></p>`).join("")}</div>
    <p class="note">${r.transcript.layout === "stereo" ? "Стерео: менеджер и клиент в разных каналах." : "Моно: голоса разделены автоматически."} ${r.transcript.roles.confident ? "" : "Роли определены по порядку реплик — если перепутаны, нажмите «Поменять роли»."}</p></div>`;
  $("#c-file").onclick = () => kz.open(r.meta.file);
  $("#c-html").onclick = async () => kz.open(await core("callFile", { id }));
  $("#c-swap").onclick = async () => { toast("Меняю роли и оцениваю заново…"); await core("swap", { id }); openCall(id); };
  $("#c-re").onclick = async () => { toast("Оцениваю заново…"); await core("rereview", { id }); openCall(id); };
  $("#c-mgr").onclick = () => {
    const box = document.createElement("div"); box.className = "row";
    box.innerHTML = `<input id="c-mgr-in" value="${esc(r.meta.manager)}"><button class="primary" id="c-mgr-ok">Сохранить</button>`;
    $("#c-mgr").parentElement.after(box);
    $("#c-mgr-ok").onclick = async () => { await core("setManager", { id, manager: $("#c-mgr-in").value }); openCall(id); };
  };
  if ($("#c-crm")) $("#c-crm").onclick = async () => { const res = await core("sendDeal", { id }); toast(res.map(x => `${x.target}: ${x.ok ? "создано" : x.error}`).join(" · "), res.every(x => x.ok) ? "ok" : "err"); };
  if ($("#c-done")) $("#c-done").onclick = async () => { await core("followUp", { id, status: "done" }); toast("Отмечено: перезвонили", "ok"); };
}

// ── Менеджеры
$("#m-period").onchange = loadManagers;
async function loadManagers() {
  const { summary } = await core("summary", { from: since($("#m-period").value) });
  $("#mgr").innerHTML = "";
  $("#mgr-cards").innerHTML = summary.managers.map(m => `<div class="card mgr" data-m="${esc(m.manager)}"><h3>${esc(m.manager)} ${score(m.avgScore)}</h3><p>${m.calls} звонков · продаж ${m.sales} · упущено ${m.missed}</p><p>Слабое место: ${esc(m.weakest[0]?.title ?? "—")}</p></div>`).join("") || '<p class="note">Пока нет звонков.</p>';
  $$("#mgr-cards .mgr").forEach(c => (c.onclick = () => openManager(c.dataset.m)));
}
async function openManager(name) {
  const { stat: s, calls, labels: l } = await core("manager", { name, from: since($("#m-period").value) });
  $("#mgr").innerHTML = `<h2>${esc(s.manager)}</h2>
    <div class="tile-row" style="grid-template-columns:repeat(5,minmax(0,1fr))"><div><b>${s.avgScore ?? "—"}</b>Средний балл</div><div><b>${s.sales}</b>Продаж</div><div><b>${s.nextSteps}</b>След. шаг</div><div><b>${s.missed}</b>Упущено</div><div><b>${s.handled ?? "—"}${s.handled != null ? " %" : ""}</b>Возражений отработано</div></div>
    <div class="two"><div class="panel"><h2>Скрипт</h2>${s.items.map(i => `<div class="rate"><span>${esc(i.title)}</span><span class="bar"><i style="width:${i.rate}%"></i></span><b class="mono">${i.rate} %</b></div>`).join("") || '<p class="note">Нет оценённых звонков.</p>'}</div>
    <div class="panel"><h2>Возражения</h2>${Object.entries(s.objectionTypes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<p>${esc(l.objections[k])}: <b>${n}</b></p>`).join("") || '<p class="note">Возражений не было.</p>'}</div></div>
    <div class="row"><button class="ghost" id="m-html">Отчёт HTML</button><button class="ghost" id="m-pdf">PDF</button></div>
    <table class="list">${calls.map(c => `<tr data-id="${esc(c.id)}"><td class="num">${ruDT(c.date)}</td><td class="num">${dur(c.duration)}</td><td class="num">${score(c.score)}</td><td class="note">${esc(c.summary.slice(0, 120))}</td></tr>`).join("")}</table>`;
  $$("#mgr tr[data-id]").forEach(tr => (tr.onclick = () => openCall(tr.dataset.id)));
  const from = since($("#m-period").value) ?? "2000-01-01", to = day(new Date());
  $("#m-html").onclick = () => report(["html"], from, to, name);
  $("#m-pdf").onclick = () => report(["pdf"], from, to, name);
}

// ── Сводка
async function report(formats, from, to, manager) {
  const r = await core("reportFiles", { from, to, manager, formats });
  if (r.files[0]) kz.open(r.files[0]);
  toast("Сохранено: " + r.files.map(f => f.split(/[\\/]/).pop()).join(", "), "ok");
}
function initDates() { if (!$("#s-from").value) { $("#s-from").value = since(30); $("#s-to").value = day(new Date()); } }
$("#s-from").onchange = loadSummary; $("#s-to").onchange = loadSummary;
$("#s-html").onclick = () => report(["html"], $("#s-from").value, $("#s-to").value);
$("#s-xlsx").onclick = () => report(["xlsx"], $("#s-from").value, $("#s-to").value);
$("#s-pdf").onclick = () => report(["pdf"], $("#s-from").value, $("#s-to").value);
$("#s-tg").onclick = async () => { const r = await core("telegramSummary", { from: $("#s-from").value, to: $("#s-to").value }); toast(r.ok ? "Сводка отправлена в Telegram" : "Telegram: " + r.error, r.ok ? "ok" : "err"); };
async function loadSummary() {
  initDates();
  const { summary: p, labels: l } = await core("summary", { from: $("#s-from").value, to: $("#s-to").value });
  labels.outcomes = l.outcomes;
  $("#sum").innerHTML = `<div class="tile-row" style="grid-template-columns:repeat(5,minmax(0,1fr))"><div><b>${p.calls}</b>Звонков</div><div><b>${p.avgScore ?? "—"}</b>Средний балл</div><div><b>${p.outcomes.sale ?? 0}</b>Продаж и записей</div><div><b>${p.outcomes.next_step ?? 0}</b>Следующий шаг</div><div><b>${p.missed}</b>Упущено</div></div>
    <div class="panel"><h2>Рейтинг менеджеров</h2><table><tr><th>Менеджер</th><th class="num">Звонков</th><th class="num">Балл</th><th class="num">Продажи</th><th class="num">Упущено</th><th>Слабое место</th></tr>${p.managers.map(m => `<tr><td>${esc(m.manager)}</td><td class="num">${m.calls}</td><td class="num">${score(m.avgScore)}</td><td class="num">${m.sales}</td><td class="num">${m.missed}</td><td class="note">${esc(m.weakest[0]?.title ?? "—")}</td></tr>`).join("")}</table></div>
    <div class="two"><div class="panel"><h2>Скрипт по отделу</h2>${p.items.map(i => `<div class="rate"><span>${esc(i.title)}</span><span class="bar"><i style="width:${i.rate}%"></i></span><b class="mono">${i.rate} %</b></div>`).join("") || '<p class="note">Нет оценённых звонков.</p>'}</div>
    <div class="panel"><h2>Частые возражения</h2>${Object.entries(p.objectionTypes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<p>${esc(l.objections[k])}: <b>${n}</b></p>`).join("") || '<p class="note">Возражений не было.</p>'}</div></div>`;
}

// ── Упущенные сделки
$("#x-period").onchange = loadMissed; $("#x-open").onchange = loadMissed;
async function updateMissedBadge() {
  const all = await kz.core("list", { filter: { missed: true, from: since(30) } }).catch(() => []);
  const open = all.filter(c => !c.followUp).length;
  $("#missed-n").hidden = !open; $("#missed-n").textContent = open;
}
async function loadMissed() {
  let all = await core("list", { filter: { missed: true, from: since($("#x-period").value) } });
  if ($("#x-open").checked) all = all.filter(c => !c.followUp);
  $("#missed").innerHTML = all.length ? `<tr><th>Дата</th><th>Менеджер</th><th>Клиент</th><th>Что сказал клиент</th><th></th></tr>` + all.map(c => `<tr data-id="${esc(c.id)}"><td class="num">${ruDT(c.date)}</td><td>${esc(c.manager)}</td><td class="num">${esc(c.client || "—")}</td><td><q>${esc(c.interest)}</q><div class="note">${esc(c.summary)}</div></td><td><div class="actions">${c.followUp ? `<span class="st yes">${c.followUp.status === "crm" ? "в CRM" : "перезвонили"}</span>` : `<button class="ghost" data-a="crm">В CRM</button><button class="ghost" data-a="done">Перезвонили</button>`}</div></td></tr>`).join("") : `<tr><td class="note">Упущенных сделок нет.</td></tr>`;
  $$("#missed tr[data-id]").forEach(tr => tr.onclick = async e => {
    const a = e.target.closest("button")?.dataset.a, id = tr.dataset.id;
    if (!a) return openCall(id);
    if (a === "done") await core("followUp", { id, status: "done" });
    if (a === "crm") { const res = await core("sendDeal", { id }); toast(res.map(x => `${x.target}: ${x.ok ? "создано" : x.error}`).join(" · "), res.every(x => x.ok) ? "ok" : "err"); }
    loadMissed(); updateMissedBadge();
  });
}

// ── Скрипт
async function loadScript() {
  const cur = await core("script");
  $("#tpls").innerHTML = st.templates.map(t => `<button class="card as-link tpl ${t.id === cur.id ? "on" : ""}" data-id="${esc(t.id)}"><h3>${esc(t.title)}</h3><p>${esc(t.description)} · ${t.items.length} пунктов</p></button>`).join("") + (cur.id === "custom" ? `<div class="card tpl on"><h3>${esc(cur.title)}</h3><p>Свой скрипт · ${cur.items.length} пунктов</p></div>` : "");
  $$("#tpls [data-id]").forEach(b => (b.onclick = async () => { await core("useScript", { id: b.dataset.id }); toast("Скрипт выбран. Новые звонки оцениваются по нему; старые — кнопкой «Оценить заново»", "ok"); loadScript(); }));
  $("#sc-title").textContent = cur.title;
  $("#sc-items").innerHTML = `<tr><th>Пункт</th><th>Что считается выполнением</th><th class="num">Вес</th></tr>` + cur.items.map(i => `<tr><td>${esc(i.title)}${i.required ? ' <span class="st no">обязательно</span>' : ""}</td><td class="note">${esc(i.hint)}</td><td class="num">${i.weight}</td></tr>`).join("");
}
$("#own-script").onclick = async () => { const f = await kz.pickFile("script"); if (!f) return; const s = await core("useScript", { file: f }); toast(`Свой скрипт: ${s.items.length} пунктов`, "ok"); loadScript(); };

// ── Настройки
const CRM = [
  { id: "amocrm", title: "amoCRM", desc: "Сделка «перезвонить» с примечанием и задачей", fields: [["domain", "Домен: компания.amocrm.ru"], ["token", "Долгосрочный токен", "crm.amocrm.token"]], help: ["amoCRM → Настройки → Интеграции → Создать интеграцию (внешняя)", "Вкладка «Ключи и доступы» → «Долгосрочный токен» → скопируйте"] },
  { id: "bitrix24", title: "Битрикс24", desc: "Лид и задача «перезвонить»", fields: [["webhook", "Адрес входящего вебхука", "crm.bitrix24.webhook"]], help: ["Битрикс24 → Разработчикам → Другое → Входящий вебхук", "Права: CRM (crm), Задачи (task)"] },
  { id: "yougile", title: "YouGile", desc: "Задача «перезвонить» в колонке", fields: [["key", "Ключ API", "crm.yougile.key"], ["columnId", "ID колонки"]], help: ["YouGile → Настройки компании → API → Создать ключ", "ID колонки — в её настройках («Скопировать ID»)"] },
  { id: "telegram", title: "Telegram", desc: "Упущенные сделки и сводка руководителю", fields: [["token", "Токен бота", "crm.telegram.token"], ["chatId", "ID чата или @канал"]], help: ["Создайте бота в @BotFather и скопируйте токен", "Напишите боту /start; ID чата — у @userinfobot"] },
];
async function loadSettings() {
  await refresh();
  const c = st.config;
  $("#managers").value = Object.entries(c.managers ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n");
  $("#channel").value = String(c.managerChannel); $("#min-sec").value = c.telephony.minSeconds ?? 20;
  $("#show-phones").checked = !!c.showPhones; $("#voices").checked = !!c.voices; $("#offline").checked = !!c.offline;
  $("#glossary").value = c.glossary ?? ""; $("#archive").value = c.archiveDir; $("#outdir").value = c.outputDir;
  // телефония
  $("#t-provider").innerHTML = `<option value="">Не подключена</option>` + st.telephony.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join("");
  $("#t-provider").value = c.telephony.provider ?? ""; $("#t-every").value = c.telephony.everyMinutes ?? 0;
  renderTelFields();
  // CRM
  $("#crm").innerHTML = CRM.map(x => `<div class="card" data-crm="${x.id}"><h3>${x.title} <span class="status ${c.crm?.[x.id] && (x.fields.some(f => f[2] && c.secretsSet[f[2]])) ? "on" : ""}">${c.crm?.[x.id] ? "подключено" : "не подключено"}</span></h3><p>${x.desc}</p><details><summary>Где взять ключ</summary><ol>${x.help.map(h => `<li>${esc(h)}</li>`).join("")}</ol></details>${x.fields.map(([k, label, sec]) => `<label>${label}<input data-k="${k}" ${sec ? 'type="password"' : ""} placeholder="${sec && c.secretsSet[sec] ? "задан — оставьте пустым, чтобы не менять" : ""}" value="${sec ? "" : esc(c.crm?.[x.id]?.[k] ?? "")}"></label>`).join("")}<div class="row"><button class="primary" data-a="save">Сохранить</button><button class="ghost" data-a="check">Проверить</button><button class="link" data-a="off">Отключить</button></div></div>`).join("");
  $$("#crm [data-crm]").forEach(card => card.onclick = async e => {
    const a = e.target.closest("button")?.dataset.a; if (!a) return;
    const id = card.dataset.crm;
    if (a === "off") { await core("saveConfig", { patch: { crm: { [id]: null } } }); return loadSettings(); }
    if (a === "save") { const v = {}; card.querySelectorAll("input").forEach(i => (v[i.dataset.k] = i.value.trim())); await core("saveConfig", { patch: { crm: { [id]: v } } }); toast(`${id}: сохранено`, "ok"); return loadSettings(); }
    if (a === "check") { const r = await core("checkCrm", { target: id }); toast(r.ok ? "Подключение в порядке" : r.error, r.ok ? "ok" : "err"); }
  });
  $("#team-port").value = c.team.port; $("#team-lan").checked = !!c.team.lan;
  teamUi(st.team);
}
function renderTelFields() {
  const t = st.telephony.find(x => x.id === $("#t-provider").value);
  $("#t-help").hidden = !t; $("#t-steps").innerHTML = t ? t.help.map(h => `<li>${esc(h)}</li>`).join("") : "";
  const names = { key: "Ключ", secret: "Секрет / соль", user: "Пользователь", token: "Токен", webhook: "Адрес вебхука" };
  $("#t-fields").innerHTML = t ? t.fields.map(f => `<label>${names[f]}<input data-k="${f}" type="${f === "user" ? "text" : "password"}" placeholder="${st.config.secretsSet["telephony." + f] ? "задан — оставьте пустым, чтобы не менять" : ""}" value="${f === "user" ? esc(st.config.telephony.user ?? "") : ""}"></label>`).join("") : "";
}
$("#t-provider").onchange = renderTelFields;
$("#t-save").onclick = async () => {
  const tel = { provider: $("#t-provider").value, everyMinutes: Number($("#t-every").value) || 0 };
  $$("#t-fields input").forEach(i => (tel[i.dataset.k] = i.value.trim()));
  await core("saveConfig", { patch: { telephony: tel } });
  await kz.reschedule();
  toast("Телефония сохранена" + (st.config.offline ? ". Выключите строгий офлайн, чтобы загружать записи" : ""), "ok");
  loadSettings();
};
$("#t-check").onclick = async () => { $("#t-status").textContent = "Проверяю…"; try { const r = await core("checkTelephony"); $("#t-status").textContent = `Подключено: звонков с записью за сутки — ${r.calls}`; } catch { $("#t-status").textContent = ""; } };
$$("[data-pick]").forEach(b => (b.onclick = async () => { const d = await kz.pickDir(); if (d) $("#" + b.dataset.pick).value = d; }));
$("#save").onclick = async () => {
  const managers = {};
  for (const line of $("#managers").value.split("\n")) { const m = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/); if (m) managers[m[1]] = m[2]; }
  await core("saveConfig", { patch: { managers, managerChannel: $("#channel").value === "auto" ? "auto" : Number($("#channel").value), showPhones: $("#show-phones").checked, voices: $("#voices").checked, offline: $("#offline").checked, glossary: $("#glossary").value, archiveDir: $("#archive").value.trim(), outputDir: $("#outdir").value.trim(), telephony: { minSeconds: Number($("#min-sec").value) || 0 } } });
  $("#saved").textContent = "Сохранено"; setTimeout(() => ($("#saved").textContent = ""), 2500);
  await refresh();
};
function teamUi(t) {
  $("#team-go").hidden = !!t; $("#team-stop").hidden = !t; $("#team-copy").hidden = !t;
  $("#team-status").textContent = t ? `Кабинет работает: ${t.url}` : "Кабинет выключен";
  $("#team-copy").onclick = () => { kz.copy(t.url); toast("Ссылка скопирована. Передавайте только своим сотрудникам: в ней ключ доступа", "ok"); };
}
$("#team-go").onclick = async () => { await core("saveConfig", { patch: { team: { port: Number($("#team-port").value) || 8787, lan: $("#team-lan").checked } } }); const r = await core("teamStart"); teamUi(r); };
$("#team-stop").onclick = async () => { await core("teamStop"); teamUi(null); };
kz.on("team", m => toast(`Кабинет: принята запись, в очереди ${m.queued}`));
kz.on("fetched", m => { toast(`Из телефонии разобрано звонков: ${m.count}`, "ok"); if (!$("#v-calls").hidden) loadCalls(); });
$("#soon-want").onclick = () => kz.openUrl(EARLY_ACCESS);

// самопроверка и съёмка интерфейса в CI: обновить списки после разбора
window.__kzShow = (view, id) => (id ? openCall(id) : show(view ?? "calls"));

// ── Старт
(async () => {
  await refresh();
  const r = await core("summary", {}).catch(() => null);
  if (r) labels = { ...labels, outcomes: r.labels.outcomes, objections: r.labels.objections };
  if (st.missingAsr.length) show("setup"); else show("calls");
})();
