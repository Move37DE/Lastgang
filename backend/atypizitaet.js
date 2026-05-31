// Kernlogik: Pruefung des Anspruchs auf individuelles Netzentgelt nach
// § 19 Abs. 2 Satz 1 StromNEV (atypische Netznutzung).
//
// Eingaben:
//   lastgang:      Ergebnis von parseLastgang(...)
//   hlzfDefinition: { spannungsebenen: { MS: { fruehling: [...], sommer: [...], ... } } }
//   spannungsebene: 'HS' | 'HS_MS' | 'MS' | 'MS_NS' | 'NS'
//   bundesland:    Code fuer Feiertagsberechnung
//   leistungspreisEurProKwa: optional, fuer Wirtschaftlichkeitsschaetzung
//
// Ausgabe: strukturierter Pruefbericht.

import { istHlzfWerktag, nebenzeitDatenFuer, ymd } from './feiertage.js';

// BNetzA BK4-13-739 Erheblichkeitsschwellen
const ERHEBLICHKEITSSCHWELLEN = {
  HOES_HS: { atypizitaet_prozent: 20, mindest_verlagerung_kw: 100, bagatelle_eur: 500 },
  HS:    { atypizitaet_prozent: 20, mindest_verlagerung_kw: 100, bagatelle_eur: 500 },
  HS_MS: { atypizitaet_prozent: 20, mindest_verlagerung_kw: 100, bagatelle_eur: 500 },
  MS:    { atypizitaet_prozent: 20, mindest_verlagerung_kw: 100, bagatelle_eur: 500 },
  MS_NS: { atypizitaet_prozent: 30, mindest_verlagerung_kw: 100, bagatelle_eur: 500 },
  NS:    { atypizitaet_prozent: 30, mindest_verlagerung_kw: 100, bagatelle_eur: 500 },
};

const JAHRESZEITEN = [
  { name: 'fruehling', von_mm: 3,  bis_mm: 5  },
  { name: 'sommer',    von_mm: 6,  bis_mm: 8  },
  { name: 'herbst',    von_mm: 9,  bis_mm: 11 },
  { name: 'winter',    von_mm: 12, bis_mm: 2  }, // wrap
];

function jahreszeitFuerMonat(month_1_12) {
  for (const jz of JAHRESZEITEN) {
    if (jz.von_mm <= jz.bis_mm) {
      if (month_1_12 >= jz.von_mm && month_1_12 <= jz.bis_mm) return jz.name;
    } else {
      // winter: 12 oder 1, 2
      if (month_1_12 >= jz.von_mm || month_1_12 <= jz.bis_mm) return jz.name;
    }
  }
  return null;
}

// Pruefen ob Uhrzeit in einem HLZF-Fenster liegt.
// fenster: [{wochentage: 'Mo-Fr', von: 'HH:MM', bis: 'HH:MM'}, ...]
function liegtInFenster(date, fenster) {
  if (!fenster || fenster.length === 0) return false;
  const wd = date.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa
  const hh = date.getUTCHours();
  const mm = date.getUTCMinutes();
  const minOfDay = hh * 60 + mm;

  for (const f of fenster) {
    if (!wochentagPasst(wd, f.wochentage)) continue;
    const [vonH, vonM] = f.von.split(':').map(Number);
    const [bisH, bisM] = f.bis.split(':').map(Number);
    const vonMin = vonH * 60 + vonM;
    const bisMin = bisH * 60 + bisM;
    // Konvention: "von 08:00 bis 11:00" = [08:00, 11:00) — Intervallbeginn inkl., Ende exkl.
    if (minOfDay >= vonMin && minOfDay < bisMin) return true;
  }
  return false;
}

function wochentagPasst(wd, spec) {
  const s = (spec || '').toLowerCase().replace(/\s/g, '');
  if (s === 'mo-fr') return wd >= 1 && wd <= 5;
  if (s === 'mo-so') return true;
  if (s === 'mo-sa') return wd >= 1 && wd <= 6;
  // Einzelne Tage: 'mo,di,mi'
  const namen = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };
  return s.split(',').some(t => namen[t] === wd);
}

export function pruefAtypizitaet(args) {
  const {
    lastgang,
    hlzfDefinition,
    spannungsebene,
    bundesland,
    leistungspreisEurProKwa,
  } = args;

  const schwellen = ERHEBLICHKEITSSCHWELLEN[spannungsebene];
  if (!schwellen) {
    throw new Error(`Unbekannte Spannungsebene: ${spannungsebene}`);
  }

  const hlzfProJahreszeit = hlzfDefinition?.spannungsebenen?.[spannungsebene];
  if (!hlzfProJahreszeit) {
    throw new Error(`Keine HLZF-Definition fuer Spannungsebene ${spannungsebene} im VNB-Datensatz.`);
  }

  // Vorberechnungen: Nebenzeiten-Map je beruehrtem Jahr cachen
  const nebenzeitCache = new Map();
  const getNebenzeit = (year) => {
    if (!nebenzeitCache.has(year)) {
      nebenzeitCache.set(year, nebenzeitDatenFuer(bundesland, year));
    }
    return nebenzeitCache.get(year);
  };

  // Iteration: durch alle Intervalle, klassifizieren
  let jahresenergie_kwh = 0;
  let jhl_kw = -Infinity;
  let jhl_ts = null;
  let minLast = Infinity;
  let hlzMax_kw = -Infinity;
  let hlzMax_ts = null;

  const jzStats = {
    fruehling: { hlzfStunden: 0, hlzfMax: -Infinity, hlzfMaxTs: null, jhl: -Infinity, jhlTs: null },
    sommer:    { hlzfStunden: 0, hlzfMax: -Infinity, hlzfMaxTs: null, jhl: -Infinity, jhlTs: null },
    herbst:    { hlzfStunden: 0, hlzfMax: -Infinity, hlzfMaxTs: null, jhl: -Infinity, jhlTs: null },
    winter:    { hlzfStunden: 0, hlzfMax: -Infinity, hlzfMaxTs: null, jhl: -Infinity, jhlTs: null },
  };

  // Sammlung aller HLZF-Intervalle fuer die Top-N-Liste der Lastspitzen
  const hlzfIntervalle = [];

  const intervallStundenFaktor = lastgang.intervall_minuten / 60;

  for (const iv of lastgang.intervalle) {
    if (iv.fehlt || iv.leistung_kw == null) continue;
    const p = iv.leistung_kw;
    const ts = iv.ts;

    jahresenergie_kwh += p * intervallStundenFaktor;
    if (p > jhl_kw) { jhl_kw = p; jhl_ts = ts; }
    if (p < minLast) minLast = p;

    const monat = ts.getUTCMonth() + 1;
    const jz = jahreszeitFuerMonat(monat);
    if (!jz) continue;

    if (p > jzStats[jz].jhl) {
      jzStats[jz].jhl = p;
      jzStats[jz].jhlTs = ts;
    }

    // HLZF-Pruefung: nur an "HLZF-Werktagen" (Mo-Fr, kein Feiertag/Brueckentag/Weihnachten)
    const istWerktag = istHlzfWerktag(ts, bundesland);
    if (!istWerktag) continue;
    void getNebenzeit(ts.getUTCFullYear()); // Cache aufwaermen

    const fenster = hlzfProJahreszeit[jz];
    if (liegtInFenster(ts, fenster)) {
      jzStats[jz].hlzfStunden += intervallStundenFaktor;
      if (p > jzStats[jz].hlzfMax) {
        jzStats[jz].hlzfMax = p;
        jzStats[jz].hlzfMaxTs = ts;
      }
      if (p > hlzMax_kw) {
        hlzMax_kw = p;
        hlzMax_ts = ts;
      }
      hlzfIntervalle.push({ ts, leistung_kw: p, jahreszeit: jz });
    }
  }

  if (jhl_kw === -Infinity || hlzMax_kw === -Infinity) {
    return {
      ergebnis: 'FEHLER',
      grund: 'Lastgang enthaelt keine HLZF-Werte oder ist leer.',
      kennzahlen: null,
    };
  }

  // Vollbenutzungsstunden = Jahresenergie [kWh] / Jahreshoechstlast [kW]
  const vollbenutzungsstunden = jahresenergie_kwh / jhl_kw;

  const deltaP_kw = jhl_kw - hlzMax_kw;
  const atypizitaetsgrad_prozent = (deltaP_kw / jhl_kw) * 100;

  // Schwellen pruefen
  const pruefSchwelle = [
    {
      name: 'Atypizitaetsgrad',
      ist: atypizitaetsgrad_prozent,
      mindest: schwellen.atypizitaet_prozent,
      einheit: '%',
      status: atypizitaetsgrad_prozent >= schwellen.atypizitaet_prozent ? 'PASS' : 'FAIL',
    },
    {
      name: 'Mindestverlagerung',
      ist: deltaP_kw,
      mindest: schwellen.mindest_verlagerung_kw,
      einheit: 'kW',
      status: deltaP_kw >= schwellen.mindest_verlagerung_kw ? 'PASS' : 'FAIL',
    },
  ];

  // Bagatelle: nur wenn Leistungspreis bekannt
  let bagatelle = null;
  let wirtschaftlichkeit = null;
  if (leistungspreisEurProKwa != null) {
    const ersparnis = deltaP_kw * leistungspreisEurProKwa;
    bagatelle = {
      name: 'Bagatellgrenze',
      ist: Math.round(ersparnis),
      mindest: schwellen.bagatelle_eur,
      einheit: 'EUR/Jahr',
      status: ersparnis >= schwellen.bagatelle_eur ? 'PASS' : 'FAIL',
    };
    pruefSchwelle.push(bagatelle);
    wirtschaftlichkeit = {
      leistungspreis_eur_pro_kw_a: leistungspreisEurProKwa,
      potenzielle_ersparnis_eur: Math.round(ersparnis),
    };
  } else {
    // Bandbreite ausgeben (60-180 EUR/kW/a typisch)
    wirtschaftlichkeit = {
      leistungspreis_eur_pro_kw_a: null,
      potenzielle_ersparnis_eur_min: Math.round(deltaP_kw * 60),
      potenzielle_ersparnis_eur_max: Math.round(deltaP_kw * 180),
      hinweis: 'Leistungspreis unbekannt — Bandbreite 60-180 EUR/kW/Jahr (typisch).',
    };
  }

  // HLZF-Lastspitzen + Erheblichkeitsschwellen-Analyse:
  //
  // Erheblichkeitsschwelle = Pmax × (1 − Atypizitäts-Schwelle)
  //   z.B. MS_NS 30 %: 316,52 × 0,70 = 221,56 kW
  //
  // Zwei Sichten:
  // 1) Überschreitungen INNERHALB der HLZF — gefaehrden den Antrag
  //    (Last sollte in HLZF gering sein, nicht hoch)
  // 2) Überschreitungen IM GANZEN JAHR (Berater-Sicht aus Kunden-Excel) —
  //    Pmax-Tage + ahnlich hohe Werte. Hoch = atypisches Profil bestaetigt.
  const erhebSchwelleKw = jhl_kw * (1 - schwellen.atypizitaet_prozent / 100);
  hlzfIntervalle.sort((a, b) => b.leistung_kw - a.leistung_kw);
  const ueberschreitungenInHlzf = hlzfIntervalle.filter(i => i.leistung_kw > erhebSchwelleKw);

  // Top-Werte im gesamten Jahr (alle Intervalle, nicht nur HLZF)
  const alleIntervalleSorted = [];
  for (const iv of lastgang.intervalle) {
    if (iv.fehlt || iv.leistung_kw == null) continue;
    if (iv.leistung_kw > erhebSchwelleKw) {
      alleIntervalleSorted.push({ ts: iv.ts, leistung_kw: iv.leistung_kw });
    }
  }
  alleIntervalleSorted.sort((a, b) => b.leistung_kw - a.leistung_kw);

  const hlzfLastspitzen = {
    erheblichkeitsschwelle_kw: Math.round(erhebSchwelleKw * 10) / 10,
    anzahl_hlzf_intervalle: hlzfIntervalle.length,
    anzahl_ueberschreitungen_in_hlzf: ueberschreitungenInHlzf.length,
    anzahl_ueberschreitungen_gesamt: alleIntervalleSorted.length,
    top_hlzf_intervalle: hlzfIntervalle.slice(0, 20).map(i => ({
      ts: i.ts,
      leistung_kw: Math.round(i.leistung_kw * 10) / 10,
      jahreszeit: i.jahreszeit,
      ueber_erheblichkeitsschwelle: i.leistung_kw > erhebSchwelleKw,
      ueberschreitung_kw: Math.round((i.leistung_kw - erhebSchwelleKw) * 10) / 10,
    })),
    top_ueberschreitungen_gesamt: alleIntervalleSorted.slice(0, 20).map(i => ({
      ts: i.ts,
      leistung_kw: Math.round(i.leistung_kw * 10) / 10,
      ueberschreitung_kw: Math.round((i.leistung_kw - erhebSchwelleKw) * 10) / 10,
      ueberschreitung_prozent: Math.round((i.leistung_kw / erhebSchwelleKw - 1) * 1000) / 10,
    })),
  };

  // Saisonale Konsistenz: in wie vielen Jahreszeiten ist die JHL ausserhalb HLZF?
  const saisonal = JAHRESZEITEN.map(({ name }) => {
    const s = jzStats[name];
    const jhlInHlzf = s.hlzfMax > 0 && s.jhl > 0 && Math.abs(s.jhl - s.hlzfMax) < 0.01;
    return {
      jahreszeit: name,
      jhl_kw: s.jhl > 0 ? Math.round(s.jhl * 10) / 10 : null,
      jhl_ts: s.jhlTs,
      hlzf_max_kw: s.hlzfMax > 0 ? Math.round(s.hlzfMax * 10) / 10 : null,
      hlzf_max_ts: s.hlzfMaxTs,
      hlzf_stunden: Math.round(s.hlzfStunden),
      jhl_ausserhalb_hlzf: !jhlInHlzf,
    };
  });
  const saisonenAtypisch = saisonal.filter(s => s.jhl_ausserhalb_hlzf).length;
  const vorhersehbarkeit = {
    name: 'Vorhersehbarkeit (>= 2 von 4 Jahreszeiten atypisch)',
    ist: saisonenAtypisch,
    mindest: 2,
    einheit: 'Jahreszeiten',
    status: saisonenAtypisch >= 2 ? 'PASS' : 'WARN',
  };

  // Gesamtbewertung
  const harteFails = pruefSchwelle.filter(p => p.status === 'FAIL');
  let gesamt;
  if (harteFails.length === 0 && vorhersehbarkeit.status === 'PASS') {
    gesamt = 'ANSPRUCH_GEGEBEN';
  } else if (harteFails.length === 0) {
    gesamt = 'GRENZFALL_MANUELLE_PRUEFUNG';
  } else {
    gesamt = 'KEIN_ANSPRUCH';
  }

  return {
    ergebnis: gesamt,
    kennzahlen: {
      // Anzeigewerte (gerundet)
      jahresenergie_mwh: Math.round(jahresenergie_kwh / 100) / 10,
      jhl_kw: Math.round(jhl_kw * 10) / 10,
      jhl_ts,
      min_last_kw: minLast === Infinity ? null : Math.round(minLast * 10) / 10,
      vollbenutzungsstunden: Math.round(vollbenutzungsstunden),
      hlz_max_kw: Math.round(hlzMax_kw * 10) / 10,
      hlz_max_ts: hlzMax_ts,
      delta_p_kw: Math.round(deltaP_kw * 10) / 10,
      atypizitaetsgrad_prozent: Math.round(atypizitaetsgrad_prozent * 10) / 10,
      // Unverrundete Werte (fuer Folgeberechnungen wie Netzentgelt)
      jahresenergie_kwh,
      jhl_kw_raw: jhl_kw,
      hlz_max_kw_raw: hlzMax_kw,
    },
    schwellen: pruefSchwelle,
    vorhersehbarkeit,
    saisonal,
    hlzf_lastspitzen: hlzfLastspitzen,
    wirtschaftlichkeit,
    grundlage: {
      rechtsnorm: '§ 19 Abs. 2 Satz 1 StromNEV',
      festlegung: 'BNetzA BK4-13-739',
      spannungsebene,
      bundesland,
      hlzf_quelle: hlzfDefinition?.quelle_url || null,
      hlzf_antragsjahr: hlzfDefinition?.antragsjahr || null,
    },
  };
}
