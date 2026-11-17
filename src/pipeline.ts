// Обработка звонков: распознавание → метрики → оценка по скрипту → архив. Модель загружается один раз на пачку.
import { createLLM, type LLM } from "./analyze/llm.js";
import { computeMetrics, DEFAULT_STOP_WORDS } from "./analyze/metrics.js";
import { reviewCall } from "./analyze/review.js";
import { getTemplate, loadScript } from "./analyze/scripts.js";
import { parseGlossary } from "./asr/glossary.js";
import { missing } from "./asr/models.js";
import { setOffline } from "./asr/net.js";
import { transcribeCall } from "./asr/transcribe.js";
import { learnVoices, listVoices, matchVoices } from "./asr/voices.js";
import { loadConfig, type Config } from "./config.js";
import { getRecord, lock, saveRecord } from "./store.js";
import type { CallMeta, CallRecord, Script } from "./types.js";
import { VERSION } from "./version.js";

export async function resolveScript(c: Config): Promise<Script> {
  if (c.scriptId === "custom" && c.scriptFile) return loadScript(c.scriptFile);
  return getTemplate(c.scriptId === "custom" ? "incoming" : c.scriptId || "incoming");
}

export interface ProgressEvent { index: number; count: number; file: string; stage: "decode" | "vad" | "voices" | "asr" | "review" | "saved" | "skipped" | "failed"; done: number; total: number; message?: string }

export interface ProcessOptions {
  config?: Config;
  script?: Script;
  /** false — только расшифровка и метрики, без модели */
  review?: boolean;
  /** Обработать заново, даже если звонок уже в архиве */
  force?: boolean;
  llm?: LLM;
  /** Модель по требованию (загрузится, только если есть что оценивать); владелец — вызывающий */
  getLlm?: () => Promise<LLM>;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
}

export interface ProcessResult { done: CallRecord[]; skipped: string[]; failed: { file: string; error: string }[]; model: string }

export async function processCalls(metas: CallMeta[], o: ProcessOptions = {}): Promise<ProcessResult> {
  const c = o.config ?? loadConfig();
  setOffline(c.offline);
  const script = o.script ?? (await resolveScript(c));
  const wantReview = o.review !== false;
  if (wantReview && !o.llm && !o.getLlm && c.llm.provider !== "openai" && !c.llm.modelFile && missing(["llm"]).length) throw new Error("Нет языковой модели для оценки. Запустите: zvonki models (или обработайте с --no-review — только расшифровка и метрики)");
  const glossary = parseGlossary(c.glossary ?? "");
  const voices = c.voices ? listVoices() : [];
  let llm = o.llm;
  const own = !o.llm && !o.getLlm;
  const res: ProcessResult = { done: [], skipped: [], failed: [], model: "" };
  try {
    for (const [index, meta] of metas.entries()) {
      if (o.signal?.aborted) break;
      const ev = (stage: ProgressEvent["stage"], done = 0, total = 0, message?: string) => o.onProgress?.({ index, count: metas.length, file: meta.file, stage, done, total, message });
      const prev = getRecord(c.archiveDir, meta.id);
      if (prev && !o.force && (prev.review || !wantReview) && prev.review?.scriptId === (wantReview ? script.id : prev.review?.scriptId)) { res.skipped.push(meta.file); ev("skipped"); continue; }
      const unlock = lock(c.archiveDir, meta.id);
      if (!unlock) { res.skipped.push(meta.file); ev("skipped", 0, 0, "обрабатывается на другом компьютере"); continue; }
      try {
        const tr = prev && !o.force ? prev.transcript : await transcribeCall(meta.file, {
          managerChannel: c.managerChannel, direction: meta.direction, glossary, voices: voices.length ? voices : undefined,
          onProgress: (stage, done, total) => ev(stage, done, total),
        });
        // менеджер по голосу, если в выгрузке его нет
        if (voices.length && tr.managerVoice && (!meta.manager || meta.manager === "Без менеджера")) {
          const hit = matchVoices({ m: tr.managerVoice }, voices).m;
          if (hit) meta.manager = hit;
        }
        if (c.voices && tr.managerVoice && tr.roles.confident && meta.manager && meta.manager !== "Без менеджера") learnVoices({ m: tr.managerVoice }, { m: meta.manager });
        const metrics = computeMetrics(tr.turns, tr.duration, script.stopWords ?? DEFAULT_STOP_WORDS);
        const rec: CallRecord = { meta, transcript: { ...tr, managerVoice: undefined }, metrics, processedAt: new Date().toISOString(), version: VERSION, ...(prev?.followUp ? { followUp: prev.followUp } : {}) };
        if (wantReview) {
          ev("review", 0, 1);
          if (tr.duration < (c.telephony.minSeconds ?? 0) || !tr.turns.length) {
            rec.review = (await import("./analyze/review.js")).emptyReview(tr, script, meta.id, "—", tr.turns.length ? `Разговор короче ${c.telephony.minSeconds} с — не оцениваем.` : "В записи нет речи: недозвон, автоответчик или тишина.");
          } else {
            llm ??= o.getLlm ? await o.getLlm() : await createLLM(c.llm);
            res.model = llm.name;
            rec.review = await reviewCall(llm, tr, script, { callId: meta.id, date: meta.date, signal: o.signal });
          }
          ev("review", 1, 1);
        } else if (prev?.review) rec.review = prev.review;
        saveRecord(c.archiveDir, rec);
        res.done.push(rec);
        ev("saved");
      } catch (e: any) {
        if (e?.name === "AbortError") break;
        res.failed.push({ file: meta.file, error: String(e?.message ?? e) });
        ev("failed", 0, 0, String(e?.message ?? e));
      } finally { unlock(); }
    }
  } finally { if (own && llm) await llm.dispose(); }
  return res;
}
