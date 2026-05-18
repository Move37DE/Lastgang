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
    if (err.code === 'ENOENT') {
      // Fallback: vorheriges Jahr versuchen
      const previous = antragsjahr - 1;
      try {
        const fallbackFile = path.join(dataDir, 'vnb-hlzf', `${vnbKurz}-${previous}.json`);
        const raw = await fs.readFile(fallbackFile, 'utf8');
        const data = JSON.parse(raw);
        data._fallback = `HLZF fuer ${antragsjahr} nicht vorhanden — verwende ${previous}.`;
        return data;
      } catch {
        throw new Error(`Keine HLZF-Datei fuer ${vnbKurz} (${antragsjahr} oder ${previous}) gefunden.`);
      }
    }
    throw err;
  }
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
