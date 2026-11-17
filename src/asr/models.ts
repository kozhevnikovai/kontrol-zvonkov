// Локальные модели: распознавание GigaAM v3, поиск речи Silero VAD, голоса CAM++ и языковая модель из local-ai.
// Если на компьютере уже стоит Протоколист, его модели используются повторно — второй раз 2,7–9 ГБ не качаем.
import { existsSync, statSync } from "node:fs";
import { appHome, DEFAULTS, downloadFiles, getModel, MODELS, checkSpace, totalSize as engineTotal, type ModelFile } from "@kozhevnikovai/local-ai";
import { join } from "node:path";
import { netFetch } from "./net.js";

export function homeDir(): string {
  return process.env.ZVONKI_HOME || appHome("KontrolZvonkov");
}
/** На Windows распознавание и llama.cpp не открывают пути не на латинице — тогда общая папка ProgramData */
export function modelsDir(): string {
  if (process.env.ZVONKI_MODELS) return process.env.ZVONKI_MODELS;
  const own = join(homeDir(), "models");
  if (process.platform === "win32" && /[^\x00-\x7F]/.test(own)) return join(process.env.ProgramData || "C:\\ProgramData", "KontrolZvonkov", "models");
  return own;
}
/** Папки моделей Протоколиста (те же файлы распознавания и языковой модели) */
function sharedDirs(): string[] {
  if (process.env.ZVONKI_MODELS) return [];
  const pk = process.env.PROTOKOLIST_HOME || appHome("Protokolist");
  const dirs = [join(pk, "models")];
  if (process.platform === "win32") dirs.push(join(process.env.ProgramData || "C:\\ProgramData", "Protokolist", "models"));
  return dirs;
}

const HF = "https://huggingface.co";
const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const ASR = "csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16";

export type { ModelFile };
export interface ModelPack { id: string; title: string; license: string; files: ModelFile[] }

function llmPack(id: string): ModelPack {
  const m = getModel(id);
  return { id: "llm", title: `Языковая модель для оценки звонков: ${m.title} (${m.vendor})`, license: m.license, files: [m.file] };
}
export const LLM_MODELS = MODELS;
export function selectLlm(id?: string): string {
  const ok = id && MODELS.some(m => m.id === id) ? id : DEFAULTS.strong;
  PACKS.llm = llmPack(ok);
  return ok;
}

export const PACKS: Record<string, ModelPack> = {
  asr: {
    id: "asr", title: "Распознавание речи GigaAM v3 (Сбер), с пунктуацией", license: "MIT",
    files: [
      { path: "asr/encoder.int8.onnx", url: `${HF}/${ASR}/resolve/main/encoder.int8.onnx`, size: 224570820, sha256: "369f35a71bf288d3b8e0391fabd8dba5f2314088d440bca474056b7b4b6e66bf" },
      { path: "asr/decoder.onnx", url: `${HF}/${ASR}/resolve/main/decoder.onnx`, size: 4600132, sha256: "38fc7475443ea2a26f63211ca350f73ac50fff824ab7a3876ee2bd610c53bbc4" },
      { path: "asr/joiner.onnx", url: `${HF}/${ASR}/resolve/main/joiner.onnx`, size: 2712896, sha256: "602ff7017a93311aad34df1437c8d7f49911353c13d6eae7a6ee7b041339465c" },
      { path: "asr/tokens.txt", url: `${HF}/${ASR}/resolve/main/tokens.txt`, size: 13354, sha256: "39abae20e692998290c574e606f11a9edef2902a1995463fcff63d1490cf22b7" },
    ],
  },
  speakers: {
    id: "speakers", title: "Поиск речи и голоса: Silero VAD + CAM++ (3D-Speaker)", license: "MIT / Apache-2.0",
    files: [
      { path: "vad/silero_vad.onnx", url: `${GH}/asr-models/silero_vad.onnx`, size: 643854, sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" },
      { path: "speaker/campplus.onnx", url: `${HF}/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`, size: 28281164, sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2" },
    ],
  },
  llm: llmPack(DEFAULTS.strong),
};

const ok = (p: string, f: ModelFile) => existsSync(p) && (f.size <= 0 || statSync(p).size === f.size);
const fileOf = (rel: string) => Object.values(PACKS).flatMap(p => p.files).find(f => f.path === rel);

/** Путь к файлу модели: своя папка, иначе папка Протоколиста, если там есть целый файл */
export function modelPath(rel: string): string {
  const own = join(modelsDir(), rel);
  const f = fileOf(rel);
  if (!f || ok(own, f)) return own;
  for (const d of sharedDirs()) { const p = join(d, rel); if (ok(p, f)) return p; }
  return own;
}

export function missing(packs = Object.keys(PACKS)): ModelFile[] {
  return packs.flatMap(id => PACKS[id].files).filter(f => !ok(modelPath(f.path), f));
}

export function plan(packs = Object.keys(PACKS)) {
  return packs.map(id => ({ id, title: PACKS[id].title, license: PACKS[id].license, size: PACKS[id].files.reduce((a, f) => a + f.size, 0), missing: missing([id]).length > 0 }));
}
export const totalSize = (files: ModelFile[]) => engineTotal(files);
export type Progress = (e: { file: string; done: number; total: number; fileDone: number; fileTotal: number; index: number; count: number }) => void;
export { checkSpace };

/** Скачивает недостающие модели с докачкой и проверкой SHA-256 — один раз */
export async function download(packs = Object.keys(PACKS), onProgress?: Progress): Promise<void> {
  const need = new Set(missing(packs).map(f => f.path));
  const files = packs.flatMap(id => PACKS[id].files).filter(f => need.has(f.path));
  if (!files.length) return;
  await downloadFiles(files, { dir: modelsDir(), onProgress, fetch: (url, init) => netFetch("model-download", url, init) });
}
