// Loest aus einer PLZ den zustaendigen Verteilnetzbetreiber + Bundesland auf
// und laedt die zugehoerige HLZF-Definition fuer das gewuenschte Antragsjahr.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, 'data');

let plzMapCache = null;
async function ladePlzMap() {
  if (plzMapCache) return plzMapCache;
  const raw = await fs.readFile(path.join(dataDir, 'plz-vnb.json'), 'utf8');
  plzMapCache = JSON.parse(raw);
  return plzMapCache;
}

export async function resolveVnbAusPlz(plz) {
  const map = await ladePlzMap();
  const plzNum = String(plz).padStart(5, '0');

  for (const regel of map.regeln) {
    const von = regel.bedingung.plz_von;
    const bis = regel.bedingung.plz_bis;
    if (plzNum >= von && plzNum <= bis) {
      return {
        vnb_kurz: regel.vnb_kurz,
        vnb_name: regel.vnb_name,
        bundesland: regel.bundesland,
        kommentar: regel.kommentar,
      };
    }
  }

  return null;
}

export async function ladeHlzf(vnbKurz, antragsjahr) {
  const file = path.join(dataDir, 'vnb-hlzf', `${vnbKurz}-${antragsjahr}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Fallback-Suche: zuerst Vorjahr, dann Folgejahr (HLZF aendern sich von
    // Jahr zu Jahr selten dramatisch, sind aber kein perfekter Ersatz).
    const kandidaten = [antragsjahr - 1, antragsjahr + 1, antragsjahr - 2, antragsjahr + 2];
    for (const fallbackJahr of kandidaten) {
      const fallbackFile = path.join(dataDir, 'vnb-hlzf', `${vnbKurz}-${fallbackJahr}.json`);
      try {
        const raw = await fs.readFile(fallbackFile, 'utf8');
        const data = JSON.parse(raw);
        data._fallback = `HLZF fuer ${antragsjahr} nicht hinterlegt — Naeherung aus ${fallbackJahr}. Vor Antragstellung mit offizieller Veroeffentlichung fuer ${antragsjahr} abgleichen.`;
        return data;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    throw new Error(`Keine HLZF-Datei fuer ${vnbKurz} (${antragsjahr} oder Vorjahre/Folgejahre) gefunden.`);
  }
}

// Laedt die Netzentgelt-Tarife eines VNB fuer ein Antragsjahr.
// Gleiche Fallback-Logik wie ladeHlzf (Vorjahr versuchen).
export async function ladeTarife(vnbKurz, antragsjahr) {
  const file = path.join(dataDir, 'vnb-tarife', `${vnbKurz}-${antragsjahr}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const previous = antragsjahr - 1;
      try {
        const fallbackFile = path.join(dataDir, 'vnb-tarife', `${vnbKurz}-${previous}.json`);
        const raw = await fs.readFile(fallbackFile, 'utf8');
        const data = JSON.parse(raw);
        data._fallback = `Tarife fuer ${antragsjahr} nicht vorhanden — verwende ${previous}.`;
        return data;
      } catch {
        return null; // weich: Tarife sind optional, nicht jeder VNB ist hinterlegt
      }
    }
    throw err;
  }
}

// Extrahiert die Tarife fuer EINE Spannungsebene als kompaktes Objekt.
// Liefert null, wenn die Werte nicht hinterlegt sind (Frontend zeigt dann leere Felder).
export function extrahiereTarifeFuerEbene(tarifeDef, spannungsebene) {
  if (!tarifeDef || !tarifeDef.spannungsebenen) return null;
  const ebene = tarifeDef.spannungsebenen[spannungsebene];
  if (!ebene) return null;

  const lt = ebene.lt2500 || {};
  const ge = ebene.ge2500 || {};
  // Wenn alle Werte null sind -> nichts hinterlegt
  const hatWerte = lt.lp_eur_kwa != null || lt.ap_ct_kwh != null
                 || ge.lp_eur_kwa != null || ge.ap_ct_kwh != null;
  if (!hatWerte) return null;

  return {
    lt2500: (lt.lp_eur_kwa != null && lt.ap_ct_kwh != null)
      ? { lp_eur_kwa: lt.lp_eur_kwa, ap_ct_kwh: lt.ap_ct_kwh }
      : null,
    ge2500: (ge.lp_eur_kwa != null && ge.ap_ct_kwh != null)
      ? { lp_eur_kwa: ge.lp_eur_kwa, ap_ct_kwh: ge.ap_ct_kwh }
      : null,
    quelle: {
      vnb: tarifeDef.vnb,
      antragsjahr: tarifeDef.antragsjahr,
      quelle_url: tarifeDef.quelle_url,
      status: tarifeDef._meta?.status || 'OK',
      fallback: tarifeDef._fallback || null,
    },
  };
}

export async function listeVerfuegbareVnbs() {
  const files = await fs.readdir(path.join(dataDir, 'vnb-hlzf'));
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const m = f.match(/^(.+)-(\d{4})\.json$/);
      return m ? { vnb_kurz: m[1], jahr: parseInt(m[2], 10) } : null;
    })
    .filter(Boolean);
}
