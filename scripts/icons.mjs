// Иконка приложения в стиле «Чертёж»: два канала звонка (менеджер / клиент) → карточка оценки.
// node scripts/icons.mjs — рисует SVG через Chrome и собирает icon.png, icon.ico, icon.icns, docs/img/icon.png.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const ax = `stroke="#9C9C9C" stroke-width="3" stroke-dasharray="26 6 3 6"`;
const up = [30, 62, 44, 96, 58, 30], dn = [22, 40, 70, 34, 52, 26];
const bars = (hs, dir) => hs.map((h, i) => `<rect x="${86 + i * 26}" y="${dir < 0 ? 262 - h : 278}" width="13" height="${h}" fill="${dir < 0 ? "#161616" : "#5C5C5C"}"/>`).join("");
const row = (y, ok) => `<rect x="316" y="${y}" width="26" height="26" fill="none" stroke="#161616" stroke-width="6"/>${ok ? `<path d="M321 ${y + 13} L328 ${y + 20} L338 ${y + 6}" fill="none" stroke="#161616" stroke-width="5"/>` : `<path d="M322 ${y + 6} L336 ${y + 20} M336 ${y + 6} L322 ${y + 20}" stroke="#161616" stroke-width="5"/>`}<rect x="354" y="${y + 9}" width="${ok ? 64 : 44}" height="9" fill="#161616"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="1024" height="1024">
<rect x="0" y="0" width="512" height="512" fill="#fff"/><rect x="24" y="24" width="464" height="464" fill="none" stroke="#161616" stroke-width="12"/>
<line x1="70" y1="270" x2="440" y2="270" ${ax}/>${bars(up, -1)}${bars(dn, 1)}
<path d="M250 270 H272 M262 258 L276 270 L262 282" fill="none" stroke="#161616" stroke-width="9"/>
<rect x="296" y="166" width="144" height="208" fill="#fff" stroke="#161616" stroke-width="12"/>
${row(196, true)}${row(244, true)}${row(292, false)}
<rect x="316" y="338" width="104" height="10" fill="#161616"/>
<circle cx="440" cy="166" r="20" fill="#fff" stroke="#FF5A1F" stroke-width="6"/><circle cx="440" cy="166" r="11" fill="#FF5A1F"/></svg>`;

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
const png = {};
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<body style="margin:0">${svg.replace('width="1024" height="1024"', `width="${s}" height="${s}"`)}</body>`);
  png[s] = await page.screenshot({ omitBackground: false });
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
