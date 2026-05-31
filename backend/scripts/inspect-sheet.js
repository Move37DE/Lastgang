// Inspiziert ein bestimmtes Blatt einer XLSX:
// listet alle Blaetter und gibt fuer ein gewaehltes Blatt Zellen + Formeln aus.

import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';

const file = process.argv[2];
const sheetWunsch = process.argv[3];

if (!file) {
  console.error('Usage: node inspect-sheet.js <xlsx> [sheet-name]');
  process.exit(1);
}

const buffer = await fs.readFile(file);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buffer);

console.log('=== Alle Blaetter ===');
for (const s of wb.worksheets) {
  console.log(`  - "${s.name}"  (Zeilen: ${s.rowCount}, Spalten: ${s.columnCount})`);
}
console.log('');

let target = null;
if (sheetWunsch) {
  target = wb.getWorksheet(sheetWunsch);
  if (!target) {
    // Fuzzy: case-insensitive Substring-Match
    for (const s of wb.worksheets) {
      if (s.name.toLowerCase().includes(sheetWunsch.toLowerCase())) {
        target = s;
        break;
      }
    }
  }
}

if (!target) {
  console.log('Kein Blatt angegeben oder gefunden. Beende.');
  process.exit(0);
}

console.log(`=== Inhalt Blatt: "${target.name}" ===\n`);

// Alle benannten Bereiche / Defined Names im Workbook
if (wb.definedNames) {
  console.log('Definierte Namen im Workbook:');
  for (const n of wb.definedNames.model || []) {
    console.log(`  ${n.name} = ${n.ranges?.join(' | ') || ''}`);
  }
  console.log('');
}

// Zellen auflisten — Wert + Formel + (ggf.) Ergebniscache
target.eachRow({ includeEmpty: false }, (row, rowNum) => {
  row.eachCell({ includeEmpty: false }, (cell, colNum) => {
    let display;
    const v = cell.value;
    if (v == null || v === '') return;
    if (typeof v === 'object' && v.formula) {
      const result = v.result;
      display = `=${v.formula}    →  ${result == null ? '(noch nicht berechnet)' : JSON.stringify(result).slice(0,80)}`;
    } else if (v instanceof Date) {
      display = `[Date] ${v.toISOString()}`;
    } else if (typeof v === 'object' && v.richText) {
      display = '[RichText] ' + v.richText.map(r => r.text).join('').slice(0, 100);
    } else if (typeof v === 'object') {
      display = '[Obj] ' + JSON.stringify(v).slice(0, 100);
    } else {
      display = String(v).slice(0, 100);
    }
    console.log(`  ${cell.address}: ${display}`);
  });
});
