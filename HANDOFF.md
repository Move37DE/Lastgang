# Lastgang-Analyzer — Stand & Übergabe

**Stand:** 2026-05-18, erster Pilot lokal lauffähig, End-to-End-Test grün.

Dieses Dokument fasst zusammen, was bisher gebaut wurde, welche Entscheidungen wo verankert sind und welche Schritte als nächstes anstehen — damit eine neue Claude-Code-Session ohne Reibungsverluste weitermachen kann.

---

## Was die App macht

Webtool für die **Vorprüfung des Anspruchs auf individuelles Netzentgelt nach § 19 Abs. 2 Satz 1 StromNEV** (atypische Netznutzung).

**Eingabe:** RLM-Lastgang (XLSX/CSV, 15- oder 30-Minuten-Werte) + Stammdaten (PLZ, Spannungsebene, Antragsjahr, optional Leistungspreis).
**Verarbeitung:** PLZ → VNB → HLZF-Tabelle → Atypizitätsprüfung gegen BNetzA-Schwellen (BK4-13-739) → Bewertung.
**Ausgabe:** Strukturierter Pruefbericht als DOCX inkl. Stammdaten, Kennzahlen, Pruefkriterien (PASS/FAIL), saisonaler Auswertung, Wirtschaftlichkeitsschätzung, nächste Schritte.

**Pilotkunde:** Firma des Sohns des Auftraggebers — Energieberatung für Industriekunden.
**Pilot-VNB:** Netze BW (Baden-Württemberg).

---

## Aktueller Funktionsstand

✅ Vollständig implementiert und getestet:
- Parser für XLSX/CSV mit Auto-Erkennung von Zeitstempel- und Leistungsspalte, Einheit (kW vs. kWh/Intervall), Intervallbreite (15/30 Min)
- Feiertage je Bundesland (Spencer-Algorithmus für Ostern + alle abgeleiteten + bundeslandspezifische Feiertage)
- Brückentage-Logik (max. 1/Woche, gemäss BNetzA-Leitfaden)
- VNB-Resolver via PLZ-Bereiche (aktuell nur BW abgedeckt)
- Atypizitätsprüfung mit allen Kriterien:
  - Jahreshöchstlast (JHL) + Datum/Uhrzeit
  - HLZF-Höchstlast (HLZ-Max) — nur an HLZF-fähigen Werktagen
  - ΔP und Atypizitätsgrad
  - Erheblichkeitsschwellen je Spannungsebene
  - Mindestverlagerung 100 kW
  - Bagatellgrenze 500 €/a (wenn Leistungspreis bekannt)
  - Saisonale Konsistenz (Vorhersehbarkeit)
- DOCX-Report-Generator mit Stammdaten, Kennzahlen-Tabelle, Pruefkriterien, saisonaler Auswertung, Wirtschaftlichkeitsteil, nächsten Schritten, Haftungsausschluss
- Express-Server mit Upload-Endpoint, VNB-Lookup, Report-Download
- PWA-Frontend mit 4 Screens (Stammdaten / Upload / Progress / Report)
- Dockerfile + ausführliche Azure-Container-Apps-Deploy-Anleitung

⚠ Bekannte Lücken / bewusste Vereinfachungen:
- **PLZ-Mapping** deckt nur Baden-Württemberg ab (zwei PLZ-Bereiche: 70000–79999, 88000–88999). Realität: lokale Stadtwerke (z.B. SWS Stuttgart) können innerhalb dieser Bereiche eigene Konzessionen haben. Phase 2: Vollständige Auflösung via Marktstammdatenregister.
- **Nur ein VNB hinterlegt** (Netze BW 2026). Weitere VNBs werden über Eintrag eines JSON in `backend/data/vnb-hlzf/` ergänzt — keine Code-Änderung nötig.
- **In-Memory-Speicher** für abgeschlossene Analysen (Map). Bei Server-Restart sind sie weg. DOCX-Dateien bleiben aber auf Platte.
- **Keine Authentifizierung.** Für lokalen Test OK. Für Azure-Produktion: Container-Apps-Built-in-Auth mit Microsoft Entra ID (Anleitung in `AZURE_DEPLOY.md` skizziert).
- **Keine Charts/Visualisierung** des Lastgangs im Report. Phase 2 mit Chart.js + Puppeteer-PNG-Einbettung.
- **Saisonale Vorhersehbarkeitsprüfung** verwendet die Heuristik „JHL liegt in mind. 2 von 4 Jahreszeiten ausserhalb HLZF" — das ist eine Auslegung, kein wörtlicher Gesetzestext. Vor produktivem Einsatz mit Juristen abstimmen.

---

## Verifizierte Datenquellen

| Datenquelle | Status | URL/Referenz |
|---|---|---|
| HLZF Netze BW 2026 (alle 5 Spannungsebenen) | ✅ VERIFIED aus offiziellem PDF, visuell geprüft | [Netze BW: Regelungen für die Nutzung des Stromverteilnetzes, gültig ab 1. Januar 2026, Stand 12.12.2025](https://assets.cdn.netze-bw.de/xytfb1vrn7of/2xbvzba27IJwe250rd5DmE/f7821823df3bf261de1e55a472b35db2/regelungen-fuer-die-nutzung-des-stromverteilnetzes-2026.pdf) |
| BNetzA-Festlegung BK4-13-739 (Erheblichkeitsschwellen) | im Code als Konstante (`atypizitaet.js`) | BNetzA-Veröffentlichung |
| Feiertage je Bundesland | im Code berechnet, abgeglichen mit feiertage.de | — |
| PLZ-Bereich-Mapping | nur BW (heuristisch) | manuell gepflegt |

**Wichtig:** Höchstspannung (380/220 kV) ist bei Netze BW **nicht** abgedeckt — dafür ist TransnetBW (ÜNB) zuständig. Bei einem HS-Anschluss ausgeben oder explizit hinweisen.

---

## Projektstruktur

```
c:\dev\lastgang-analyzer\
├── HANDOFF.md                    ← dieses Dokument
├── README.md                     ← Quickstart
├── AZURE_DEPLOY.md               ← Azure Container Apps Anleitung
├── Dockerfile
├── .dockerignore
├── .gitignore
├── .env.example
├── backend/
│   ├── server.js                 ← Express, Endpoints, Pipeline
│   ├── lastgang-parser.js        ← XLSX/CSV → normalisierter Lastgang
│   ├── feiertage.js              ← Bundesland-Feiertage + Brückentage
│   ├── vnb-resolver.js           ← PLZ → VNB + HLZF laden
│   ├── atypizitaet.js            ← Kernlogik (JHL, HLZ-Max, ΔP, Schwellen)
│   ├── report-generator.js       ← DOCX-Export
│   ├── package.json
│   ├── data/
│   │   ├── plz-vnb.json
│   │   └── vnb-hlzf/
│   │       └── netze-bw-2026.json    ← VERIFIED, mit Quelle-URL
│   └── scripts/
│       └── generate-test-lastgang.js ← Synthetischer Lastgang
└── pwa/
    ├── index.html                ← 4-Screen-UI
    ├── app.js                    ← Client-Logik
    ├── manifest.json
    └── sw.js
```

---

## Schnellstart (frische Session, frischer Clone)

```bash
git clone <repo-url> lastgang-analyzer
cd lastgang-analyzer
cp .env.example .env

cd backend
npm install
node scripts/generate-test-lastgang.js   # erzeugt Test-Lastgang in data/test/
node server.js
# → http://localhost:3002
```

Im Browser:
1. PLZ 70173 eingeben → VNB-Auflösung sollte „Netze BW GmbH" zeigen
2. Spannungsebene MS, Antragsjahr 2026
3. Test-Datei `data/test/test-lastgang-2025.xlsx` hochladen
4. Erwartetes Ergebnis: **ANSPRUCH GEGEBEN**, Atypizitätsgrad ~70 %, ΔP ~1020 kW

End-to-End-Test via curl:
```bash
curl -X POST http://localhost:3002/api/analyze \
  -F "lastgang=@data/test/test-lastgang-2025.xlsx" \
  -F 'stammdaten={"kunde":"Test","plz":"70173","spannungsebene":"MS","antragsjahr":2026,"leistungspreis_eur_pro_kw_a":120}'
```

---

## Wichtige Design-Entscheidungen (zum Verständnis)

1. **Deterministischer Rechenkern, kein LLM in der Hot Path.** Die Atypizitätsprüfung ist pure Arithmetik und transparent nachvollziehbar — wichtig für juristisch belastbare Vorprüfung. LLMs werden bisher nur für HLZF-PDF-Recherche genutzt (Schritt mit Mensch-in-the-Loop, Ergebnis wandert manuell in JSON).
2. **VNB-HLZF als JSON-Stammdaten, nicht im Code.** Erlaubt Pflege ohne Code-Änderung. Datei-Naming-Konvention: `{vnb_kurz}-{jahr}.json`. Resolver fällt bei fehlendem Jahr auf Vorjahr zurück und kennzeichnet das im Report.
3. **Single-Tenant, file-in/report-out.** Keine DB in Phase 1. Reports persistieren im `output/`-Verzeichnis (bei Azure auf Azure Files mounten für Persistenz).
4. **Architektur-Vorbild BauDiktat.** Bewusst gleicher Stack (Node.js + Express + Vanilla-PWA + Container App), damit Deploy + Wartung vertraut sind.
5. **Dezimaltrennzeichen-tolerant.** Parser erkennt deutsche („1.234,56") und englische Zahlenformate automatisch — wichtig, weil VNB-XLSX-Exporte beides haben.
6. **HLZF-Intervall-Konvention:** „von 08:00 bis 11:00" interpretiert als [08:00, 11:00), also Beginn inklusiv, Ende exklusiv. Wenn ein Wert exakt um 11:00 liegt, gehört er nicht mehr ins Fenster. Konsistent mit gängiger Interpretation, aber bei Grenzfällen mit dem konkreten VNB-Wording abgleichen.

---

## Konkrete TODOs für die nächste Session

**Sofort, wenn echte Lastgang-Datei vorliegt:**
1. Datei nach `data/test/` legen, durch Pipeline jagen
2. Parser-Heuristik prüfen — typische Abweichungen: Header-Zeilen mit Metadaten, deutsche Datumsformate mit Sekunden, kWh-statt-kW-Spalten, MSCONS-Export aus Energiedatenmanagement-Systemen
3. Falls Parser-Anpassung nötig: `lastgang-parser.js`, Methoden `detectColumns` und `parseTimestamp` sind die Eingriffsstellen

**Phase 1.5 (Funktionsverfeinerung):**
- TransnetBW-HLZF einpflegen (für HS-Anschlüsse in BW)
- PDF-Export zusätzlich zu DOCX (`puppeteer` aus HTML-Report)
- Lastgang-Visualisierung im Report (Chart.js + Render zu PNG)
- Validierung: Was tun bei Lastgängen, die nicht das volle Kalenderjahr abdecken?
- Zeitzone explizit machen (aktuell wird alles als UTC gerechnet; Sommer-/Winterzeit-Umstellung kann zu Lücken/Doppelungen führen)

**Phase 2 (Multi-Tenant + Produktiv):**
- Weitere VNB einpflegen (Bayernwerk, Westnetz, EWE, Stadtwerke-Konsortien)
- Vollständiges PLZ→VNB-Mapping über Marktstammdatenregister
- Auth (Microsoft Entra ID via Container Apps)
- PostgreSQL für Pruefungshistorie
- Mandantenfähigkeit (mehrere Beratungsfirmen)

**Deployment:**
- Azure-Subscription der Firma identifizieren
- `AZURE_DEPLOY.md` durchgehen, Container in Azure Container Apps deployen
- Custom Domain + TLS

---

## Test-Ergebnis vom 2026-05-18 (Pilotlauf)

Eingabe: synthetischer Lastgang 2025 mit absichtlich gesetzter atypischer Spitze:
- 35.040 × 15-Min-Werte (Vollständigkeit 100 %)
- Jahresspitze: 1450 kW am 15.01.2025 03:00 Uhr (nachts, ausserhalb HLZF)
- Lastreduktion in Winter-HLZF-Fenstern (Mo–Fr 07:00–14:00, 16:45–19:45) auf ~250–430 kW

Ergebnis: **ANSPRUCH_GEGEBEN**
- JHL: 1450 kW · HLZ-Max: 430 kW · ΔP: 1020 kW
- Atypizitätsgrad: 70,3 % (Schwelle MS: 20 %)
- Vorhersehbarkeit: 4/4 Jahreszeiten atypisch
- Potenzielle Ersparnis: ~122.400 €/Jahr (bei 120 €/kW/Jahr)
- DOCX-Pruefbericht: 11,3 KB, alle Sektionen befüllt

---

## Memory-Hinweis

Wenn in einer neuen Claude-Code-Session mit diesem Repo gestartet wird:
- User-Kontext: Sohn arbeitet bei Energieberatungs-Firma (Pilotkunde)
- Sister-Projekt: `BauDiktat` (gleicher Stack, gleicher Deploy-Pattern)
- Beide Projekte werden vom selben User parallel weiterentwickelt

Diese Memory-Einträge wurden im BauDiktat-Worktree-Memory abgelegt:
`C:\Users\TiloSchlumberger\.claude\projects\c--dev-baudiktat--claude-worktrees-optimistic-williamson-ecfe67\memory\`
- `user_son_energy_consulting.md`
- `project_lastgang_analyzer.md`

In einer neuen Session, die direkt aus `c:\dev\lastgang-analyzer` gestartet wird, sind diese Memories nicht automatisch sichtbar — bei Bedarf in das neue Projekt-Memory-Verzeichnis kopieren.
