// Generiert einen Pruefbericht als DOCX aus dem Ergebnis von pruefAtypizitaet().

import {
  Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, PageNumber, Footer, Header,
} from 'docx';

const FARBE_PASS = '107C10';
const FARBE_FAIL = 'D13438';
const FARBE_WARN = 'B07D04';
const FARBE_GREY = '595959';

function dt(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mo}.${yy} ${hh}:${mi}`;
}

function statusFarbe(status) {
  if (status === 'PASS') return FARBE_PASS;
  if (status === 'FAIL') return FARBE_FAIL;
  if (status === 'WARN') return FARBE_WARN;
  return FARBE_GREY;
}

function p(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text: String(text ?? ''), ...opts })],
    spacing: { after: 100 },
  });
}

function h(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    children: [new TextRun({ text, bold: true })],
    spacing: { before: 240, after: 120 },
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: String(text ?? '—'), ...opts })],
    })],
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
  });
}

function table(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(cells => new TableRow({ children: cells })),
  });
}

function eur(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function buildHlzfLastspitzenSection(lastspitzen) {
  if (!lastspitzen) return [];

  const hlzfRows = [
    [
      cell('#', { bold: true }),
      cell('Datum / Uhrzeit', { bold: true }),
      cell('Jahreszeit', { bold: true }),
      cell('Leistung (kW)', { bold: true }),
      cell('Δ zur Schwelle', { bold: true }),
      cell('Status', { bold: true }),
    ],
  ];
  (lastspitzen.top_hlzf_intervalle || []).forEach((iv, i) => {
    hlzfRows.push([
      cell(String(i + 1)),
      cell(dt(iv.ts)),
      cell(iv.jahreszeit),
      cell(String(iv.leistung_kw)),
      cell(iv.ueber_erheblichkeitsschwelle
        ? `+${iv.ueberschreitung_kw} kW`
        : `${iv.ueberschreitung_kw} kW`),
      cell(iv.ueber_erheblichkeitsschwelle ? '⚠ kritisch' : '✓ unter Schwelle', {
        bold: iv.ueber_erheblichkeitsschwelle,
        color: iv.ueber_erheblichkeitsschwelle ? FARBE_FAIL : FARBE_PASS,
      }),
    ]);
  });

  const gesamtRows = [
    [
      cell('#', { bold: true }),
      cell('Datum / Uhrzeit', { bold: true }),
      cell('Leistung (kW)', { bold: true }),
      cell('Über Schwelle', { bold: true }),
    ],
  ];
  (lastspitzen.top_ueberschreitungen_gesamt || []).forEach((iv, i) => {
    gesamtRows.push([
      cell(String(i + 1)),
      cell(dt(iv.ts)),
      cell(String(iv.leistung_kw)),
      cell(`+${iv.ueberschreitung_kw} kW (+${iv.ueberschreitung_prozent} %)`),
    ]);
  });

  const hatHlzfSpitzen = (lastspitzen.top_hlzf_intervalle || []).length > 0;
  const hatGesamtUeb = (lastspitzen.top_ueberschreitungen_gesamt || []).length > 0;

  return [
    h('Lastspitzen-Analyse', HeadingLevel.HEADING_1),
    p(
      `Erheblichkeitsschwelle: ${lastspitzen.erheblichkeitsschwelle_kw} kW ` +
      `(= Pmax × (1 − Atypizitäts-Schwelle der Spannungsebene)).`,
      { italics: true, color: FARBE_GREY },
    ),

    h('Top-Lastwerte innerhalb der Hochlastzeitfenster', HeadingLevel.HEADING_2),
    p(
      `Werte ueber der Erheblichkeitsschwelle innerhalb der HLZF gefaehrden den Antrag. ` +
      `Anzahl HLZF-Intervalle insgesamt: ${lastspitzen.anzahl_hlzf_intervalle} · ` +
      `davon ueber Schwelle: ${lastspitzen.anzahl_ueberschreitungen_in_hlzf}`,
      { bold: true },
    ),
    p(''),
    ...(hatHlzfSpitzen ? [table(hlzfRows), p('')] : [p('— Keine HLZF-Intervalle im Auswertungszeitraum.', { italics: true })]),

    h('Top-Ueberschreitungen im gesamten Jahr', HeadingLevel.HEADING_2),
    p(
      `Werte ueber der Erheblichkeitsschwelle ueber das ganze Jahr (inkl. ausserhalb HLZF). ` +
      `Diese Sicht entspricht der Berater-Vorlage. Anzahl gesamt: ${lastspitzen.anzahl_ueberschreitungen_gesamt}.`,
      { italics: true, color: FARBE_GREY },
    ),
    p(''),
    ...(hatGesamtUeb
      ? [table(gesamtRows), p('')]
      : [p('— Keine Werte ueber der Erheblichkeitsschwelle.', { italics: true })]),
  ];
}

function buildNetzentgeltSection(netzentgelt) {
  if (!netzentgelt || !netzentgelt.tarife) return [];

  const e = netzentgelt.eingaben;
  const tarife = netzentgelt.tarife;
  const variantenZeilen = [
    [
      cell('Tarifvariante', { bold: true }),
      cell('Leistungspreis', { bold: true }),
      cell('Arbeitspreis', { bold: true }),
      cell('Allg. Netzentgelt', { bold: true }),
      cell('Indiv. Netzentgelt', { bold: true }),
      cell('Reduktion / Jahr', { bold: true }),
    ],
  ];
  for (const [key, t] of Object.entries(tarife)) {
    if (!t) continue;
    const label = key === 'lt2500' ? '< 2.500 h' : '≥ 2.500 h';
    const istZugeordnet = key === netzentgelt.tarif_zugeordnet;
    variantenZeilen.push([
      cell(label + (istZugeordnet ? '  (zugeordnet)' : ''), { bold: istZugeordnet }),
      cell(`${t.lp_eur_kwa} €/kW/a`),
      cell(`${t.ap_ct_kwh} ct/kWh`),
      cell(eur(t.allgemein_eur)),
      cell(eur(t.individuell_effektiv_eur)),
      cell(eur(t.reduktion_effektiv_eur), {
        bold: true,
        color: istZugeordnet ? FARBE_PASS : FARBE_GREY,
      }),
    ]);
  }

  const eingabenParagraphen = [
    p(`Jahreshöchstlast (Pmax): ${e.pmax_kw} kW` + (e.pmax_bereinigt_kw !== e.pmax_kw
      ? ` (bereinigt um Weiterleitung: ${e.pmax_bereinigt_kw} kW)` : '')),
    p(`Höchstlast in HLZF (Pmax_HLZF): ${e.pmax_hlzf_kw} kW`),
    p(`Jahresarbeit: ${e.jahresarbeit_kwh.toLocaleString('de-DE')} kWh`
      + (e.weiterleitung_kwh > 0 ? ` (Weiterleitung: ${e.weiterleitung_kwh.toLocaleString('de-DE')} kWh)` : '')),
    p(`Vollbenutzungsstunden: ${e.vollbenutzungsstunden} h`),
  ];

  const bewertungParagraphen = [];
  const besterTarif = tarife[netzentgelt.bester_tarif];
  if (besterTarif) {
    bewertungParagraphen.push(p(
      `Wirtschaftlich bester Tarif: ${netzentgelt.bester_tarif === 'lt2500' ? '< 2.500 h' : '≥ 2.500 h'} — ` +
      `Reduktion ${eur(besterTarif.reduktion_effektiv_eur)} pro Jahr.`,
      { bold: true, color: FARBE_PASS, size: 24 },
    ));
  }
  if (netzentgelt.wahloption_empfohlen) {
    bewertungParagraphen.push(p(
      'Wahloption empfohlen: Mit < 2.500 h Vollbenutzungsstunden kann der Kunde freiwillig den ≥ 2.500 h Tarif waehlen und damit eine hoehere Reduktion erzielen.',
      { italics: true, color: FARBE_WARN },
    ));
  }
  for (const [key, t] of Object.entries(tarife)) {
    if (!t) continue;
    if (!t.pruefung.bagatelle_erfuellt) {
      bewertungParagraphen.push(p(
        `Hinweis (Tarif ${key === 'lt2500' ? '< 2.500 h' : '≥ 2.500 h'}): Reduktion unter Bagatellgrenze (${netzentgelt.konstanten.bagatelle_eur} €/Jahr) — Antrag nicht zulaessig.`,
        { color: FARBE_FAIL },
      ));
    }
    if (!t.pruefung.mindestentgelt_eingehalten) {
      bewertungParagraphen.push(p(
        `Hinweis (Tarif ${key === 'lt2500' ? '< 2.500 h' : '≥ 2.500 h'}): Rechnerisches indiv. Entgelt unter 20 %-Untergrenze — gekappt auf ${eur(t.min_individuell_eur)}.`,
        { color: FARBE_WARN },
      ));
    }
  }

  return [
    h('Netzentgelte (vor / nach § 19 Abs. 2 Satz 1 StromNEV)', HeadingLevel.HEADING_1),
    ...eingabenParagraphen,
    new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 100 } }),
    table(variantenZeilen),
    new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 100 } }),
    ...bewertungParagraphen,
  ];
}

export async function generateDocx(stammdaten, parserResult, pruefung, netzentgelt = null) {
  const k = pruefung.kennzahlen || {};
  const ergebnisLabel = {
    'ANSPRUCH_GEGEBEN': 'ANSPRUCH GEGEBEN',
    'GRENZFALL_MANUELLE_PRUEFUNG': 'GRENZFALL — manuelle Pruefung empfohlen',
    'KEIN_ANSPRUCH': 'KEIN ANSPRUCH',
    'FEHLER': 'FEHLER bei der Pruefung',
  }[pruefung.ergebnis] || pruefung.ergebnis;

  const ergebnisFarbe = {
    'ANSPRUCH_GEGEBEN': FARBE_PASS,
    'GRENZFALL_MANUELLE_PRUEFUNG': FARBE_WARN,
    'KEIN_ANSPRUCH': FARBE_FAIL,
  }[pruefung.ergebnis] || FARBE_GREY;

  const stammTabelle = table([
    [cell('Kunde / Anlage', { bold: true }), cell(stammdaten.kunde || '—')],
    [cell('Netzanschluss-Adresse', { bold: true }), cell(stammdaten.adresse || '—')],
    [cell('Spannungsebene', { bold: true }), cell(stammdaten.spannungsebene || '—')],
    [cell('Bundesland', { bold: true }), cell(stammdaten.bundesland || '—')],
    [cell('Antragsjahr', { bold: true }), cell(stammdaten.antragsjahr || '—')],
    [cell('Verteilnetzbetreiber', { bold: true }), cell(stammdaten.vnb_name || '—')],
    [cell('HLZF-Quelle', { bold: true }), cell(pruefung.grundlage?.hlzf_quelle || 'PLATZHALTER — bitte vor Antragstellung mit offizieller Veroeffentlichung abgleichen.')],
  ]);

  const kennzahlenTabelle = table([
    [cell('Auswertungszeitraum', { bold: true }), cell(`${dt(parserResult.zeitraum?.von)} — ${dt(parserResult.zeitraum?.bis)}`)],
    [cell('Datenvollstaendigkeit', { bold: true }), cell(`${parserResult.qualitaet?.vollstaendigkeit_prozent ?? '—'} %`)],
    [cell('Intervallbreite', { bold: true }), cell(`${parserResult.intervall_minuten} Minuten`)],
    [cell('Jahresenergiebezug', { bold: true }), cell(`${k.jahresenergie_mwh ?? '—'} MWh`)],
    [cell('Jahreshoechstlast (JHL)', { bold: true }), cell(`${k.jhl_kw ?? '—'} kW am ${dt(k.jhl_ts)}`)],
    [cell('Vollbenutzungsstunden', { bold: true }), cell(`${k.vollbenutzungsstunden ?? '—'} h`)],
    [cell('Hoechstlast in HLZF', { bold: true }), cell(`${k.hlz_max_kw ?? '—'} kW am ${dt(k.hlz_max_ts)}`)],
    [cell('Differenzleistung ΔP', { bold: true }), cell(`${k.delta_p_kw ?? '—'} kW`)],
    [cell('Atypizitaetsgrad', { bold: true }), cell(`${k.atypizitaetsgrad_prozent ?? '—'} %`, { bold: true })],
  ]);

  const schwellenZeilen = [
    [
      cell('Kriterium', { bold: true }),
      cell('Ist-Wert', { bold: true }),
      cell('Anforderung', { bold: true }),
      cell('Status', { bold: true }),
    ],
  ];
  for (const s of pruefung.schwellen || []) {
    schwellenZeilen.push([
      cell(s.name),
      cell(`${s.ist} ${s.einheit}`),
      cell(`>= ${s.mindest} ${s.einheit}`),
      cell(s.status, { bold: true, color: statusFarbe(s.status) }),
    ]);
  }
  if (pruefung.vorhersehbarkeit) {
    schwellenZeilen.push([
      cell(pruefung.vorhersehbarkeit.name),
      cell(`${pruefung.vorhersehbarkeit.ist} ${pruefung.vorhersehbarkeit.einheit}`),
      cell(`>= ${pruefung.vorhersehbarkeit.mindest} ${pruefung.vorhersehbarkeit.einheit}`),
      cell(pruefung.vorhersehbarkeit.status, { bold: true, color: statusFarbe(pruefung.vorhersehbarkeit.status) }),
    ]);
  }

  const saisonZeilen = [
    [
      cell('Jahreszeit', { bold: true }),
      cell('JHL (kW)', { bold: true }),
      cell('Hoechstlast in HLZF (kW)', { bold: true }),
      cell('HLZF-Stunden', { bold: true }),
      cell('JHL ausserhalb HLZF?', { bold: true }),
    ],
  ];
  for (const s of pruefung.saisonal || []) {
    saisonZeilen.push([
      cell(s.jahreszeit),
      cell(s.jhl_kw ?? '—'),
      cell(s.hlzf_max_kw ?? '—'),
      cell(s.hlzf_stunden),
      cell(s.jhl_ausserhalb_hlzf ? 'JA' : 'NEIN', {
        bold: true,
        color: s.jhl_ausserhalb_hlzf ? FARBE_PASS : FARBE_FAIL,
      }),
    ]);
  }

  const wirt = pruefung.wirtschaftlichkeit || {};
  const wirtParagraphen = [];
  if (wirt.potenzielle_ersparnis_eur != null) {
    wirtParagraphen.push(p(`Potenzielle Ersparnis: ca. ${wirt.potenzielle_ersparnis_eur.toLocaleString('de-DE')} EUR/Jahr`, { bold: true }));
    wirtParagraphen.push(p(`(bei Leistungspreis ${wirt.leistungspreis_eur_pro_kw_a} EUR/kW/Jahr)`, { color: FARBE_GREY }));
  } else {
    wirtParagraphen.push(p(
      `Potenzielle Ersparnis (Bandbreite): ${(wirt.potenzielle_ersparnis_eur_min || 0).toLocaleString('de-DE')} — ${(wirt.potenzielle_ersparnis_eur_max || 0).toLocaleString('de-DE')} EUR/Jahr`,
      { bold: true }
    ));
    wirtParagraphen.push(p(wirt.hinweis || '', { color: FARBE_GREY }));
  }

  const naechsteSchritte = pruefung.ergebnis === 'ANSPRUCH_GEGEBEN' ? [
    p('1. Formloser Antrag beim Verteilnetzbetreiber stellen, inkl. Lastganggutachten.'),
    p('2. Anzeige bei der Bundesnetzagentur (BNetzA) bis spaetestens 30. September des Antragsjahres.'),
    p('3. Jahresnachweis (tatsaechlicher Lastgang) bis 30. Juni des Folgejahres beim VNB einreichen.'),
    p('4. Hinweis: § 19 Abs. 2 Satz 1 StromNEV laeuft am 31.12.2028 aus. Letzter Antrag: 30.09.2028. Nachfolgeregelung AgNes (BNetzA GBK-25-01-1#3) beobachten.'),
  ] : pruefung.ergebnis === 'GRENZFALL_MANUELLE_PRUEFUNG' ? [
    p('Das Ergebnis liegt im Grenzbereich. Empfehlung:'),
    p('• Datenqualitaet und Lastgangabgrenzung pruefen (insb. Vollstaendigkeit, Vorzeichen, Sommerzeitumstellung).'),
    p('• Bei Unsicherheit zur HLZF-Definition: aktuelle Veroeffentlichung des VNB einholen und mit dem Tool erneut pruefen.'),
    p('• Lastverlagerungs-Massnahmen kurzzeitig intensivieren, um Atypizitaetsgrad deutlich ueber die Mindestschwelle zu heben, bevor formal beantragt wird.'),
  ] : [
    p('Auf Basis des vorgelegten Lastgangs besteht kein Anspruch nach § 19 Abs. 2 Satz 1 StromNEV.'),
    p('Pruefen Sie alternativ:'),
    p('• § 19 Abs. 2 Satz 2 StromNEV (Hochverbrauchsrabatt) — Voraussetzung: >= 7.000 Vollbenutzungsstunden.'),
    p('• Massnahmen zur Lastverlagerung mit Zielsetzung, JHL in nachweisbare Nebenzeiten zu verschieben.'),
  ];

  const doc = new Document({
    creator: 'Lastgang-Analyzer',
    title: `Pruefung § 19 Abs. 2 Satz 1 StromNEV — ${stammdaten.kunde || ''}`,
    description: 'Automatisierte Pruefung des Anspruchs auf individuelles Netzentgelt',
    sections: [{
      properties: {},
      headers: {
        default: new Header({
          children: [p('Lastgang-Analyzer — Pruefbericht § 19 Abs. 2 Satz 1 StromNEV', { size: 16, color: FARBE_GREY })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: 'Seite ', size: 16, color: FARBE_GREY }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: FARBE_GREY }),
              new TextRun({ text: ' / ', size: 16, color: FARBE_GREY }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: FARBE_GREY }),
            ],
          })],
        }),
      },
      children: [
        h('Pruefbericht: Anspruch auf individuelles Netzentgelt', HeadingLevel.TITLE),
        p('§ 19 Abs. 2 Satz 1 StromNEV — atypische Netznutzung', { italics: true, color: FARBE_GREY }),
        p(''),
        h('Gesamtbewertung', HeadingLevel.HEADING_1),
        new Paragraph({
          children: [new TextRun({ text: ergebnisLabel, bold: true, color: ergebnisFarbe, size: 32 })],
          spacing: { after: 240 },
        }),
        h('Stammdaten', HeadingLevel.HEADING_1),
        stammTabelle,
        h('Lastgang-Kennzahlen', HeadingLevel.HEADING_1),
        kennzahlenTabelle,
        h('Pruefkriterien', HeadingLevel.HEADING_1),
        table(schwellenZeilen),
        h('Saisonale Auswertung', HeadingLevel.HEADING_1),
        table(saisonZeilen),

        // HLZF-Lastspitzen-Liste (analog "Messwerte"-Blatt der Berater-Excel)
        ...buildHlzfLastspitzenSection(pruefung.hlzf_lastspitzen),
        // Netzentgelt-Sektion (wenn Tarife angegeben) — sonst Fallback Wirtschaftlichkeit
        ...(netzentgelt
          ? buildNetzentgeltSection(netzentgelt)
          : [h('Wirtschaftlichkeit', HeadingLevel.HEADING_1), ...wirtParagraphen]
        ),
        h('Naechste Schritte', HeadingLevel.HEADING_1),
        ...naechsteSchritte,
        h('Rechtliche Grundlage', HeadingLevel.HEADING_1),
        p('§ 19 Abs. 2 Satz 1 StromNEV i.V.m. BNetzA-Festlegung BK4-13-739'),
        p(`Referenzzeitraum HLZF: 1. September des Vorjahres bis 31. August des Antragsjahres ${stammdaten.antragsjahr || ''}.`),
        p('Untergrenze des individuellen Netzentgelts: 20 % des regulaeren Netzentgelts.'),
        p('Auslauf der Regelung: § 19 Abs. 2 Satz 1 StromNEV endet am 31.12.2028.', { italics: true }),
        h('Haftungsausschluss', HeadingLevel.HEADING_1),
        p('Dieser Bericht ist eine automatisierte Vorpruefung. Er ersetzt keine rechtliche oder energiewirtschaftliche Beratung. Vor formaler Antragstellung sind die HLZF des zustaendigen VNB sowie die aktuelle Festlegungslage der BNetzA zu pruefen.', { color: FARBE_GREY, size: 18 }),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer;
}
