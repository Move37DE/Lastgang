// Erzeugt einen synthetischen Industrie-Lastgang fuer Tests.
// Profil: Werktag-Doppelschicht 06-22 Uhr ~ 800 kW, Nacht/Wochenende ~ 100 kW,
// gezielte Lastsenkung in HLZF-Fenstern (08-11, 17-20) als "atypisches Profil".

import ExcelJS from 'exceljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', '..', 'data', 'test');
fs.mkdirSync(outDir, { recursive: true });

const JAHR = 2025;

function isSchaltjahr(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

const tageImJahr = isSchaltjahr(JAHR) ? 366 : 365;
const intervallMin = 15;
const proTag = (24 * 60) / intervallMin; // 96
const total = tageImJahr * proTag;

const rows = [['Datum/Uhrzeit', 'Wirkleistung [kW]']];

// Hilfsfn fuer pseudo-zufaelliges Rauschen (deterministisch ueber Seed)
let seed = 42;
function rand() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

for (let i = 0; i < total; i++) {
  const minutesSinceYearStart = i * intervallMin;
  const ts = new Date(Date.UTC(JAHR, 0, 1, 0, 0));
  ts.setUTCMinutes(ts.getUTCMinutes() + minutesSinceYearStart);

  const wd = ts.getUTCDay(); // 0=So, 6=Sa
  const istWerktag = wd >= 1 && wd <= 5;
  const stundeImTag = ts.getUTCHours() + ts.getUTCMinutes() / 60;
  const monat = ts.getUTCMonth() + 1;

  let leistung_kw;
  if (!istWerktag) {
    // Wochenende: Grundlast
    leistung_kw = 100 + rand() * 20;
  } else if (stundeImTag < 6 || stundeImTag >= 22) {
    // Nacht
    leistung_kw = 120 + rand() * 30;
  } else {
    // Produktionszeit
    leistung_kw = 800 + rand() * 100;

    // ATYPISCHES PROFIL: gezielte Lastreduktion in den HLZF der Netze BW MS-Ebene 2026
    // Winter (Jan/Feb/Dez): Mo-Fr 07:00-14:00 + 16:45-19:45
    // Aussen Winter: keine HLZF
    const istWinter = monat === 12 || monat === 1 || monat === 2;
    if (istWinter) {
      const istHlzfMorgen = stundeImTag >= 7 && stundeImTag < 14;
      const istHlzfAbend = stundeImTag >= 16.75 && stundeImTag < 19.75;
      if (istHlzfMorgen || istHlzfAbend) {
        // Schicht-Pause / Lastreduktion: Verbrauch nur 30-40% der Normallast
        leistung_kw = 250 + rand() * 80;
      }
    }

    // Saisonale Spitze: Winter mehr Last (Heizung)
    if (monat === 12 || monat === 1 || monat === 2) {
      leistung_kw += 100;
    }
  }

  // Jahresspitze: ein einzelner Peak Mitte Januar Nachts um 03:00 (eindeutig ausserhalb HLZF)
  if (ts.getUTCMonth() === 0 && ts.getUTCDate() === 15 && ts.getUTCHours() === 3 && ts.getUTCMinutes() === 0) {
    leistung_kw = 1450;
  }
  // Zweiter Peak im Februar Sonntag mittags (Wochenende -> keine HLZF)
  if (ts.getUTCMonth() === 1 && ts.getUTCDate() === 8 && ts.getUTCHours() === 14 && ts.getUTCMinutes() === 0) {
    leistung_kw = 1380;
  }

  // Deutsches Datumsformat fuer realistischeren Test
  const dd = String(ts.getUTCDate()).padStart(2, '0');
  const mo = String(ts.getUTCMonth() + 1).padStart(2, '0');
  const yy = ts.getUTCFullYear();
  const hh = String(ts.getUTCHours()).padStart(2, '0');
  const mi = String(ts.getUTCMinutes()).padStart(2, '0');

  rows.push([`${dd}.${mo}.${yy} ${hh}:${mi}`, Math.round(leistung_kw * 10) / 10]);
}

// XLSX schreiben
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Lastgang');
rows.forEach(r => ws.addRow(r));
ws.getColumn(1).width = 20;
ws.getColumn(2).width = 18;
const xlsxPath = path.join(outDir, `test-lastgang-${JAHR}.xlsx`);
await wb.xlsx.writeFile(xlsxPath);

// CSV alternativ
const csvPath = path.join(outDir, `test-lastgang-${JAHR}.csv`);
fs.writeFileSync(csvPath, rows.map(r => r.join(';')).join('\n'), 'utf8');

console.log(`Test-Lastgang erzeugt:`);
console.log(`  XLSX: ${xlsxPath}`);
console.log(`  CSV:  ${csvPath}`);
console.log(`  Intervalle: ${total} (${intervallMin}-Minuten-Werte)`);
console.log(`  Erwartete JHL: ~1450 kW am 15.01.${JAHR} 03:00 (ausserhalb HLZF)`);
