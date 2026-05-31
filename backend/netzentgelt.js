// Berechnung der Netzentgelte vor und nach § 19 Abs. 2 Satz 1 StromNEV.
// Methodik gemaess BNetzA-Festlegung BK4-13-739 und etablierter Praxis
// (verifiziert gegen Kundenrechnung "Hermann Bilz GmbH & Co KG", Netze BW).
//
// Grundprinzip:
//   Allgemeines Entgelt  = LP × Pmax           + AP × Jahresarbeit
//   Individuelles Entgelt = LP × Pmax_HLZF      + AP × Jahresarbeit
//   Reduktion             = LP × (Pmax - Pmax_HLZF)
//
// Untergrenze: Individuelles Entgelt darf 20% des Allgemeinen nicht unterschreiten.
// Bagatellgrenze: Reduktion muss >= 500 EUR/Jahr betragen.
//
// Es gibt zwei Tarifvarianten je VNB & Spannungsebene:
//   - < 2.500 h Vollbenutzungsstunden: niedriger LP, hoher AP
//   - >= 2.500 h Vollbenutzungsstunden: hoher LP, niedriger AP
// Der VNB ordnet automatisch zu — ausser bei Wahloption (Kunde mit VBh < 2500 h
// kann freiwillig auf den >= 2500 h Tarif optieren, wenn das wirtschaftlicher ist).

const BAGATELLE_EUR = 500;
const MIN_INDIVIDUELL_ANTEIL = 0.20; // 20 % des allgemeinen Entgelts

// args = {
//   pmax_kw, pmax_hlzf_kw, jahresarbeit_kwh,
//   tarif_lt2500: { lp_eur_kwa, ap_ct_kwh },
//   tarif_ge2500: { lp_eur_kwa, ap_ct_kwh },
//   weiterleitung_kwh = 0,
// }
export function berechneNetzentgelte(args) {
  const {
    pmax_kw,
    pmax_hlzf_kw,
    jahresarbeit_kwh,
    tarif_lt2500 = null,
    tarif_ge2500 = null,
    weiterleitung_kwh = 0,
  } = args;

  if (pmax_kw == null || pmax_hlzf_kw == null || jahresarbeit_kwh == null) {
    return { fehler: 'pmax_kw, pmax_hlzf_kw und jahresarbeit_kwh erforderlich.' };
  }

  // Pmax bereinigen um Weiterleitung an Dritte (proportional)
  const verhaeltnis = jahresarbeit_kwh > 0 ? weiterleitung_kwh / jahresarbeit_kwh : 0;
  const pmax_bereinigt = pmax_kw * (1 - verhaeltnis);
  const jahresarbeit_netto = jahresarbeit_kwh - weiterleitung_kwh;

  const vollbenutzungsstunden = pmax_bereinigt > 0
    ? jahresarbeit_netto / pmax_bereinigt
    : 0;

  // Pro Tarifvariante rechnen
  const tarife = {};
  for (const [key, tarif] of [['lt2500', tarif_lt2500], ['ge2500', tarif_ge2500]]) {
    if (!tarif || tarif.lp_eur_kwa == null || tarif.ap_ct_kwh == null) {
      tarife[key] = null;
      continue;
    }
    const lp = parseFloat(tarif.lp_eur_kwa);
    const ap = parseFloat(tarif.ap_ct_kwh);

    const allgemein = lp * pmax_bereinigt + (ap / 100) * jahresarbeit_netto;
    const individuell = lp * pmax_hlzf_kw + (ap / 100) * jahresarbeit_netto;
    const reduktion = allgemein - individuell; // = lp * (pmax_bereinigt - pmax_hlzf_kw)
    const min_individuell = allgemein * MIN_INDIVIDUELL_ANTEIL;
    const reduktion_max = allgemein * (1 - MIN_INDIVIDUELL_ANTEIL); // 80 % des allgemeinen

    // Pruefungen
    const individuell_effektiv = Math.max(individuell, min_individuell);
    const reduktion_effektiv = allgemein - individuell_effektiv;

    tarife[key] = {
      lp_eur_kwa: lp,
      ap_ct_kwh: ap,
      allgemein_eur: round2(allgemein),
      individuell_rechnerisch_eur: round2(individuell),
      min_individuell_eur: round2(min_individuell),
      individuell_effektiv_eur: round2(individuell_effektiv),
      reduktion_rechnerisch_eur: round2(reduktion),
      reduktion_effektiv_eur: round2(reduktion_effektiv),
      max_reduktion_eur: round2(reduktion_max),
      pruefung: {
        bagatelle_erfuellt: reduktion_effektiv >= BAGATELLE_EUR,
        mindestentgelt_eingehalten: individuell >= min_individuell,
      },
    };
  }

  // Tarif-Zuordnung gemaess VBh
  let tarif_zugeordnet;
  if (vollbenutzungsstunden < 2500) {
    tarif_zugeordnet = 'lt2500';
  } else {
    tarif_zugeordnet = 'ge2500';
  }

  // Wahloption: nur wenn VBh < 2500 h und >=2500h-Tarif waere wirtschaftlicher
  let wahloption_empfohlen = false;
  if (vollbenutzungsstunden < 2500
      && tarife.lt2500 && tarife.ge2500
      && tarife.ge2500.reduktion_effektiv_eur > tarife.lt2500.reduktion_effektiv_eur) {
    wahloption_empfohlen = true;
  }

  // Bester Tarif (hoechste effektive Reduktion)
  let bester_tarif = null;
  let beste_reduktion = -Infinity;
  for (const [key, t] of Object.entries(tarife)) {
    if (t && t.reduktion_effektiv_eur > beste_reduktion) {
      beste_reduktion = t.reduktion_effektiv_eur;
      bester_tarif = key;
    }
  }

  return {
    eingaben: {
      pmax_kw: round2(pmax_kw),
      pmax_bereinigt_kw: round2(pmax_bereinigt),
      pmax_hlzf_kw: round2(pmax_hlzf_kw),
      jahresarbeit_kwh: round2(jahresarbeit_kwh),
      weiterleitung_kwh: round2(weiterleitung_kwh),
      jahresarbeit_netto_kwh: round2(jahresarbeit_netto),
      vollbenutzungsstunden: round2(vollbenutzungsstunden),
    },
    tarife,
    tarif_zugeordnet,
    wahloption_empfohlen,
    bester_tarif,
    beste_reduktion_eur: bester_tarif ? tarife[bester_tarif].reduktion_effektiv_eur : 0,
    konstanten: {
      bagatelle_eur: BAGATELLE_EUR,
      min_individuell_anteil: MIN_INDIVIDUELL_ANTEIL,
    },
  };
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}
