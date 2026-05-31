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

// Kombinierte Zeitstempel-Spalten ("Datum/Uhrzeit" in einer Zelle)
const ZEITSTEMPEL_KOMBI_KANDIDATEN = [
  'datumuhrzeit', 'datumzeit', 'zeitstempel', 'timestamp', 'datetime',
  'datetime', 'beginn', 'startzeit', 'startdatum',
];

// Nur-Datum-Spalte (kann mit Zeit-Spalte kombiniert werden)
const DATUM_KANDIDATEN = ['datum', 'date', 'tag'];

// Nur-Uhrzeit-Spalte
const ZEIT_KANDIDATEN = ['uhrzeit', 'zeit', 'time', 'tageszeit'];

const LEISTUNG_KANDIDATEN = [
  'leistung', 'wirkleistung', 'lastgang', 'verbrauch',
  'wirkenergie', 'wirkverbrauch', 'energie',
  'wert', 'messwert', 'value',
  'kw', 'kwh', ' p ', '[p]',
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
  if (!s) return null;

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
// Unterstuetzt drei Layouts:
//   A) "Datum/Uhrzeit" + "Leistung"          -> tsCol, leistCol
//   B) "Datum" + "Zeit" + "Wert"             -> tsCol, tsCol2, leistCol  (Datum+Zeit kombinieren)
//   C) Fallback: Spalte A = Zeitstempel, B = Wert  (kein Header)
function detectColumns(rows) {
  const maxHeaderRow = Math.min(20, rows.length);

  for (let r = 0; r < maxHeaderRow; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;

    const headers = row.map(normalizeHeader);
    let tsKombi = -1;     // einzelne kombinierte Zeitstempel-Spalte
    let datumCol = -1;    // nur Datum
    let zeitCol = -1;     // nur Uhrzeit
    let leistCol = -1;

    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      if (!h) continue;
      // Reihenfolge: kombiniert -> sonst getrennt
      if (tsKombi < 0 && ZEITSTEMPEL_KOMBI_KANDIDATEN.some(k => h.includes(normalizeHeader(k)))) {
        tsKombi = c;
      }
      if (datumCol < 0 && DATUM_KANDIDATEN.some(k => h === normalizeHeader(k))) {
        datumCol = c;
      }
      if (zeitCol < 0 && ZEIT_KANDIDATEN.some(k => h === normalizeHeader(k))) {
        zeitCol = c;
      }
      if (leistCol < 0 && LEISTUNG_KANDIDATEN.some(k => h.includes(normalizeHeader(k)))) {
        leistCol = c;
      }
    }

    // Layout A: kombinierte TS-Spalte + Leistung
    if (tsKombi >= 0 && leistCol >= 0 && tsKombi !== leistCol) {
      return {
        headerRow: r,
        tsCol: tsKombi,
        tsCol2: null,
        leistCol,
        originalHeaders: row.map(h => String(h ?? '')),
        layout: 'kombinierter-zeitstempel',
      };
    }

    // Layout B: Datum + Zeit + Leistung (drei Spalten)
    if (datumCol >= 0 && zeitCol >= 0 && leistCol >= 0
        && datumCol !== zeitCol && datumCol !== leistCol && zeitCol !== leistCol) {
      return {
        headerRow: r,
        tsCol: datumCol,
        tsCol2: zeitCol,
        leistCol,
        originalHeaders: row.map(h => String(h ?? '')),
        layout: 'datum-zeit-getrennt',
      };
    }

    // Layout A-Variante: nur datumCol als Zeitstempel (z.B. wenn der Header nur "Datum" heisst und schon Uhrzeit enthaelt)
    if (datumCol >= 0 && leistCol >= 0 && datumCol !== leistCol && zeitCol < 0) {
      // Validiere mit der naechsten Zeile, ob Spalte tatsaechlich Datum+Uhrzeit traegt
      const dataRow = rows[r + 1];
      if (dataRow) {
        const ts = parseTimestamp(dataRow[datumCol]);
        if (ts && ts.getUTCHours() !== 0 || ts && (rows[r + 2] && parseTimestamp(rows[r + 2][datumCol])?.getUTCHours() !== 0)) {
          return {
            headerRow: r,
            tsCol: datumCol,
            tsCol2: null,
            leistCol,
            originalHeaders: row.map(h => String(h ?? '')),
            layout: 'datum-mit-uhrzeit',
          };
        }
      }
    }
  }

  // Fallback: erste Spalte Zeitstempel, zweite Spalte Leistung.
  for (let r = 0; r < maxHeaderRow; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const ts = parseTimestamp(row[0]);
    const wert = parseGermanNumber(row[1]);
    if (ts && wert != null) {
      return {
        headerRow: r - 1 >= 0 ? r - 1 : 0,
        tsCol: 0,
        tsCol2: null,
        leistCol: 1,
        originalHeaders: ['Spalte A', 'Spalte B'],
        layout: 'fallback-positionsbasiert',
      };
    }
  }

  throw new Error('Konnte Spalten fuer Zeitstempel und Leistung nicht erkennen.');
}

// Kombiniert ein Date-Objekt (nur Datum) mit einem Date-Objekt (nur Uhrzeit, Excel-Epoche 1899-12-30).
function kombiniereDatumUndZeit(datumVal, zeitVal) {
  const datum = datumVal instanceof Date ? datumVal : parseTimestamp(datumVal);
  if (!datum) return null;

  let stunden = 0, minuten = 0, sekunden = 0;
  if (zeitVal instanceof Date) {
    stunden = zeitVal.getUTCHours();
    minuten = zeitVal.getUTCMinutes();
    sekunden = zeitVal.getUTCSeconds();
  } else if (typeof zeitVal === 'string') {
    const m = zeitVal.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      stunden = +m[1];
      minuten = +m[2];
      sekunden = m[3] ? +m[3] : 0;
    } else {
      return null;
    }
  } else if (typeof zeitVal === 'number') {
    // Excel-Anteil: 0..1 entspricht 0..24 Stunden
    const total = Math.round(zeitVal * 86400);
    stunden = Math.floor(total / 3600);
    minuten = Math.floor((total % 3600) / 60);
    sekunden = total % 60;
  } else {
    return null;
  }

  return new Date(Date.UTC(
    datum.getUTCFullYear(), datum.getUTCMonth(), datum.getUTCDate(),
    stunden, minuten, sekunden,
  ));
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
    if (!row || row[cols.tsCol] == null) continue;
    let ts;
    if (cols.tsCol2 != null) {
      ts = kombiniereDatumUndZeit(row[cols.tsCol], row[cols.tsCol2]);
    } else {
      ts = parseTimestamp(row[cols.tsCol]);
    }
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
  // Heuristik-Reihenfolge:
  //  1. Header enthaelt "kWh" -> Energie
  //  2. Header enthaelt "kW" oder "leistung" -> kW
  //  3. Header neutral ("Wert", "Messwert", "Verbrauch") + Sheet/Datei deutet auf
  //     Verbrauchs-Export ("consumption", "verbrauch") -> Energie (kWh/Intervall)
  //  4. Default: kW
  let einheit = options.einheitHint || 'auto';
  let einheit_quelle_grund = null;
  if (einheit === 'auto') {
    const headerText = (cols.originalHeaders[cols.leistCol] || '').toLowerCase();
    const sheetText = (sheetName || '').toLowerCase();
    const dateiText = (filename || '').toLowerCase();
    const intervallSuffix = intervallMinuten === 15 ? '/15min' : '/30min';

    if (headerText.includes('kwh')) {
      einheit = 'kWh' + intervallSuffix;
      einheit_quelle_grund = `Header "${cols.originalHeaders[cols.leistCol]}" enthaelt 'kWh'`;
    } else if (headerText.includes('kw') || headerText.includes('leistung') || headerText === 'p') {
      einheit = 'kW';
      einheit_quelle_grund = `Header "${cols.originalHeaders[cols.leistCol]}" deutet auf Leistung`;
    } else {
      // Neutraler Header ("Wert", "Messwert" o.ae.) — Default kW.
      // Wechsel auf kWh/Intervall nur ueber expliziten Hint (UI-Override),
      // da Verbrauchsportale Lastgaenge ueberwiegend in kW exportieren,
      // auch wenn der Sheet-Name "consumption"/"verbrauch" suggeriert.
      einheit = 'kW';
      einheit_quelle_grund = `Neutraler Header "${cols.originalHeaders[cols.leistCol]}" — Default kW (kein eindeutiger Hinweis auf Energie pro Intervall)`;
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
      ts_spalte_2: cols.tsCol2 != null ? cols.originalHeaders[cols.tsCol2] : null,
      leistung_spalte: cols.originalHeaders[cols.leistCol],
      layout: cols.layout,
      einheit_grund: einheit_quelle_grund,
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
