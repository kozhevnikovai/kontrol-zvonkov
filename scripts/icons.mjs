// Иконка приложения в семействе иконок kozhevnikovai (бренд-кит «Кисть»): скруглённый квадрат цвета программы,
// белая пиктограмма — телефонная трубка с галочкой. Цвет Контроля звонков — #B8325F.
// node scripts/icons.mjs — рисует SVG через Chrome и собирает icon.png, icon.ico, icon.icns, docs/img/icon.png.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="1024" height="1024">
<rect x="0" y="0" width="512" height="512" rx="119" fill="#B8325F"/>
<path transform="translate(70 150) scale(0.78)" fill="#fff" d="M84 18c20-10 42-2 52 18l30 62c9 19 3 41-14 52l-24 15c18 44 52 78 96 96l15-24c11-17 33-23 52-14l62 30c20 10 28 32 18 52-18 38-60 60-102 51C134 336 48 250 26 115 18 74 44 34 84 18z"/>
<circle cx="350" cy="168" r="78" fill="#fff"/>
<path d="M312 170l26 26 52-56" fill="none" stroke="#B8325F" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
const png = {};
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${s}" height="${s}"`)}</body>`);
  png[s] = await page.screenshot({ omitBackground: true });
}
await browser.close();

// ICO: PNG внутри (Windows Vista+)
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const head = Buffer.alloc(6 + 16 * icoSizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(icoSizes.length, 4);
let off = head.length;
icoSizes.forEach((s, i) => { const b = png[s], o = 6 + i * 16; head[o] = s >= 256 ? 0 : s; head[o + 1] = s >= 256 ? 0 : s; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(b.length, o + 8); head.writeUInt32LE(off, o + 12); off += b.length; });
const ico = Buffer.concat([head, ...icoSizes.map(s => png[s])]);
// ICNS: PNG-записи ic07 (128), ic08 (256), ic09 (512), ic10 (1024)
const ent = [["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]].map(([t, s]) => { const h = Buffer.alloc(8); h.write(t, 0, "ascii"); h.writeUInt32BE(png[s].length + 8, 4); return Buffer.concat([h, png[s]]); });
const ih = Buffer.alloc(8); ih.write("icns", 0, "ascii"); ih.writeUInt32BE(8 + ent.reduce((a, b) => a + b.length, 0), 4);
mkdirSync("app/assets", { recursive: true }); mkdirSync("docs/img", { recursive: true });
writeFileSync("app/assets/icon.png", png[512]); writeFileSync("app/ui/icon.png", png[128]); writeFileSync("docs/img/icon.png", png[512]);
writeFileSync("app/assets/icon.ico", ico); writeFileSync("app/assets/icon.icns", Buffer.concat([ih, ...ent]));
writeFileSync("docs/img/icon.svg", svg);
console.log("ok");
