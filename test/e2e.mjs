// Сквозная проверка распознавания звонков на настоящей речи (CI, без языковой модели).
// 1) «Звонок» в телефонном качестве (8 кГц, G.711 μ-law, стерео) из Russian LibriSpeech (общественное достояние):
//    диктор 1 — левый канал, диктор 2 — правый. Есть точный текст → WER и чистота каналов.
// 2) Та же запись в моно → разделение двух голосов CAM++.
// 3) Настоящие телефонные разговоры DataHive (CC BY 4.0, стерео): доля речи сторон и темп смены реплик
//    сравниваются с разметкой набора.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMetrics, decode, download, transcribeCall } from "../dist/index.js";
import { ffmpegPath } from "../dist/asr/audio.js";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const gt = JSON.parse(readFileSync(join(here, "audio/meeting-3-speakers.json"), "utf8")).filter(g => g.spk < 2);
await download(["asr", "speakers"]);
const fails = [];
const out = process.env.ZVONKI_E2E_OUT ?? join(tmpdir(), "kz-e2e");
mkdirSync(out, { recursive: true });

// ── 1. Стереозвонок 8 кГц μ-law
const pcm = await decode(join(here, "audio/meeting-3-speakers.ogg"));
const R = 16000, n = Math.round((gt.at(-1).end + 1) * R);
const L = new Float32Array(n), Rr = new Float32Array(n);
for (const g of gt) { const a = Math.round(g.start * R), b = Math.min(pcm.length, Math.round(g.end * R)); (g.spk === 0 ? L : Rr).set(pcm.subarray(a, b), a); }
const inter = new Float32Array(n * 2);
for (let i = 0; i < n; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = Rr[i]; }
const raw = join(out, "call.f32");
writeFileSync(raw, Buffer.from(inter.buffer));
const ff = (args) => { const r = spawnSync(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", ...args]); if (r.status) throw new Error(String(r.stderr)); };
const stereo = join(out, "call-stereo-8k.wav"), mono = join(out, "call-mono-8k.wav");
ff(["-f", "f32le", "-ar", "16000", "-ac", "2", "-i", raw, "-ar", "8000", "-c:a", "pcm_mulaw", stereo]);
ff(["-i", stereo, "-ac", "1", "-c:a", "pcm_mulaw", mono]);

const norm = s => s.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
const ed = (a, b) => { let d = [...Array(b.length + 1).keys()]; for (let i = 1; i <= a.length; i++) { let p = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } } return d[b.length]; };
const ref = norm(gt.map(g => g.text).join(" "));
const ov = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
/** Доля времени реплик, где роль совпадает с диктором (с учётом того, что роли могут быть переставлены целиком) */
function roleAcc(turns) {
  let same = 0, swap = 0, all = 0;
  for (const t of turns) for (const g of gt) { const o = ov(t, g); all += o; if ((t.role === "manager") === (g.spk === 0)) same += o; else swap += o; }
  return { acc: (Math.max(same, swap) / Math.max(all, 1e-9)) * 100, swapped: swap > same };
}
const res = {};
for (const [name, file] of [["stereo", stereo], ["mono", mono]]) {
  const t = await transcribeCall(file, { direction: "unknown" });
  const hyp = norm(t.turns.map(x => x.text).join(" "));
  const wer = (ed(ref, hyp) / ref.length) * 100;
  const ra = roleAcc(t.turns);
  res[name] = { layout: t.layout, wer: +wer.toFixed(1), roleAccuracy: +ra.acc.toFixed(1), turns: t.turns.length, rtf: t.stats.rtf };
  if (t.layout !== name) fails.push(`${name}: определено как ${t.layout}`);
  if (wer > 15) fails.push(`${name}: WER ${wer.toFixed(1)} % > 15 %`);
  if (ra.acc < (name === "stereo" ? 98 : 85)) fails.push(`${name}: разделение сторон ${ra.acc.toFixed(1)} %`);
}
console.log(JSON.stringify({ librispeechPhoneCall: res }));

// ── 3. Настоящие телефонные разговоры DataHive (CC BY 4.0)
const DH = "https://huggingface.co/datasets/datahiveai/russian-conversations-sample/resolve/main/preview";
const cache = process.env.ZVONKI_DATA ?? join(tmpdir(), "kz-datahive");
mkdirSync(cache, { recursive: true });
const metaFile = join(cache, "metadata.jsonl");
if (!existsSync(metaFile)) writeFileSync(metaFile, await (await fetch(`${DH}/metadata.jsonl`)).text());
const meta = readFileSync(metaFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const pick = meta.filter(m => m.duration_seconds < 260).slice(0, Number(process.env.ZVONKI_E2E_CALLS ?? 4));
const rows = [];
for (const m of pick) {
  const f = join(cache, m.file_name);
  if (!existsSync(f)) writeFileSync(f, Buffer.from(await (await fetch(`${DH}/${m.file_name}`)).arrayBuffer()));
  const t = await transcribeCall(f, {});
  const mt = computeMetrics(t.turns, t.duration);
  // speech_balance_percent в наборе — доля речи того, кто говорит меньше
  const ours = Math.min(mt.talkRatio, 100 - mt.talkRatio);
  rows.push({ file: m.file_name, layout: t.layout, balance: ours, balanceRef: m.speech_balance_percent, turnsPerMin: mt.turnsPerMinute, turnsPerMinRef: m.turns_per_minute, rtf: t.stats.rtf });
}
const balErr = rows.reduce((a, r) => a + Math.abs(r.balance - r.balanceRef), 0) / Math.max(1, rows.length);
console.log(JSON.stringify({ datahive: rows, balanceMeanAbsError: +balErr.toFixed(1) }));
if (rows.some(r => r.layout !== "stereo")) fails.push("DataHive: стереозапись не распознана как стерео");
if (balErr > 10) fails.push(`DataHive: доля речи расходится с разметкой в среднем на ${balErr.toFixed(1)} п. п. > 10`);
writeFileSync(join(out, "e2e.json"), JSON.stringify({ librispeechPhoneCall: res, datahive: rows, balanceMeanAbsError: balErr }, null, 2));
if (fails.length) { console.error("Провал: " + fails.join("; ")); process.exit(1); }
