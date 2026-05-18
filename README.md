# Lastgang-Analyzer

Pruefung des Anspruchs auf individuelles Netzentgelt nach **§ 19 Abs. 2 Satz 1 StromNEV** (atypische Netznutzung).

Datei rein (RLM-Lastgang als Excel/CSV) + Adresse rein → automatische Pruefung gegen die Hochlastzeitfenster (HLZF) des zustaendigen Verteilnetzbetreibers → Report (DOCX/PDF) raus.

---

## Voraussetzungen

- Node.js 20+
- Browser fuer das PWA-Frontend
- Fuer Deployment: Docker + Azure CLI (Azure Container Apps)

---

## Projektstruktur

```
lastgang-analyzer/
  backend/
    server.js              - Express, Upload, Pipeline-Orchestrierung
    lastgang-parser.js     - XLSX/CSV -> normalisierter Lastgang
    vnb-resolver.js        - PLZ -> VNB-Mapping, HLZF-Lookup
    atypizitaet.js         - Kernlogik (JHL, HLZ-Max, DeltaP, Schwellen)
    feiertage.js           - Bundesland-spezifische Feiertage + Brueckentage
    report-generator.js    - DOCX/PDF-Export
    data/
      vnb-hlzf/            - HLZF-Stammdaten pro VNB + Jahr (JSON)
      plz-vnb.json         - PLZ -> VNB-Mapping
      feiertage-bl.json    - Feiertage je Bundesland
  pwa/
    index.html             - 4-Screen-UI
    app.js                 - Drag&Drop, SSE-Fortschritt, Report-Anzeige
    sw.js                  - Service Worker (PWA-Installierbarkeit)
    manifest.json
  output/                  - Generierte Reports (gitignored)
  uploads/                 - Temporaere Uploads (gitignored)
  Dockerfile
  .env.example
  README.md
```

---

## Installation & Start (lokal)

```bash
cp .env.example .env
cd backend
npm install
npm start
# -> http://localhost:3002
```

PWA wird automatisch aus `../pwa/` ausgeliefert.

---

## Architektur

```
Browser (PWA)                        Node.js Backend
---------------                      ---------------
Drag & Drop Lastgang-XLSX  ----->    POST /api/analyze
+ Stammdaten (JSON)                       |
                                          v
                                     1. Excel parsen, validieren
                                     2. VNB aus PLZ ermitteln
                                     3. HLZF nachschlagen
                                     4. Feiertage/Brueckentage berechnen
                                     5. Atypizitaetspruefung
                                     6. Report generieren (DOCX/PDF)
                                          |
GET /api/report/:id        <-----    Download-Link
```

---

## Rechtlicher Hintergrund

- Rechtsgrundlage: **§ 19 Abs. 2 Satz 1 StromNEV** i.V.m. BNetzA-Festlegung **BK4-13-739**
- Antragsfristen: Anzeige bei der BNetzA bis **30.09.** des Antragsjahres, Jahresnachweis bis **30.06.** des Folgejahres
- Auslauf der Regelung: **31.12.2028** (Nachfolger: AgNes, BNetzA GBK-25-01-1#3)

---

## Pilot-VNB

Phase 1 unterstuetzt **Netze BW GmbH** (Baden-Wuerttemberg). Weitere VNB werden ueber Eintraege in `backend/data/vnb-hlzf/` ergaenzt — keine Code-Aenderung noetig.

---

## Datenschutz

- Lastgangdaten werden nur fuer die Analyse temporaer hochgeladen, nach Report-Generierung geloescht
- Keine Weitergabe an Dritte
- Reports liegen lokal im `output/`-Verzeichnis (gitignored)
