// Schnell-Inspektor fuer eine unbekannte XLSX-Datei: gibt die ersten Zeilen
// jedes Blatts aus, damit wir das Format erkennen koennen.

import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node inspect-xlsx.js <path-to-xlsx>');
  process.exit(1);
}

const buffer = await fs.readFile(file);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buffer);

console.log(`Datei: ${file}`);
console.log(`Anzahl Blätter: ${wb.worksheets.length}\n`);

for (const sheet of wb.worksheets) {
  console.log(`========================================`);
  console.log(`Blatt: "${sheet.name}"  (Zeilen: ${sheet.rowCount}, Spalten: ${sheet.columnCount})`);
  console.log(`========================================`);

  const maxRows = Math.min(25, sheet.rowCount);
  for (let r = 1; r <= maxRows; r++) {
    const row = sheet.getRow(r);
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      const v = cell.value;
      let display;
      if (v == null) display = '';
      else if (v instanceof Date) display = `[Date] ${v.toISOString()}`;
      else if (typeof v === 'object') display = `[Obj] ${JSON.stringify(v).slice(0, 60)}`;
      else display = String(v).slice(0, 50);
      values.push(`[${colNum}] ${display}`);
    });
    console.log(`Z${String(r).padStart(3, ' ')}: ${values.join(' | ')}`);
  }
  console.log('');
}
