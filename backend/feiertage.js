// Gesetzliche Feiertage in Deutschland je Bundesland.
// Quelle: jeweilige Landesgesetze, abgestimmt mit feiertage.de / Bundesinnenministerium.
// Berechnung Ostern: Spencer-Variante des Gauss-Algorithmus.

const BUNDESLAENDER = [
  'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV',
  'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH',
];

// Berechnet Ostersonntag (Gregorianischer Kalender, Spencer-Algorithmus).
function ostersonntag(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// Liefert alle gesetzlichen Feiertage fuer ein Bundesland und Jahr als
// Map { 'YYYY-MM-DD': 'Bezeichnung' }.
export function feiertageFuer(bundesland, year) {
  const bl = bundesland.toUpperCase();
  if (!BUNDESLAENDER.includes(bl)) {
    throw new Error(`Unbekanntes Bundesland: ${bundesland}`);
  }

  const ostern = ostersonntag(year);
  const map = {};
  const add = (date, name) => { map[ymd(date)] = name; };

  // Bundesweit
  add(new Date(Date.UTC(year, 0, 1)), 'Neujahr');
  add(addDays(ostern, -2), 'Karfreitag');
  add(addDays(ostern, 1), 'Ostermontag');
  add(new Date(Date.UTC(year, 4, 1)), 'Tag der Arbeit');
  add(addDays(ostern, 39), 'Christi Himmelfahrt');
  add(addDays(ostern, 50), 'Pfingstmontag');
  add(new Date(Date.UTC(year, 9, 3)), 'Tag der Deutschen Einheit');
  add(new Date(Date.UTC(year, 11, 25)), '1. Weihnachtstag');
  add(new Date(Date.UTC(year, 11, 26)), '2. Weihnachtstag');

  // Heilige Drei Koenige: BW, BY, ST
  if (['BW', 'BY', 'ST'].includes(bl)) {
    add(new Date(Date.UTC(year, 0, 6)), 'Heilige Drei Koenige');
  }

  // Internationaler Frauentag: BE (seit 2019), MV (seit 2023)
  if (bl === 'BE' && year >= 2019) {
    add(new Date(Date.UTC(year, 2, 8)), 'Internationaler Frauentag');
  }
  if (bl === 'MV' && year >= 2023) {
    add(new Date(Date.UTC(year, 2, 8)), 'Internationaler Frauentag');
  }

  // Fronleichnam: BW, BY, HE, NW, RP, SL + teils SN, TH (regional)
  if (['BW', 'BY', 'HE', 'NW', 'RP', 'SL'].includes(bl)) {
    add(addDays(ostern, 60), 'Fronleichnam');
  }

  // Maria Himmelfahrt: SL (gesetzlich); BY regional (katholische Mehrheit) — hier vereinfacht: SL ja, BY ja
  if (['SL', 'BY'].includes(bl)) {
    add(new Date(Date.UTC(year, 7, 15)), 'Mariae Himmelfahrt');
  }

  // Weltkindertag: TH (seit 2019)
  if (bl === 'TH' && year >= 2019) {
    add(new Date(Date.UTC(year, 8, 20)), 'Weltkindertag');
  }

  // Reformationstag: BB, MV, SN, ST, TH (jaehrlich); SH, HH, NI, HB (seit 2018)
  if (['BB', 'MV', 'SN', 'ST', 'TH'].includes(bl)) {
    add(new Date(Date.UTC(year, 9, 31)), 'Reformationstag');
  }
  if (['SH', 'HH', 'NI', 'HB'].includes(bl) && year >= 2018) {
    add(new Date(Date.UTC(year, 9, 31)), 'Reformationstag');
  }

  // Allerheiligen: BW, BY, NW, RP, SL
  if (['BW', 'BY', 'NW', 'RP', 'SL'].includes(bl)) {
    add(new Date(Date.UTC(year, 10, 1)), 'Allerheiligen');
  }

  // Buss- und Bettag: SN
  if (bl === 'SN') {
    // Mittwoch vor dem 23. November
    let bbt = new Date(Date.UTC(year, 10, 23));
    while (bbt.getUTCDay() !== 3) bbt = addDays(bbt, -1);
    add(bbt, 'Buss- und Bettag');
  }

  return map;
}

// Hilfsfunktion: ist Datum ein Feiertag (in dem Bundesland)?
export function istFeiertag(date, bundesland) {
  const year = date.getUTCFullYear();
  const map = feiertageFuer(bundesland, year);
  return Boolean(map[ymd(date)]);
}

// Liefert das Datum als 'YYYY-MM-DD'.
export { ymd };

// Ermittelt Brueckentage: Werktage, die zwischen einem Feiertag und einem
// Wochenende liegen. Beispiel: Feiertag Donnerstag -> Freitag ist Brueckentag.
// Gesetzlich (BNetzA-Leitfaden): max. 1 Brueckentag pro Woche ist Nebenzeit.
//
// Strategie: pro Kalenderwoche maximal 1 Tag markieren.
export function brueckentageFuer(bundesland, year) {
  const feiertage = feiertageFuer(bundesland, year);
  const result = {};
  const wochenMarkiert = new Set();

  for (const fTag of Object.keys(feiertage)) {
    const d = new Date(`${fTag}T00:00:00Z`);
    const wd = d.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa

    let kandidat = null;
    if (wd === 2) {
      // Feiertag Di -> Mo ist Brueckentag
      kandidat = addDays(d, -1);
    } else if (wd === 4) {
      // Feiertag Do -> Fr ist Brueckentag
      kandidat = addDays(d, 1);
    }

    if (kandidat) {
      const woche = isoWeek(kandidat);
      const key = ymd(kandidat);
      // Bereits ein Feiertag an dem Tag? -> kein Brueckentag.
      if (feiertage[key]) continue;
      if (!wochenMarkiert.has(woche)) {
        result[key] = `Brueckentag (Feiertag ${feiertage[fTag]})`;
        wochenMarkiert.add(woche);
      }
    }
  }

  return result;
}

function isoWeek(date) {
  // ISO 8601 Wochennummer
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Liefert die "Nebenzeiten" eines Jahres: Tage, die fuer die HLZF-Pruefung
// ausgeschlossen sind (Wochenenden, Feiertage, 1 Brueckentag/Woche, 24.12.-01.01.)
export function nebenzeitDatenFuer(bundesland, year) {
  const feiertage = feiertageFuer(bundesland, year);
  const brueckentage = brueckentageFuer(bundesland, year);
  const result = { ...feiertage, ...brueckentage };

  // 24.12. - 31.12. immer ausschliessen (BNetzA-Leitfaden)
  for (let day = 24; day <= 31; day++) {
    result[ymd(new Date(Date.UTC(year, 11, day)))] = result[ymd(new Date(Date.UTC(year, 11, day)))] || 'Weihnachtszeit';
  }

  return result;
}

// Bequemlichkeit: prueft, ob ein Datum als HLZF-faehiger Werktag gilt.
// HLZF gilt nur Mo-Fr, nicht an Feiertagen / Brueckentagen / 24.12.-01.01.
export function istHlzfWerktag(date, bundesland) {
  const wd = date.getUTCDay();
  if (wd === 0 || wd === 6) return false; // Sa, So

  const year = date.getUTCFullYear();
  const nebenzeiten = nebenzeitDatenFuer(bundesland, year);
  if (nebenzeiten[ymd(date)]) return false;

  // 01.01. abdecken (Neujahr ist eh Feiertag, aber Sicherheitsnetz)
  if (date.getUTCMonth() === 0 && date.getUTCDate() === 1) return false;

  return true;
}
