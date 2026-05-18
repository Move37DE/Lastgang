import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { parseLastgang } from './lastgang-parser.js';
import { resolveVnbAusPlz, ladeHlzf, listeVerfuegbareVnbs } from './vnb-resolver.js';
import { pruefAtypizitaet } from './atypizitaet.js';
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

app.post('/api/analyze', upload.single('lastgang'), async (req, res) => {
  const cleanupFiles = [];
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
    } = stammdaten;

    if (!plz) return res.status(400).json({ error: 'PLZ fehlt in Stammdaten.' });
    if (!spannungsebene) return res.status(400).json({ error: 'Spannungsebene fehlt.' });
    if (!antragsjahr) return res.status(400).json({ error: 'Antragsjahr fehlt.' });

    // VNB aus PLZ
    const vnb = await resolveVnbAusPlz(plz);
    if (!vnb) return res.status(400).json({ error: `Kein VNB fuer PLZ ${plz} hinterlegt.` });

    // HLZF laden
    const hlzfDef = await ladeHlzf(vnb.vnb_kurz, parseInt(antragsjahr, 10));

    // Lastgang parsen
    const buffer = await fs.readFile(req.file.path);
    const parserResult = await parseLastgang(req.file.originalname, buffer);

    // Pruefung
    const pruefung = pruefAtypizitaet({
      lastgang: parserResult,
      hlzfDefinition: hlzfDef,
      spannungsebene,
      bundesland: bundeslandManuell || vnb.bundesland,
      leistungspreisEurProKwa: leistungspreis_eur_pro_kw_a != null
        ? parseFloat(leistungspreis_eur_pro_kw_a)
        : null,
    });

    // Report erzeugen
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const docxBuffer = await generateDocx(
      { ...stammdaten, vnb_name: vnb.vnb_name, bundesland: bundeslandManuell || vnb.bundesland },
      parserResult,
      pruefung,
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
      report_path: `/api/report/${id}.docx`,
    };

    analysen.set(id, { summary, docxPath });
    res.json(summary);

  } catch (err) {
    console.error('Analyse-Fehler:', err);
    res.status(500).json({ error: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  } finally {
    // Upload-Datei aufraeumen
    for (const f of cleanupFiles) {
      fs.unlink(f).catch(() => {});
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
