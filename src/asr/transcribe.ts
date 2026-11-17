// Распознавание звонка. Стерео (как пишут Манго, Билайн, UIS и др.): менеджер и клиент в разных каналах — делим по каналам,
// это точнее разделения голосов. Моно: два голоса через CAM++. Кто менеджер: знакомый голос → приветствие → порядок реплик.
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { channels as fileChannels, decode, RATE } from "./audio.js";
import { applyGlossary, type GlossaryEntry } from "./glossary.js";
import { missing, modelPath } from "./models.js";
import type { CallTranscript, Direction, Role, RoleSource, Turn } from "../types.js";
import { matchVoices, type Voice } from "./voices.js";

const require = createRequire(import.meta.url);

export interface CallTranscribeOptions {
  /** auto — стерео делим по каналам (если каналы разные), моно — по голосам */
  layout?: "auto" | "stereo" | "mono";
  /** Канал менеджера в стереозаписи: 0 — левый, 1 — правый, auto — определить */
  managerChannel?: 0 | 1 | "auto";
  direction?: Direction;
  /** Знакомые голоса менеджеров: если голос узнан — роль и имя определяются по нему */
  voices?: Voice[];
  glossary?: GlossaryEntry[];
  threads?: number;
  onProgress?: (stage: "decode" | "vad" | "voices" | "asr", done: number, total: number) => void;
}

interface Piece { start: number; end: number; core: Float32Array; samples: Float32Array; emb?: number[]; group: number; text?: string }

let sherpa: any;
const cache: Record<string, any> = {};
const lib = () => (sherpa ??= require("sherpa-onnx-node"));
const threads = (o: CallTranscribeOptions) => o.threads ?? Math.max(1, Math.min(8, availableParallelism() - 1));

function recognizer(n: number) {
  return (cache.asr ??= new (lib().OfflineRecognizer)({
    featConfig: { sampleRate: RATE, featureDim: 64 },
    modelConfig: {
      transducer: { encoder: modelPath("asr/encoder.int8.onnx"), decoder: modelPath("asr/decoder.onnx"), joiner: modelPath("asr/joiner.onnx") },
      tokens: modelPath("asr/tokens.txt"), numThreads: n, provider: "cpu", modelType: "nemo_transducer",
    },
  }));
}
function embedder(n: number) {
  return (cache.emb ??= new (lib().SpeakerEmbeddingExtractor)({ model: modelPath("speaker/campplus.onnx"), numThreads: n }));
}

/** Тихая запись — поднимаем громкость до пика ≈ 0,7 (не больше чем в 30 раз), иначе поиск речи теряет слова */
export function normalize(S: Float32Array): Float32Array {
  if (!S.length) return S;
  const step = Math.max(1, Math.floor(S.length / 200000));
  const a: number[] = [];
  for (let i = 0; i < S.length; i += step) a.push(Math.abs(S[i]));
  a.sort((x, y) => x - y);
  const p = a[Math.floor(a.length * 0.999)] || 0;
  if (p < 1e-4) return S;
  const g = Math.min(30, 0.7 / p);
  if (g <= 1.05) return S;
  const out = new Float32Array(S.length);
  for (let i = 0; i < S.length; i++) out[i] = Math.max(-1, Math.min(1, S[i] * g));
  return out;
}

/** Каналы почти одинаковые (моно, записанное как стерео) — делить по каналам нельзя */
export function sameChannels(a: Float32Array, b: Float32Array): boolean {
  const n = Math.min(a.length, b.length);
  if (!n) return true;
  const step = Math.max(1, Math.floor(n / 400000));
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i += step) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  if (aa < 1e-6 || bb < 1e-6) return aa < 1e-6 && bb < 1e-6;
  return ab / Math.sqrt(aa * bb) > 0.92;
}

function padShort(S: Float32Array): Float32Array {
  if (S.length > RATE * 3) return S;
  const pad = Math.round(RATE * 0.5);
  const out = new Float32Array(S.length + pad * 2);
  out.set(S, pad);
  return out;
}

function vadPieces(S: Float32Array, group: number): Piece[] {
  const vad = new (lib().Vad)({ sileroVad: { model: modelPath("vad/silero_vad.onnx"), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 512 }, sampleRate: RATE, numThreads: 1 }, 120);
  const out: Piece[] = [];
  const P = Math.round(RATE * 0.15);
  const drain = () => {
    while (!vad.isEmpty()) {
      const s = vad.front(false);
      const a = Math.max(0, s.start - P), b = Math.min(S.length, s.start + s.samples.length + P);
      out.push({ start: a / RATE, end: b / RATE, samples: S.slice(a, b), core: s.samples, group });
      vad.pop();
    }
  };
  for (let i = 0; i < S.length; i += 512) { vad.acceptWaveform(S.subarray(i, i + 512)); drain(); }
  vad.flush();
  drain();
  return out;
}

const dot = (a: number[], b: number[]) => a.reduce((x, y, i) => x + y * b[i], 0);
const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };

/** Два голоса из моно: агломеративная кластеризация до двух групп по фразам длиннее 1,2 с, короткие — к ближайшему */
export function twoVoices(embs: number[][], durations: number[]): number[] {
  if (embs.length < 2) return embs.map(() => 0);
  let idx = embs.map((_, i) => i).filter(i => durations[i] >= 1.2);
  if (idx.length < 2) idx = embs.map((_, i) => i);
  let C = idx.map(i => [i]);
  const sim = (a: number[], b: number[]) => { let s = 0; for (const i of a) for (const j of b) s += dot(embs[i], embs[j]); return s / (a.length * b.length); };
  while (C.length > 2) {
    let bi = 0, bj = 1, bv = -2;
    for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) { const v = sim(C[i], C[j]); if (v > bv) { bv = v; bi = i; bj = j; } }
    C[bi] = [...C[bi], ...C[bj]];
    C = C.filter((_, k) => k !== bj);
  }
  C.sort((a, b) => Math.min(...a) - Math.min(...b));
  const cen = C.map(c => unit(c.reduce((acc, i) => acc.map((x, d) => x + embs[i][d]), new Array(embs[0].length).fill(0))));
  return embs.map((e, i) => { const k = C.findIndex(c => c.includes(i)); if (k >= 0) return k; return dot(cen[0], e) >= dot(cen[1] ?? cen[0], e) ? 0 : 1; });
}

// Признаки менеджера в первых репликах: представление, название компании, предложение, вопрос об удобстве.
const MANAGER_RX = /(компани[яиюе]|меня зовут|менеджер|отдел продаж|чем (могу|можем) помочь|вас беспокоит|беспокою|звоню (вам )?(по|из|от|насчёт|насчет)|удобно (вам )?говорить|подскажите, (пожалуйста, )?как (вас|к вам)|предлага(ем|ю)|наш[аеи]? (компания|салон|магазин|клиника|сервис)|оставляли заявку|ваша заявка|слушаю вас|добрый день|доброе утро|добрый вечер|здравствуйте)/i;
const CLIENT_RX = /^(алло|ало|да[,.!]?\s*(слушаю|алло)?|слушаю)[,.!?\s]*$/i;

/** Счёт «похожести на менеджера» по первым 45 секундам текста группы */
export function managerScore(turns: { start: number; text: string }[]): number {
  let s = 0;
  for (const t of turns.filter(x => x.start < 45)) {
    const m = t.text.match(new RegExp(MANAGER_RX, "gi"));
    if (m) s += m.length;
    if (CLIENT_RX.test(t.text.trim())) s -= 1;
  }
  return s;
}

/**
 * Кто менеджер: 0 или 1 (номер группы — канал или голос).
 * Порядок: настройка → знакомый голос → приветствие → направление звонка (входящий — первым говорит менеджер,
 * исходящий — клиент отвечает «алло»).
 */
export function pickManager(groups: { start: number; text: string }[][], o: { known?: (0 | 1 | null); direction?: Direction; setting?: 0 | 1 }): { manager: 0 | 1; source: RoleSource; confident: boolean } {
  if (o.setting !== undefined) return { manager: o.setting, source: "setting", confident: true };
  if (o.known !== undefined && o.known !== null) return { manager: o.known, source: "voice", confident: true };
  const s0 = managerScore(groups[0] ?? []), s1 = managerScore(groups[1] ?? []);
  if (Math.max(s0, s1) >= 1 && Math.abs(s0 - s1) >= 1) return { manager: s0 > s1 ? 0 : 1, source: "greeting", confident: Math.abs(s0 - s1) >= 2 };
  const first = (g: { start: number }[]) => (g.length ? g[0].start : Infinity);
  const f0 = first(groups[0] ?? []), f1 = first(groups[1] ?? []);
  const firstSpeaker: 0 | 1 = f0 <= f1 ? 0 : 1;
  if (o.direction === "in") return { manager: firstSpeaker, source: "order", confident: false };
  if (o.direction === "out") return { manager: firstSpeaker === 0 ? 1 : 0, source: "order", confident: false };
  return { manager: firstSpeaker, source: "order", confident: false };
}

function embed(p: Piece, n: number): number[] {
  const ex = embedder(n);
  const st = ex.createStream();
  st.acceptWaveform({ sampleRate: RATE, samples: p.core });
  st.inputFinished();
  return unit(Array.from(ex.compute(st, false) as Float32Array));
}

function centroid(ps: Piece[]): number[] | undefined {
  const long = ps.filter(p => p.emb && p.end - p.start >= 1.2);
  const use = long.length ? long : ps.filter(p => p.emb);
  if (!use.length) return undefined;
  return unit(use.reduce((acc, p) => acc.map((x, d) => x + p.emb![d] * (p.end - p.start)), new Array(use[0].emb!.length).fill(0)));
}

export async function transcribeCall(file: string, o: CallTranscribeOptions = {}): Promise<CallTranscript> {
  const lack = missing(["asr", "speakers"]);
  if (lack.length) throw new Error(`Не хватает моделей распознавания (${lack.map(f => f.path).join(", ")}). Запустите: zvonki models`);
  const n = threads(o);
  const t0 = Date.now();
  o.onProgress?.("decode", 0, 1);
  let stereo = o.layout !== "mono" && (await fileChannels(file)) === 2;
  let L: Float32Array | null = null, R: Float32Array | null = null, M: Float32Array | null = null;
  if (stereo) {
    L = await decode(file, 0); R = await decode(file, 1);
    if (o.layout !== "stereo" && sameChannels(L, R)) { stereo = false; L = R = null; }
  }
  if (!stereo) M = normalize(await decode(file));
  else { L = normalize(L!); R = normalize(R!); }
  o.onProgress?.("decode", 1, 1);
  const duration = (M ?? L!).length / RATE;

  o.onProgress?.("vad", 0, 1);
  const pieces: Piece[] = stereo ? [...vadPieces(L!, 0), ...vadPieces(R!, 1)] : vadPieces(M!, 0);
  o.onProgress?.("vad", 1, 1);

  // отпечатки голосов: в моно — чтобы разделить двух говорящих; в стерео — только если есть знакомые голоса
  const needEmb = !stereo || !!o.voices?.length;
  if (needEmb) pieces.forEach((p, i) => { p.emb = embed(p, n); o.onProgress?.("voices", i + 1, pieces.length); });
  if (!stereo && pieces.length) {
    const g = twoVoices(pieces.map(p => p.emb!), pieces.map(p => p.end - p.start));
    pieces.forEach((p, i) => (p.group = g[i]));
  }

  const rec = recognizer(n);
  pieces.forEach((p, i) => {
    const st = rec.createStream();
    st.acceptWaveform({ sampleRate: RATE, samples: padShort(p.samples) });
    rec.decode(st);
    p.text = String(rec.getResult(st).text ?? "").trim();
    if (o.glossary?.length) p.text = applyGlossary(p.text, o.glossary);
    o.onProgress?.("asr", i + 1, pieces.length);
  });
  const kept = pieces.filter(p => p.text).sort((a, b) => a.start - b.start);

  // роли
  const cen: Record<string, number[]> = {};
  for (const g of [0, 1]) { const c = centroid(kept.filter(p => p.group === g)); if (c) cen[String(g)] = c; }
  let known: 0 | 1 | null = null;
  if (o.voices?.length) {
    const hit = matchVoices(cen, o.voices);
    const ids = Object.keys(hit);
    if (ids.length === 1) known = Number(ids[0]) as 0 | 1;
  }
  const groups = [0, 1].map(g => kept.filter(p => p.group === g).map(p => ({ start: p.start, text: p.text! })));
  const setting = stereo && (o.managerChannel === 0 || o.managerChannel === 1) ? o.managerChannel : undefined;
  const pick = pickManager(groups, { known, direction: o.direction, setting });
  const role = (g: number): Role => (g === pick.manager ? "manager" : "client");

  // склеиваем подряд идущие фразы одной стороны (пауза < 1,2 с)
  const turns: Turn[] = [];
  for (const p of kept) {
    const r = role(p.group), last = turns[turns.length - 1];
    if (last && last.role === r && p.start - last.end < 1.2 && last.end - last.start < 60) { last.end = Math.max(last.end, round(p.end)); last.text += " " + p.text; }
    else turns.push({ start: round(p.start), end: round(p.end), role: r, text: p.text! });
  }
  const asrSeconds = (Date.now() - t0) / 1000;
  return {
    file: basename(file), duration: round(duration), layout: stereo ? "stereo" : "mono", turns,
    roles: { source: pick.source, managerChannel: stereo ? pick.manager : undefined, confident: pick.confident },
    managerVoice: cen[String(pick.manager)],
    stats: { asrSeconds: round(asrSeconds), rtf: round(asrSeconds / Math.max(duration, 1), 3), device: `CPU, ${n} потоков` },
  };
}

/** Поменять роли местами (если программа ошиблась, кто менеджер) */
export function swapRoles(t: CallTranscript): CallTranscript {
  return { ...t, turns: t.turns.map(x => ({ ...x, role: x.role === "manager" ? "client" : "manager" })), roles: { ...t.roles, source: "setting", confident: true, managerChannel: t.roles.managerChannel === undefined ? undefined : (1 - t.roles.managerChannel) as 0 | 1 }, managerVoice: undefined };
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export const roleLabel = (r: Role) => (r === "manager" ? "Менеджер" : "Клиент");

/** Текст звонка для модели и чтения: [мм:сс] Менеджер: реплика */
export function callText(t: { turns: Turn[] }): string {
  return t.turns.map(x => `[${fmtTime(x.start)}] ${roleLabel(x.role)}: ${x.text}`).join("\n");
}
