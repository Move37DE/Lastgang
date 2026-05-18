// Parst RLM-Lastgangdateien (XLSX, XLSM, CSV) in ein normalisiertes Format:
//   { intervalle: [{ts: Date, leistung_kw: number, interpoliert?: bool, fehlt?: bool}, ...],
//     intervall_minuten: 15 | 30,
//     quelle: { datei, blattname, spaltenmapping },
//     qualitaet: { ... } }
//
// Realitaet: VNB liefern Lastgaenge in vielen Varianten. Wir nutzen Heuristiken
// fuer Spaltenerkennung (Zeitstempel, Leistung) und Format (kW vs. kWh/Intervall).

import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';

const ZEITSTEMPEL_KANDIDATEN = [
  'datum', 'zeit', 'datum/uhrzeit', 'datum / uhrzeit', 'zeitstempel',
  'timestamp', 'date', 'datetime', 'date/time', 'beginn', 'startzeit',
];

const LEISTUNG_KANDIDATEN = [
  'leistung', 'wirkleistung', 'p', 'lastgang', 'verbrauch',
  'wirkenergie', 'energie', 'kw', 'kwh',
];

const NUMERISCH_RE = /^-?\d+([,.]\d+)?$/;

function normalizeHeader(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '').trim();
}

function parseGermanNumber(s) {
  if (typeof s === 'number') return s;
  if (s == null) return null;
  const str = String(s).trim().replace(/\s/g, '');
  if (!str) return null;
  // Deutsch: "1.234,56" -> "1234.56"; Englisch: "1,234.56" -> "1234.56"
  // Heuristik: wenn ',' nach letztem '.' kommt, ist es deutsch.
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');
  let normalized;
  if (lastComma > lastDot) {
    normalized = str.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = str.replace(/,/g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    // Excel-Datum (Seriennummer, Tage seit 1900-01-00, MS-Bug beruecksichtigen)
    // ExcelJS gibt normalerweise schon Date-Objekte zurueck — Fallback hier.
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return new Date(ms);
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();

  // ISO: 2026-01-15T13:30:00 oder 2026-01-15 13:30
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (isoMatch) {
    const [, y, mo, d, h, mi] = isoMatch;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  }

  // Deutsch: DD.MM.YYYY HH:MM oder DD.MM.YYYY HH:MM:SS
  const deMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (deMatch) {
    const [, d, mo, y, h, mi] = deMatch;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  }

  // Nur Datum (DD.MM.YYYY) — selten, dann 00:00
  const dateOnly = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dateOnly) {
    const [, d, mo, y] = dateOnly;
    return new Date(Date.UTC(+y, +mo - 1, +d, 0, 0));
  }

  // Fallback: nativ versuchen
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Liest die ersten N Zeilen einer Excel-Datei als 2D-Array (workbook + erstes
// nicht-leeres Blatt).
async function readXlsxRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  for (const sheet of workbook.worksheets) {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values;
      // ExcelJS Array ist 1-indexed (Index 0 = leer)
      rows.push(values.slice(1));
    });
    if (rows.length >= 10) {
      return { rows, sheetName: sheet.name };
    }
  }
  return { rows: [], sheetName: null };
}

function readCsvRows(text) {
  // Sehr einfacher CSV-Parser: erkennt , oder ; als Delimiter.
  const sample = text.slice(0, 4000);
  const semiCount = (sample.match(/;/g) || []).length;
  const commaCount = (sample.match(/,/g) || []).length;
  const delim = semiCount > commaCount ? ';' : ',';

  return text.split(/\r?\n/).filter(l => l.length > 0).map(line => {
    // Naiv: kein Quoting-Support. Fuer Lastgang-CSVs reicht das in 95% der Faelle.
    return line.split(delim).map(c => c.trim());
  });
}

// Findet die Header-Zeile + Spaltenindizes fuer Zeitstempel und Leistung.
function detectColumns(rows) {
  // Suche bis Zeile 20 — manche VNB schreiben Metadaten oben drueber.
  const maxHeaderRow = Math.min(20, rows.length);

  for (let r = 0; r < maxHeaderRow; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;

    const headers = row.map(normalizeHeader);
    let tsCol = -1;
    let leistCol = -1;

    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      if (tsCol < 0 && ZEITSTEMPEL_KANDIDATEN.some(k => h.includes(normalizeHeader(k)))) {
        tsCol = c;
      }
      if (leistCol < 0 && LEISTUNG_KANDIDATEN.some(k => h.includes(normalizeHeader(k)))) {
        leistCol = c;
      }
    }

    if (tsCol >= 0 && leistCol >= 0 && tsCol !== leistCol) {
      return { headerRow: r, tsCol, leistCol, originalHeaders: row.map(h => String(h ?? '')) };
    }
  }

  // Fallback: erste Spalte Zeitstempel, zweite Spalte Leistung.
  // Validiere mit ein paar Datenzeilen.
  for (let r = 0; r < maxHeaderRow; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const ts = parseTimestamp(row[0]);
    const wert = parseGermanNumber(row[1]);
    if (ts && wert != null) {
      return { headerRow: r - 1 >= 0 ? r - 1 : 0, tsCol: 0, leistCol: 1, originalHeaders: ['Spalte A', 'Spalte B'] };
    }
  }

  throw new Error('Konnte Spalten fuer Zeitstempel und Leistung nicht erkennen.');
}

// Hauptfunktion: parst eine Lastgang-Datei aus einem Buffer.
//   filename: Originaldateiname (fuer Endungserkennung)
//   buffer: Buffer der Datei
//   einheitHint: optional 'kW' | 'kWh/15min' | 'kWh/30min' | 'auto'
//   intervallHint: optional 15 | 30 | null (auto)
export async function parseLastgang(filename, buffer, options = {}) {
  const isCsv = /\.csv$/i.test(filename);

  let rows;
  let sheetName = null;
  if (isCsv) {
    rows = readCsvRows(buffer.toString('utf8'));
  } else {
    const xl = await readXlsxRows(buffer);
    rows = xl.rows;
    sheetName = xl.sheetName;
  }

  if (!rows || rows.length < 100) {
    throw new Error(`Datei enthaelt zu wenige Zeilen (${rows?.length ?? 0}) — Lastgang braucht 17.520 oder 35.040 Werte/Jahr.`);
  }

  const cols = detectColumns(rows);

  // Datenzeilen einlesen
  const intervalle = [];
  for (let r = cols.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[cols.tsCol]) continue;
    const ts = parseTimestamp(row[cols.tsCol]);
    const wert = parseGermanNumber(row[cols.leistCol]);
    if (!ts) continue;
    intervalle.push({ ts, wert_raw: wert });
  }

  if (intervalle.length < 100) {
    throw new Error(`Nach dem Parsen nur ${intervalle.length} gueltige Zeilen — Format-Erkennung fehlgeschlagen?`);
  }

  // Intervall ermitteln (15 oder 30 Min)
  let intervallMinuten = options.intervallHint;
  if (!intervallMinuten) {
    const deltas = [];
    for (let i = 1; i < Math.min(50, intervalle.length); i++) {
      const dt = (intervalle[i].ts - intervalle[i - 1].ts) / 60000;
      if (dt > 0) deltas.push(dt);
    }
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    intervallMinuten = median <= 20 ? 15 : 30;
  }

  // Einheit ermitteln: ist Spalte in kW oder kWh/Intervall?
  // Heuristik: wenn Header "kWh" enthaelt -> Energie -> umrechnen
  let einheit = options.einheitHint || 'auto';
  if (einheit === 'auto') {
    const headerText = cols.originalHeaders[cols.leistCol]?.toLowerCase() || '';
    if (headerText.includes('kwh')) {
      einheit = intervallMinuten === 15 ? 'kWh/15min' : 'kWh/30min';
    } else {
      einheit = 'kW';
    }
  }

  // Konvertierung in kW
  const faktor = einheit === 'kWh/15min' ? 4
              : einheit === 'kWh/30min' ? 2
              : 1;

  // Datenqualitaet bewerten + finale Liste bauen
  let fehlende = 0;
  let negative = 0;
  const final = [];
  for (const iv of intervalle) {
    const leistung_kw = iv.wert_raw == null ? null : iv.wert_raw * faktor;
    if (leistung_kw == null) fehlende++;
    if (leistung_kw != null && leistung_kw < 0) negative++;
    final.push({
      ts: iv.ts,
      leistung_kw,
      fehlt: leistung_kw == null,
    });
  }

  // Erwartete Anzahl je nach Intervall und Jahr
  const erstes = final[0]?.ts;
  const letztes = final[final.length - 1]?.ts;
  const jahr = erstes?.getUTCFullYear();
  const istSchaltjahr = jahr && (jahr % 4 === 0 && (jahr % 100 !== 0 || jahr % 400 === 0));
  const stundenErwartet = istSchaltjahr ? 8784 : 8760;
  const erwartet = intervallMinuten === 15 ? stundenErwartet * 4 : stundenErwartet * 2;

  return {
    intervalle: final,
    intervall_minuten: intervallMinuten,
    einheit_quelle: einheit,
    quelle: {
      datei: filename,
      blattname: sheetName,
      header_row: cols.headerRow,
      ts_spalte: cols.originalHeaders[cols.tsCol],
      leistung_spalte: cols.originalHeaders[cols.leistCol],
    },
    zeitraum: {
      von: erstes,
      bis: letztes,
      jahr,
      schaltjahr: istSchaltjahr,
    },
    qualitaet: {
      anzahl: final.length,
      erwartet,
      vollstaendigkeit_prozent: Math.round((final.length / erwartet) * 1000) / 10,
      fehlende_werte: fehlende,
      negative_werte: negative,
    },
  };
}
