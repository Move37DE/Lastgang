import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { parseLastgang } from './lastgang-parser.js';
import {
  resolveVnbAusPlz, ladeHlzf, listeVerfuegbareVnbs,
  ladeTarife, extrahiereTarifeFuerEbene,
} from './vnb-resolver.js';
import { pruefAtypizitaet } from './atypizitaet.js';
import { berechneNetzentgelte } from './netzentgelt.js';
import { generateDocx } from './report-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PWA_DIR = path.join(ROOT, 'pwa');
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(ROOT, 'output'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));
const PORT = parseInt(process.env.PORT || '3002', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '25', 10);

await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PWA_DIR));

// In-Memory-Speicher fuer abgeschlossene Analysen (Phase 1).
const analysen = new Map();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '0.1.0' });
});

app.get('/api/vnb-list', async (_req, res) => {
  try {
    const list = await listeVerfuegbareVnbs();
    res.json({ vnbs: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/resolve-vnb', async (req, res) => {
  try {
    const { plz } = req.body || {};
    if (!plz) return res.status(400).json({ error: 'plz fehlt' });
    const vnb = await resolveVnbAusPlz(plz);
    if (!vnb) return res.status(404).json({ error: `Kein VNB fuer PLZ ${plz} hinterlegt.` });
    res.json(vnb);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Holt die hinterlegten Tarife fuer (PLZ -> VNB) + Spannungsebene + Antragsjahr.
// Frontend nutzt das fuer Auto-Befuellung der 4 Tarif-Felder.
app.post('/api/get-tarife', async (req, res) => {
  try {
    const { plz, spannungsebene, antragsjahr } = req.body || {};
    if (!plz || !spannungsebene || !antragsjahr) {
      return res.status(400).json({ error: 'plz, spannungsebene und antragsjahr erforderlich' });
    }
    const vnb = await resolveVnbAusPlz(plz);
    if (!vnb) return res.status(404).json({ error: `Kein VNB fuer PLZ ${plz} hinterlegt.` });

    const tarifeDef = await ladeTarife(vnb.vnb_kurz, parseInt(antragsjahr, 10));
    if (!tarifeDef) {
      return res.json({ tarife: null, hinweis: `Keine Tarife fuer ${vnb.vnb_kurz} hinterlegt — bitte manuell aus Preisblatt eintragen.` });
    }
    const tarife = extrahiereTarifeFuerEbene(tarifeDef, spannungsebene);
    if (!tarife) {
      return res.json({
        tarife: null,
        hinweis: `Keine Tarife fuer ${vnb.vnb_kurz} / Spannungsebene ${spannungsebene} hinterlegt — bitte manuell eintragen.`,
        verfuegbare_ebenen: Object.keys(tarifeDef.spannungsebenen),
      });
    }
    res.json({ tarife, hinweis: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze', upload.single('lastgang'), async (req, res) => {
  const cleanupFiles = [];
  let analyseErfolgreich = false;
  try {
    if (!req.file) return res.status(400).json({ error: 'Lastgang-Datei fehlt (Feldname: lastgang).' });
    cleanupFiles.push(req.file.path);

    const stammdaten = JSON.parse(req.body.stammdaten || '{}');
    const {
      kunde, adresse, plz,
      spannungsebene,
      antragsjahr,
      bundesland: bundeslandManuell,
      leistungspreis_eur_pro_kw_a,
      einheit_override,           // 'kW' | 'kWh/15min' | 'kWh/30min' | undefined (=auto)
      weiterleitung_kwh,          // optional, default 0
      tarife,                     // { lt2500: {lp_eur_kwa, ap_ct_kwh}, ge2500: {...} }
    } = stammdaten;

    if (!plz) return res.status(400).json({ error: 'PLZ fehlt in Stammdaten.' });
    if (!spannungsebene) return res.status(400).json({ error: 'Spannungsebene fehlt.' });
    if (!antragsjahr) return res.status(400).json({ error: 'Antragsjahr fehlt.' });

    // VNB aus PLZ
    const vnb = await resolveVnbAusPlz(plz);
    if (!vnb) return res.status(400).json({ error: `Kein VNB fuer PLZ ${plz} hinterlegt.` });

    // HLZF laden
    const hlzfDef = await ladeHlzf(vnb.vnb_kurz, parseInt(antragsjahr, 10));

    // Lastgang parsen (mit optionalem Einheit-Override aus UI)
    const buffer = await fs.readFile(req.file.path);
    const parserResult = await parseLastgang(req.file.originalname, buffer, {
      einheitHint: einheit_override || 'auto',
    });

    // Atypizitaets-Pruefung
    const pruefung = pruefAtypizitaet({
      lastgang: parserResult,
      hlzfDefinition: hlzfDef,
      spannungsebene,
      bundesland: bundeslandManuell || vnb.bundesland,
      leistungspreisEurProKwa: leistungspreis_eur_pro_kw_a != null
        ? parseFloat(leistungspreis_eur_pro_kw_a)
        : null,
    });

    // Netzentgelt-Berechnung (wenn Tarife angegeben)
    let netzentgelt = null;
    if (tarife && (tarife.lt2500 || tarife.ge2500)
        && pruefung.kennzahlen && pruefung.kennzahlen.jhl_kw != null) {
      netzentgelt = berechneNetzentgelte({
        // Unverrundete Werte verwenden, damit die Netzentgelte 1:1 mit den
        // Kundenformeln uebereinstimmen (sonst kleinste Cent-Differenzen).
        pmax_kw: pruefung.kennzahlen.jhl_kw_raw,
        pmax_hlzf_kw: pruefung.kennzahlen.hlz_max_kw_raw,
        jahresarbeit_kwh: pruefung.kennzahlen.jahresenergie_kwh,
        tarif_lt2500: tarife.lt2500,
        tarif_ge2500: tarife.ge2500,
        weiterleitung_kwh: weiterleitung_kwh != null ? parseFloat(weiterleitung_kwh) : 0,
      });
    }

    // Report erzeugen
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const docxBuffer = await generateDocx(
      { ...stammdaten, vnb_name: vnb.vnb_name, bundesland: bundeslandManuell || vnb.bundesland },
      parserResult,
      pruefung,
      netzentgelt,
    );
    const docxPath = path.join(OUTPUT_DIR, `pruefbericht-${id}.docx`);
    await fs.writeFile(docxPath, docxBuffer);

    const summary = {
      id,
      stammdaten: { ...stammdaten, vnb_name: vnb.vnb_name, bundesland: bundeslandManuell || vnb.bundesland },
      vnb,
      hlzf_meta: {
        antragsjahr: hlzfDef.antragsjahr,
        quelle_url: hlzfDef.quelle_url,
        status: hlzfDef._meta?.status || 'OK',
        fallback: hlzfDef._fallback || null,
      },
      lastgang_meta: {
        zeitraum: parserResult.zeitraum,
        intervall_minuten: parserResult.intervall_minuten,
        einheit_quelle: parserResult.einheit_quelle,
        qualitaet: parserResult.qualitaet,
        quelle: parserResult.quelle,
      },
      pruefung,
      netzentgelt,
      report_path: `/api/report/${id}.docx`,
    };

    analysen.set(id, { summary, docxPath });
    analyseErfolgreich = true;
    res.json(summary);

  } catch (err) {
    console.error('Analyse-Fehler:', err);
    // Bei Fehlern Datei zum Debuggen behalten und Pfad melden
    const debugPath = req.file?.path
      ? path.relative(ROOT, req.file.path).replace(/\\/g, '/')
      : null;
    if (debugPath) {
      console.error(`  Upload behalten zum Debuggen: ${debugPath} (Originalname: ${req.file.originalname})`);
    }
    res.status(500).json({
      error: err.message,
      debug_pfad: debugPath,
      original_name: req.file?.originalname,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  } finally {
    // Upload-Datei nur bei Erfolg aufraeumen — bei Fehler bleibt sie liegen.
    if (analyseErfolgreich) {
      for (const f of cleanupFiles) {
        fs.unlink(f).catch(() => {});
      }
    }
  }
});

app.get('/api/report/:filename', async (req, res) => {
  const fname = path.basename(req.params.filename);
  const fpath = path.join(OUTPUT_DIR, fname);
  try {
    await fs.access(fpath);
    res.download(fpath);
  } catch {
    res.status(404).json({ error: 'Report nicht gefunden.' });
  }
});

app.get('/api/analyse/:id', (req, res) => {
  const entry = analysen.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Analyse nicht gefunden.' });
  res.json(entry.summary);
});

app.listen(PORT, () => {
  console.log(`Lastgang-Analyzer laeuft auf http://localhost:${PORT}`);
  console.log(`PWA: ${PWA_DIR}`);
  console.log(`Output: ${OUTPUT_DIR}`);
});
