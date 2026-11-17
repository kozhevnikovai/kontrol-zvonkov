// Языковая модель внутри Electron (как в фоновом обработчике приложения): загрузка и ответ по JSON-схеме.
// Запуск: ELECTRON_RUN_AS_NODE=1 npx electron test/electron-llm.mjs
import { createLLM, missing, selectLlm } from "../dist/index.js";
const id = process.env.ZVONKI_LLM_MODEL ?? "qwen3-4b";
selectLlm(id);
if (missing(["llm"]).length) { console.error("нет модели " + id); process.exit(2); }
console.log("electron", process.versions.electron ?? "—", "модель", id);
const t = Date.now();
const llm = await createLLM({ localModel: id, gpu: "cpu", contextSize: 4096 });
console.log("загружена за", (Date.now() - t) / 1000, "с:", llm.name);
const r = await llm.json("Отвечай по схеме.", "Клиент сказал: «Дорого, но давайте замер в четверг». Есть договорённость?", { type: "object", properties: { agreed: { type: "boolean" }, quote: { type: "string" } }, required: ["agreed", "quote"] }, 120);
console.log("ответ", JSON.stringify(r), (Date.now() - t) / 1000, "с");
await llm.dispose();
if (typeof r.agreed !== "boolean") process.exit(1);
