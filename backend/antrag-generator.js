// Erzeugt formale Antragsformulare nach § 19 Abs. 2 Satz 1 StromNEV als DOCX.
// Eine Datei pro Tarifvariante, jeweils so strukturiert, dass sie ohne weitere
// Bearbeitung beim VNB eingereicht werden kann.
//
// Struktur nachgebildet aus der Berater-Vorlage Hermann Bilz GmbH (3 Sheets:
// "Antrag < 2.500 h (neu)", "Antrag mit Wahloption >2.500h", "Antrag >2.500 h").

import {
  Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell,
  AlignmentType, WidthType, PageNumber, Footer, Header,
} from 'docx';

const FARBE_PASS = '107C10';
const FARBE_FAIL = 'D13438';
const FARBE_WARN = 'B07D04';
const FARBE_GREY = '595959';
const FARBE_PRIMARY = '1F3A5F';

function dt(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function eur(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function num(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function p(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text: String(text ?? ''), ...opts })],
    spacing: { after: 80 },
  });
}

function h(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    children: [new TextRun({ text, bold: true })],
    spacing: { before: 200, after: 100 },
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text: String(text ?? '—'), ...opts })],
    })],
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
  });
}

function statusCell(status) {
  const color = status === 'gueltig' || status === 'GÜLTIG' ? FARBE_PASS
              : status === 'ungueltig' || status === 'UNGÜLTIG' ? FARBE_FAIL
              : FARBE_WARN;
  return cell(status === 'gueltig' ? 'gültig' : status, { bold: true, color });
}

function table(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(cells => new TableRow({ children: cells })),
  });
}

// Hauptfunktion: erzeugt einen formalen Antrag fuer eine Tarifvariante.
// variant: 'lt2500' (Antrag <2.500 h), 'ge2500' (Antrag >=2.500 h), 'wahloption'
export async function generateAntragDocx(stammdaten, parserResult, pruefung, netzentgelt, variant) {
  if (!netzentgelt || !netzentgelt.tarife) {
    throw new Error('Netzentgelt-Berechnung fehlt — Antrag nicht moeglich.');
  }
  const k = pruefung.kennzahlen;
  const e = netzentgelt.eingaben;

  // Tarifvariante auswaehlen
  const tarifKey = variant === 'wahloption' ? 'ge2500' : variant;
  const tarif = netzentgelt.tarife[tarifKey];
  if (!tarif) {
    throw new Error(`Tarifvariante ${tarifKey} ist nicht hinterlegt — Antrag nicht moeglich.`);
  }

  const variantLabel = {
    'lt2500': 'Netzentgelte < 2.500 h',
    'ge2500': 'Netzentgelte ≥ 2.500 h',
    'wahloption': 'Netzentgelte ≥ 2.500 h (Wahloption nach § 19 Abs. 2 S. 1 StromNEV)',
  }[variant];

  // Pruefungen pro Antragsvariante
  const dPMin = 100; // kW
  const dP = k.delta_p_kw;
  const erhSoll = parseFloat(pruefung.grundlage?.spannungsebene
    && ['MS_NS', 'NS'].includes(pruefung.grundlage.spannungsebene)
    ? 30 : 20);
  const erhIst = k.atypizitaetsgrad_prozent;
  const allgEur = tarif.allgemein_eur;
  const indEur = tarif.individuell_effektiv_eur;
  const indPercent = (indEur / allgEur) * 100;
  const minIndPercent = 20;
  const reduktion = tarif.reduktion_effektiv_eur;
  const bagatelle = 500;

  const pruefStatus = (ist, soll, op = '>=') => {
    const ok = op === '>=' ? ist >= soll : ist <= soll;
    return ok ? 'gueltig' : 'ungueltig';
  };

  // Stammdaten-Tabelle
  const stammRows = [
    [cell('Firma', { bold: true }), cell(stammdaten.kunde || '—')],
    [cell('Postanschrift des Kunden', { bold: true }), cell(stammdaten.adresse || '—')],
    [cell('Marktlokations-Identifikationsnummer', { bold: true }), cell(stammdaten.malo_id || '— (bitte vor Einreichung ergaenzen)')],
    [cell('Adresse der Lieferstelle', { bold: true }), cell(stammdaten.adresse || '—')],
    [cell('Netzbetreiber', { bold: true }), cell(stammdaten.vnb_name || '—')],
    [cell('Beantragungsjahr', { bold: true }), cell(stammdaten.antragsjahr || '—')],
    [cell('Gewuenschte Netzentgelte', { bold: true }), cell(variantLabel)],
    [cell('Spannungsebene', { bold: true }), cell(stammdaten.spannungsebene || '—')],
    [cell('Vollbenutzungsstunden', { bold: true }), cell(`${num(e.vollbenutzungsstunden, 2)} h`)],
  ];

  // IST-Werte-Tabelle mit Pruefspalte
  const istRows = [
    [
      cell('Position', { bold: true }),
      cell('Ist-Wert', { bold: true }),
      cell('Privileg', { bold: true }),
    ],
    [cell('Pmax (Jahreshoechstlast)'), cell(`${num(k.jhl_kw, 2)} kW`), cell('—')],
    [cell('Pmax innerhalb des Hochlastzeitfensters'), cell(`${num(k.hlz_max_kw, 2)} kW`), cell('—')],
    [
      cell('Leistungsdifferenz (≥ 100 kW gefordert)'),
      cell(`${num(dP, 2)} kW`),
      statusCell(pruefStatus(dP, dPMin)),
    ],
    [cell('Jahresarbeit'), cell(`${num(e.jahresarbeit_kwh, 2)} kWh`), cell('—')],
    [cell('Leistungspreis'), cell(`${num(tarif.lp_eur_kwa, 2)} €/kW/a`), cell('—')],
    [cell('Arbeitspreis'), cell(`${num(tarif.ap_ct_kwh, 2)} ct/kWh`), cell('—')],
  ];

  // Entgelt-Vergleich
  const entgeltRows = [
    [cell('Allgemeines Entgelt', { bold: true }), cell(eur(allgEur), { bold: true }), cell('100 %', { bold: true })],
    [cell('Individuelles Entgelt'), cell(eur(indEur)), cell(`${num(indPercent, 2)} %`)],
    [
      cell(`Mindest-Individuelles Entgelt (${minIndPercent} % des Allgemeinen)`),
      cell(eur(allgEur * 0.20)),
      statusCell(pruefStatus(indPercent, minIndPercent)),
    ],
  ];

  // Reduktion + Bagatelle
  const reduktionRows = [
    [
      cell('Reduktion absolut', { bold: true }),
      cell(eur(reduktion), { bold: true }),
      statusCell(pruefStatus(reduktion, bagatelle)),
    ],
    [
      cell('Bagatellgrenze'),
      cell(`${bagatelle} € / Jahr`),
      cell('—'),
    ],
  ];

  // Erheblichkeitsschwelle
  const erhRows = [
    [
      cell('Erheblichkeitsschwelle (Ist)', { bold: true }),
      cell(`${num(erhIst, 2)} %`),
      statusCell(pruefStatus(erhIst, erhSoll)),
    ],
    [
      cell(`Mindest-Erheblichkeitsschwelle (${stammdaten.spannungsebene})`),
      cell(`${erhSoll} %`),
      cell('—'),
    ],
  ];

  // Gesamtbewertung: alle Pruefungen muessen gueltig sein
  const allValid = pruefStatus(dP, dPMin) === 'gueltig'
                && pruefStatus(indPercent, minIndPercent) === 'gueltig'
                && pruefStatus(reduktion, bagatelle) === 'gueltig'
                && pruefStatus(erhIst, erhSoll) === 'gueltig';

  // Wahloption-spezifischer Hinweis
  const wahloptionHinweis = variant === 'wahloption' ? [
    p('Hinweis zur Wahloption:', { bold: true }),
    p(
      `Mit ${num(e.vollbenutzungsstunden, 0)} Vollbenutzungsstunden faellt der Letztverbraucher rechnerisch unter den Tarif < 2.500 h. ` +
      `Gemaess Wahloption nach § 19 Abs. 2 Satz 1 StromNEV optiert der Letztverbraucher bewusst auf die Tarifvariante ≥ 2.500 h, ` +
      `da diese aufgrund des hoeheren Leistungspreises eine groessere Reduktion ermoeglicht.`,
      { italics: true },
    ),
    p(''),
  ] : [];

  // Standardbegruendung
  const begruendung = `Die Hoechstleistung fuer die Abnahmestelle ${stammdaten.adresse || '[Adresse]'} ` +
    `weicht im Hochlastzeitfenster des zustaendigen Netzbetreibers (${stammdaten.vnb_name || '[VNB]'}) erheblich ` +
    `von der Jahreshoechstleistung ab. Die im Lastgang ${stammdaten.antragsjahr - 1 || '[Vorjahr]'} ermittelte ` +
    `Atypizitaet betraegt ${num(erhIst, 2)} % und liegt damit ueber der fuer die Spannungsebene ` +
    `${stammdaten.spannungsebene} geforderten Erheblichkeitsschwelle von ${erhSoll} %. ` +
    `Die Leistungsdifferenz von ${num(dP, 2)} kW erfuellt die Anforderung an die Mindestverlagerung von 100 kW. ` +
    `Der Antragsteller bittet daher um Festlegung eines individuellen Netzentgelts gemaess § 19 Abs. 2 Satz 1 StromNEV.`;

  const doc = new Document({
    creator: 'Lastgang-Analyzer',
    title: `Antrag § 19 Abs. 2 S. 1 StromNEV — ${stammdaten.kunde || ''}`,
    description: `Formaler Antrag (Variante ${variantLabel})`,
    sections: [{
      properties: {},
      headers: {
        default: new Header({
          children: [p(`Antrag § 19 Abs. 2 Satz 1 StromNEV — ${stammdaten.kunde || ''}`, { size: 16, color: FARBE_GREY })],
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
        // Titel
        new Paragraph({
          heading: HeadingLevel.TITLE,
          children: [new TextRun({ text: 'Antrag auf Festlegung eines individuellen Netzentgelts', bold: true })],
          spacing: { after: 120 },
        }),
        new Paragraph({
          children: [new TextRun({ text: 'nach § 19 Abs. 2 Satz 1 StromNEV', italics: true, color: FARBE_PRIMARY })],
          spacing: { after: 240 },
        }),

        // Adressat
        h('Adressat', HeadingLevel.HEADING_2),
        p(stammdaten.vnb_name || '[Netzbetreiber]', { bold: true }),
        p('— Abteilung Netzentgelte —'),
        p(''),

        // Antragsteller
        h('Antragsteller', HeadingLevel.HEADING_2),
        table(stammRows),

        // Wahloption-spezifisch
        ...wahloptionHinweis,

        // Begruendung
        h('Begruendung', HeadingLevel.HEADING_2),
        p(begruendung),
        p(''),

        // IST-Werte
        h(`IST-Werte des Referenzzeitraums (${stammdaten.antragsjahr ? stammdaten.antragsjahr - 1 : 'Vorjahr'})`, HeadingLevel.HEADING_2),
        table(istRows),
        p(''),

        // Einordnung
        h('Einordnung der Entgelte', HeadingLevel.HEADING_2),
        table(entgeltRows),
        p(''),
        table(reduktionRows),
        p(''),
        table(erhRows),
        p(''),

        // Gesamtbewertung
        h('Gesamtbewertung', HeadingLevel.HEADING_2),
        new Paragraph({
          children: [new TextRun({
            text: allValid
              ? '✓ Alle Voraussetzungen nach § 19 Abs. 2 Satz 1 StromNEV sind erfuellt.'
              : '⚠ Mindestens eine Voraussetzung ist nicht erfuellt — siehe oben markierte Pruefspalte.',
            bold: true,
            color: allValid ? FARBE_PASS : FARBE_FAIL,
            size: 24,
          })],
          spacing: { after: 240 },
        }),

        // Beantragung
        h('Beantragung', HeadingLevel.HEADING_2),
        p(
          `Der Antragsteller beantragt hiermit gemaess § 19 Abs. 2 Satz 1 StromNEV die Festlegung eines ` +
          `individuellen Netzentgelts fuer das Kalenderjahr ${stammdaten.antragsjahr || '[Jahr]'} in Hoehe von ` +
          `${eur(indEur)} (anstelle des allgemeinen Entgelts von ${eur(allgEur)}).`,
        ),
        p(
          `Die rechnerische Reduktion betraegt ${eur(reduktion)} pro Jahr und liegt damit ueber der ` +
          `Bagatellgrenze von ${bagatelle} €/a sowie ueber 20 % des regulaeren Netzentgelts.`,
        ),
        p(''),

        // Datum / Unterschrift
        h('Ort, Datum, Unterschrift', HeadingLevel.HEADING_2),
        p(''),
        p('______________________________     ______________________________'),
        p('Ort, Datum                                     Unterschrift Antragsteller', { size: 18, color: FARBE_GREY }),
        p(''),

        // Hinweise
        h('Hinweise', HeadingLevel.HEADING_2),
        p(`• Antragstellung bis spaetestens 30. September des Antragsjahres bei der Bundesnetzagentur anzeigen.`, { size: 18 }),
        p(`• Jahresnachweis (tatsaechlicher Lastgang) bis 30. Juni des Folgejahres beim Netzbetreiber einreichen.`, { size: 18 }),
        p(`• Rechtsgrundlage: § 19 Abs. 2 Satz 1 StromNEV i.V.m. BNetzA-Festlegung BK4-13-739.`, { size: 18 }),
        p(`• Auslauf der Regelung: 31.12.2028. Letztmoegliche Antragstellung beim VNB: 30.09.2028.`, { size: 18, italics: true }),
        p(''),
        p(`Erstellt mit Lastgang-Analyzer. Dieser Antrag ist eine automatisierte Vorlage und ersetzt keine ` +
          `rechtliche oder energiewirtschaftliche Beratung. Vor formaler Einreichung sind die Werte zu pruefen ` +
          `und ggf. um Anlagen (z.B. Lastganggutachten, Marktstammdaten-Auszug) zu ergaenzen.`, { size: 16, color: FARBE_GREY, italics: true }),
      ],
    }],
  });

  return await Packer.toBuffer(doc);
}

// Helper: ermittelt welche Antraege fuer eine Pruefung erzeugt werden sollen.
// Liefert Liste von { variant, label, applicable }
export function ermittelAntragsvarianten(netzentgelt) {
  if (!netzentgelt || !netzentgelt.tarife) return [];

  const vbh = netzentgelt.eingaben.vollbenutzungsstunden;
  const hatLt = !!netzentgelt.tarife.lt2500;
  const hatGe = !!netzentgelt.tarife.ge2500;
  const result = [];

  if (vbh >= 2500) {
    if (hatGe) {
      result.push({ variant: 'ge2500', label: 'Antrag ≥ 2.500 h (Standard)', empfohlen: true });
    }
  } else {
    if (hatLt) {
      result.push({
        variant: 'lt2500',
        label: 'Antrag < 2.500 h (Standard)',
        empfohlen: !netzentgelt.wahloption_empfohlen,
      });
    }
    if (hatGe) {
      result.push({
        variant: 'wahloption',
        label: 'Antrag ≥ 2.500 h (Wahloption)',
        empfohlen: !!netzentgelt.wahloption_empfohlen,
      });
    }
  }

  return result;
}
