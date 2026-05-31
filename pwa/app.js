// Lastgang-Analyzer PWA — Client-Logik

const screens = {
  stamm: document.getElementById('screen-stamm'),
  upload: document.getElementById('screen-upload'),
  progress: document.getElementById('screen-progress'),
  report: document.getElementById('screen-report'),
};

function showScreen(name) {
  for (const [n, el] of Object.entries(screens)) {
    el.classList.toggle('active', n === name);
  }
  window.scrollTo(0, 0);
}

// --- Screen 1: Stammdaten ---

const plzInput = document.getElementById('plz');
const vnbInfoBox = document.getElementById('vnb-info');
let resolvedVnb = null;

plzInput.addEventListener('blur', async () => {
  const plz = plzInput.value.trim();
  vnbInfoBox.style.display = 'none';
  resolvedVnb = null;
  if (!/^\d{5}$/.test(plz)) return;
  try {
    const res = await fetch('/api/resolve-vnb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plz }),
    });
    const data = await res.json();
    if (!res.ok) {
      vnbInfoBox.innerHTML = `<strong>⚠ PLZ ${plz} nicht hinterlegt.</strong><span class="muted">${data.error || ''}</span>`;
      vnbInfoBox.style.display = 'block';
      return;
    }
    resolvedVnb = data;
    vnbInfoBox.innerHTML = `
      <strong>VNB:</strong> ${data.vnb_name} <span class="muted">(Bundesland: ${data.bundesland})</span>
      ${data.kommentar ? `<span class="muted">${data.kommentar}</span>` : ''}
    `;
    vnbInfoBox.style.display = 'block';
  } catch (err) {
    vnbInfoBox.innerHTML = `<strong>Fehler beim VNB-Lookup:</strong> ${err.message}`;
    vnbInfoBox.style.display = 'block';
  }
});

// Auto-Befuellung der Tarife: wenn PLZ + Spannungsebene + Antragsjahr gesetzt sind,
// versuche Tarife aus VNB-Datenbank zu ziehen.
async function maybeAutoFillTarife() {
  const plz = plzInput.value.trim();
  const spannungsebene = document.getElementById('spannungsebene').value;
  const antragsjahr = document.getElementById('antragsjahr').value;
  if (!/^\d{5}$/.test(plz) || !spannungsebene || !antragsjahr) return;

  try {
    const res = await fetch('/api/get-tarife', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plz, spannungsebene, antragsjahr }),
    });
    const data = await res.json();
    const hint = document.getElementById('tarif-hinweis');

    if (data.tarife) {
      const lt = data.tarife.lt2500;
      const ge = data.tarife.ge2500;
      // Nur befuellen wenn Feld leer ist (User-Eingaben nicht ueberschreiben)
      if (lt) {
        if (!document.getElementById('tarif-lt2500-lp').value) document.getElementById('tarif-lt2500-lp').value = lt.lp_eur_kwa;
        if (!document.getElementById('tarif-lt2500-ap').value) document.getElementById('tarif-lt2500-ap').value = lt.ap_ct_kwh;
      }
      if (ge) {
        if (!document.getElementById('tarif-ge2500-lp').value) document.getElementById('tarif-ge2500-lp').value = ge.lp_eur_kwa;
        if (!document.getElementById('tarif-ge2500-ap').value) document.getElementById('tarif-ge2500-ap').value = ge.ap_ct_kwh;
      }
      const teilweise = !lt || !ge;
      const statusBadge = data.tarife.quelle.status === 'VERIFIED' ? '✓ verifiziert'
                       : data.tarife.quelle.status === 'TEILWEISE_VERIFIED' ? '⚠ teilweise verifiziert'
                       : '⚠ Platzhalter';
      hint.innerHTML = `<div class="vnb-info">Tarife automatisch befuellt aus ${data.tarife.quelle.vnb} (${data.tarife.quelle.antragsjahr}) — ${statusBadge}${teilweise ? '. Eine Tarifvariante fehlt — bitte aus Preisblatt ergaenzen.' : '. Werte koennen ueberschrieben werden.'}</div>`;
      hint.style.display = 'block';
    } else if (data.hinweis) {
      hint.innerHTML = `<div class="info-box" style="font-size:0.85rem">${data.hinweis}</div>`;
      hint.style.display = 'block';
    }
  } catch {
    // schweigend: Tarif-Lookup ist optional
  }
}

document.getElementById('spannungsebene').addEventListener('change', maybeAutoFillTarife);
document.getElementById('antragsjahr').addEventListener('change', maybeAutoFillTarife);
plzInput.addEventListener('blur', maybeAutoFillTarife);

document.getElementById('btn-zu-upload').addEventListener('click', () => {
  if (!plzInput.value.trim() || !document.getElementById('spannungsebene').value) {
    alert('Bitte mindestens PLZ und Spannungsebene angeben.');
    return;
  }
  showScreen('upload');
});

// --- Screen 2: Upload ---

const dropzone = document.getElementById('dropzone');
const dropzoneText = document.getElementById('dropzone-text');
const fileInput = document.getElementById('file-input');
const btnAnalyseStart = document.getElementById('btn-analyse-start');
let chosenFile = null;

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
  if (e.dataTransfer.files.length > 0) setFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) setFile(e.target.files[0]);
});

function setFile(file) {
  chosenFile = file;
  dropzone.classList.add('has-file');
  dropzoneText.innerHTML = `
    <div class="icon">✓</div>
    <div class="filename">${file.name}</div>
    <small style="color:var(--muted)">${(file.size / 1024).toFixed(1)} KB — Klicken zum Wechseln</small>
  `;
  btnAnalyseStart.disabled = false;
}

document.getElementById('btn-zurueck-1').addEventListener('click', () => showScreen('stamm'));

btnAnalyseStart.addEventListener('click', startAnalyse);

// --- Screen 3: Progress ---

function setStep(stepNum, status) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    el.classList.remove('active', 'done');
    if (i < stepNum) el.classList.add('done');
    else if (i === stepNum) el.classList.add(status === 'done' ? 'done' : 'active');
  }
  const pct = stepNum === 4 && status === 'done' ? 100 : (stepNum - 1) * 25 + 12;
  document.getElementById('progress-bar').style.width = `${pct}%`;
}

async function startAnalyse() {
  showScreen('progress');
  document.getElementById('progress-error').innerHTML = '';
  setStep(1, 'active');

  const adresseTeile = [
    document.getElementById('strasse').value.trim(),
    `${document.getElementById('plz').value.trim()} ${document.getElementById('ort').value.trim()}`.trim(),
  ].filter(Boolean);

  // Tarife einsammeln — nur uebergeben wenn alle 4 Werte gesetzt sind oder mind. eine Variante komplett
  const lpLt = parseFloat(document.getElementById('tarif-lt2500-lp').value);
  const apLt = parseFloat(document.getElementById('tarif-lt2500-ap').value);
  const lpGe = parseFloat(document.getElementById('tarif-ge2500-lp').value);
  const apGe = parseFloat(document.getElementById('tarif-ge2500-ap').value);
  const tarife = {};
  if (Number.isFinite(lpLt) && Number.isFinite(apLt)) tarife.lt2500 = { lp_eur_kwa: lpLt, ap_ct_kwh: apLt };
  if (Number.isFinite(lpGe) && Number.isFinite(apGe)) tarife.ge2500 = { lp_eur_kwa: lpGe, ap_ct_kwh: apGe };

  const weiterleitung = parseFloat(document.getElementById('weiterleitung').value);

  const stammdaten = {
    kunde: document.getElementById('kunde').value.trim() || null,
    adresse: adresseTeile.join(', ') || null,
    strasse: document.getElementById('strasse').value.trim() || null,
    plz: document.getElementById('plz').value.trim(),
    ort: document.getElementById('ort').value.trim() || null,
    spannungsebene: document.getElementById('spannungsebene').value,
    antragsjahr: parseInt(document.getElementById('antragsjahr').value, 10),
    bundesland: document.getElementById('bundesland-override').value || null,
    einheit_override: document.getElementById('einheit-override').value || null,
    weiterleitung_kwh: Number.isFinite(weiterleitung) ? weiterleitung : null,
    tarife: Object.keys(tarife).length > 0 ? tarife : null,
  };

  const formData = new FormData();
  formData.append('lastgang', chosenFile);
  formData.append('stammdaten', JSON.stringify(stammdaten));

  // Optische Step-Simulation (echte Backend-Pipeline ist atomar)
  setTimeout(() => setStep(2, 'active'), 400);
  setTimeout(() => setStep(3, 'active'), 1200);
  setTimeout(() => setStep(4, 'active'), 2000);

  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setStep(4, 'done');
    setTimeout(() => renderReport(data), 300);
  } catch (err) {
    document.getElementById('progress-error').innerHTML = `
      <div class="error-box"><strong>Analyse fehlgeschlagen:</strong><br>${err.message}</div>
      <button class="secondary" onclick="showScreen('upload')">← Zurueck</button>
    `;
    document.getElementById('progress-bar').style.width = '0%';
  }
}

// --- Screen 4: Report ---

const ERGEBNIS_LABEL = {
  'ANSPRUCH_GEGEBEN': { txt: '✓ Anspruch gegeben', cls: 'pass' },
  'GRENZFALL_MANUELLE_PRUEFUNG': { txt: '⚠ Grenzfall — manuelle Pruefung empfohlen', cls: 'warn' },
  'KEIN_ANSPRUCH': { txt: '✗ Kein Anspruch', cls: 'fail' },
  'FEHLER': { txt: 'Fehler bei der Pruefung', cls: 'fail' },
};

function dt(value) {
  if (!value) return '—';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function row(label, value, opts = {}) {
  const td = opts.num ? '<td class="num">' : '<td>';
  return `<tr><th>${label}</th>${td}${value ?? '—'}</td></tr>`;
}

function renderReport(data) {
  const p = data.pruefung;
  const lbl = ERGEBNIS_LABEL[p.ergebnis] || { txt: p.ergebnis, cls: 'warn' };
  const banner = document.getElementById('result-banner');
  banner.textContent = lbl.txt;
  banner.className = `result-banner ${lbl.cls}`;

  // HLZF-Warnung wenn Platzhalter
  const hlzfWarn = document.getElementById('hlzf-warning');
  if (data.hlzf_meta?.status === 'PLATZHALTER') {
    hlzfWarn.innerHTML = `<div class="info-box">⚠ Die verwendeten HLZF-Daten fuer ${data.vnb.vnb_name} sind Platzhalter. Vor jeder formalen Antragstellung muessen sie mit der offiziellen Veroeffentlichung des Netzbetreibers abgeglichen werden.</div>`;
  } else {
    hlzfWarn.innerHTML = '';
  }
  if (data.hlzf_meta?.fallback) {
    hlzfWarn.innerHTML += `<div class="info-box">ℹ ${data.hlzf_meta.fallback}</div>`;
  }

  // Stammdaten-Tabelle
  document.getElementById('tab-stamm').innerHTML = `
    ${row('Kunde / Anlage', data.stammdaten.kunde)}
    ${row('Adresse', data.stammdaten.adresse)}
    ${row('Verteilnetzbetreiber', data.vnb?.vnb_name)}
    ${row('Spannungsebene', data.stammdaten.spannungsebene)}
    ${row('Bundesland', data.stammdaten.bundesland)}
    ${row('Antragsjahr', data.stammdaten.antragsjahr)}
  `;

  // Kennzahlen
  const k = p.kennzahlen || {};
  document.getElementById('tab-kennzahlen').innerHTML = `
    ${row('Auswertungszeitraum', `${dt(data.lastgang_meta.zeitraum?.von)} — ${dt(data.lastgang_meta.zeitraum?.bis)}`)}
    ${row('Datenvollstaendigkeit', `${data.lastgang_meta.qualitaet?.vollstaendigkeit_prozent} %`, { num: true })}
    ${row('Intervall', `${data.lastgang_meta.intervall_minuten} Minuten`)}
    ${row('Quelleinheit', data.lastgang_meta.einheit_quelle)}
    ${row('Jahresenergie', `${k.jahresenergie_mwh} MWh`, { num: true })}
    ${row('Jahreshoechstlast (JHL)', `${k.jhl_kw} kW am ${dt(k.jhl_ts)}`, { num: true })}
    ${row('Vollbenutzungsstunden', `${k.vollbenutzungsstunden} h`, { num: true })}
    ${row('Hoechstlast in HLZF', `${k.hlz_max_kw} kW am ${dt(k.hlz_max_ts)}`, { num: true })}
    ${row('Differenzleistung ΔP', `<strong>${k.delta_p_kw} kW</strong>`, { num: true })}
    ${row('Atypizitaetsgrad', `<strong>${k.atypizitaetsgrad_prozent} %</strong>`, { num: true })}
  `;

  // Schwellen
  const schwRows = [
    '<tr><th>Kriterium</th><th>Ist-Wert</th><th>Anforderung</th><th>Status</th></tr>',
    ...(p.schwellen || []).map(s => `
      <tr>
        <td>${s.name}</td>
        <td class="num">${s.ist} ${s.einheit}</td>
        <td class="num">≥ ${s.mindest} ${s.einheit}</td>
        <td><span class="badge ${s.status.toLowerCase()}">${s.status}</span></td>
      </tr>
    `),
  ];
  if (p.vorhersehbarkeit) {
    const v = p.vorhersehbarkeit;
    schwRows.push(`
      <tr>
        <td>${v.name}</td>
        <td class="num">${v.ist} ${v.einheit}</td>
        <td class="num">≥ ${v.mindest} ${v.einheit}</td>
        <td><span class="badge ${v.status.toLowerCase()}">${v.status}</span></td>
      </tr>
    `);
  }
  document.getElementById('tab-schwellen').innerHTML = schwRows.join('');

  // Saisonal
  const sRows = [
    '<tr><th>Jahreszeit</th><th>JHL (kW)</th><th>HLZF-Max (kW)</th><th>HLZF-Stunden</th><th>JHL ausserhalb HLZF?</th></tr>',
    ...(p.saisonal || []).map(s => `
      <tr>
        <td>${s.jahreszeit}</td>
        <td class="num">${s.jhl_kw ?? '—'}</td>
        <td class="num">${s.hlzf_max_kw ?? '—'}</td>
        <td class="num">${s.hlzf_stunden}</td>
        <td><span class="badge ${s.jhl_ausserhalb_hlzf ? 'pass' : 'fail'}">${s.jhl_ausserhalb_hlzf ? 'JA' : 'NEIN'}</span></td>
      </tr>
    `),
  ];
  document.getElementById('tab-saison').innerHTML = sRows.join('');

  // HLZF-Lastspitzen + Top-Überschreitungen
  const lastspitzen = p.hlzf_lastspitzen;
  if (lastspitzen) {
    document.getElementById('hlzf-lastspitzen-meta').innerHTML = `
      Erheblichkeitsschwelle: <strong>${lastspitzen.erheblichkeitsschwelle_kw} kW</strong>
      (= Pmax × (1 − Atypizitäts-Schwelle der Spannungsebene))
    `;

    // Top HLZF-Spitzen
    document.getElementById('hlzf-spitzen-info').innerHTML = `
      Anzahl HLZF-Intervalle: <strong>${lastspitzen.anzahl_hlzf_intervalle}</strong>
      · davon ueber Schwelle (= kritisch fuer den Antrag):
      <strong style="color:${lastspitzen.anzahl_ueberschreitungen_in_hlzf > 0 ? 'var(--danger)' : 'var(--accent)'}">${lastspitzen.anzahl_ueberschreitungen_in_hlzf}</strong>
    `;
    if (lastspitzen.top_hlzf_intervalle?.length) {
      const rows = ['<tr><th>#</th><th>Datum / Uhrzeit</th><th>Jahreszeit</th><th>Leistung (kW)</th><th>Δ zur Schwelle</th><th>Status</th></tr>'];
      lastspitzen.top_hlzf_intervalle.forEach((iv, i) => {
        const ueber = iv.ueber_erheblichkeitsschwelle;
        rows.push(`
          <tr>
            <td class="num">${i + 1}</td>
            <td>${dt(iv.ts)}</td>
            <td>${iv.jahreszeit}</td>
            <td class="num"><strong>${iv.leistung_kw}</strong></td>
            <td class="num">${ueber ? '+' : ''}${iv.ueberschreitung_kw} kW</td>
            <td><span class="badge ${ueber ? 'fail' : 'pass'}">${ueber ? '⚠ kritisch' : '✓ unter'}</span></td>
          </tr>
        `);
      });
      document.getElementById('tab-hlzf-spitzen').innerHTML = rows.join('');
    } else {
      document.getElementById('tab-hlzf-spitzen').innerHTML = '<tr><td colspan="6" style="color:var(--muted)"><em>Keine HLZF-Intervalle im Auswertungszeitraum.</em></td></tr>';
    }

    // Top-Überschreitungen gesamt (analog Berater-Excel)
    document.getElementById('gesamt-ueb-info').innerHTML = `
      Werte ueber der Erheblichkeitsschwelle im gesamten Jahr (inkl. ausserhalb HLZF, entspricht der Berater-Vorlage).
      Anzahl gesamt: <strong>${lastspitzen.anzahl_ueberschreitungen_gesamt}</strong>
    `;
    if (lastspitzen.top_ueberschreitungen_gesamt?.length) {
      const rows = ['<tr><th>#</th><th>Datum / Uhrzeit</th><th>Leistung (kW)</th><th>Über Schwelle</th></tr>'];
      lastspitzen.top_ueberschreitungen_gesamt.forEach((iv, i) => {
        rows.push(`
          <tr>
            <td class="num">${i + 1}</td>
            <td>${dt(iv.ts)}</td>
            <td class="num"><strong>${iv.leistung_kw}</strong></td>
            <td class="num">+${iv.ueberschreitung_kw} kW (+${iv.ueberschreitung_prozent} %)</td>
          </tr>
        `);
      });
      document.getElementById('tab-gesamt-ueb').innerHTML = rows.join('');
    } else {
      document.getElementById('tab-gesamt-ueb').innerHTML = '<tr><td colspan="4" style="color:var(--muted)"><em>Keine Werte ueber der Erheblichkeitsschwelle im Jahr.</em></td></tr>';
    }
  }

  // Wirtschaftlichkeit
  const w = p.wirtschaftlichkeit || {};
  let wirtHtml = '';
  if (w.potenzielle_ersparnis_eur != null) {
    wirtHtml = `
      <p style="font-size:1.2rem;font-weight:600;">Potenzielle Ersparnis: ${w.potenzielle_ersparnis_eur.toLocaleString('de-DE')} EUR/Jahr</p>
      <p style="color:var(--muted)">bei Leistungspreis ${w.leistungspreis_eur_pro_kw_a} EUR/kW/Jahr</p>
    `;
  } else {
    wirtHtml = `
      <p style="font-size:1.1rem;font-weight:600;">Potenzielle Ersparnis (Bandbreite): ${(w.potenzielle_ersparnis_eur_min || 0).toLocaleString('de-DE')} — ${(w.potenzielle_ersparnis_eur_max || 0).toLocaleString('de-DE')} EUR/Jahr</p>
      <p style="color:var(--muted)">${w.hinweis || ''}</p>
    `;
  }
  document.getElementById('wirt-box').innerHTML = wirtHtml;

  // Netzentgelt-Vergleich rendern (wenn Tarife gegeben)
  const neSection = document.getElementById('netzentgelt-section');
  if (data.netzentgelt && data.netzentgelt.tarife) {
    const ne = data.netzentgelt;
    const e = ne.eingaben;
    document.getElementById('netzentgelt-eingaben').innerHTML = `
      Pmax: <strong>${e.pmax_kw} kW</strong> ·
      Pmax in HLZF: <strong>${e.pmax_hlzf_kw} kW</strong> ·
      Jahresarbeit: <strong>${(e.jahresarbeit_netto_kwh / 1000).toFixed(0)} MWh</strong> ·
      VBh: <strong>${e.vollbenutzungsstunden} h</strong>
    `;

    const eur = (n) => n == null ? '—' : n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    const neRows = ['<tr><th>Tarif</th><th>LP</th><th>AP</th><th>Allgemein</th><th>Individuell</th><th>Reduktion / Jahr</th></tr>'];
    for (const [key, t] of Object.entries(ne.tarife)) {
      if (!t) continue;
      const label = key === 'lt2500' ? '< 2.500 h' : '≥ 2.500 h';
      const ist = key === ne.tarif_zugeordnet;
      neRows.push(`
        <tr style="${ist ? 'background:#f0f8f3;font-weight:600;' : ''}">
          <td>${label}${ist ? ' <span class="badge pass">zugeordnet</span>' : ''}</td>
          <td class="num">${t.lp_eur_kwa} €/kW/a</td>
          <td class="num">${t.ap_ct_kwh} ct/kWh</td>
          <td class="num">${eur(t.allgemein_eur)}</td>
          <td class="num">${eur(t.individuell_effektiv_eur)}</td>
          <td class="num" style="color:${ist ? '#107c10' : 'inherit'};font-weight:600">${eur(t.reduktion_effektiv_eur)}</td>
        </tr>
      `);
    }
    document.getElementById('tab-netzentgelt').innerHTML = neRows.join('');

    const hinweise = [];
    const best = ne.tarife[ne.bester_tarif];
    if (best) {
      hinweise.push(`<div class="result-banner pass" style="font-size:1.1rem;padding:0.8rem;">Bester Tarif: <strong>${ne.bester_tarif === 'lt2500' ? '< 2.500 h' : '≥ 2.500 h'}</strong> — Ersparnis ca. <strong>${eur(best.reduktion_effektiv_eur)} / Jahr</strong></div>`);
    }
    if (ne.wahloption_empfohlen) {
      hinweise.push(`<div class="info-box">💡 Wahloption empfohlen: Bei &lt; 2.500 h Vollbenutzung kann der Kunde freiwillig den ≥ 2.500 h Tarif waehlen und damit eine hoehere Reduktion erzielen.</div>`);
    }
    for (const [key, t] of Object.entries(ne.tarife)) {
      if (!t) continue;
      if (!t.pruefung.bagatelle_erfuellt) {
        hinweise.push(`<div class="error-box">⚠ Tarif ${key === 'lt2500' ? '< 2.500 h' : '≥ 2.500 h'}: Reduktion unter Bagatellgrenze ${ne.konstanten.bagatelle_eur} €/Jahr — Antrag nicht zulaessig.</div>`);
      }
      if (!t.pruefung.mindestentgelt_eingehalten) {
        hinweise.push(`<div class="info-box">ℹ Tarif ${key === 'lt2500' ? '< 2.500 h' : '≥ 2.500 h'}: Rechnerisches Individuell-Entgelt war unter 20%-Untergrenze — gekappt auf ${eur(t.min_individuell_eur)}.</div>`);
      }
    }
    document.getElementById('netzentgelt-hinweise').innerHTML = hinweise.join('');
    neSection.style.display = 'block';
  } else {
    neSection.style.display = 'none';
  }

  // Download-Buttons: Pruefbericht + 0..2 Antragsformulare
  const btnDocx = document.getElementById('btn-docx');
  btnDocx.href = data.report_path;
  btnDocx.style.display = 'inline-block';
  btnDocx.setAttribute('download', `pruefbericht-${data.id}.docx`);

  // Antragsformulare als zusaetzliche Buttons rendern
  const antraegeContainer = document.getElementById('antraege-container');
  antraegeContainer.innerHTML = '';
  if (Array.isArray(data.antraege) && data.antraege.length > 0) {
    for (const a of data.antraege) {
      const link = document.createElement('a');
      link.href = a.download_path;
      link.setAttribute('download', `antrag-${a.variant}-${data.id}.docx`);
      const btn = document.createElement('button');
      btn.className = a.empfohlen ? '' : 'secondary';
      btn.innerHTML = (a.empfohlen ? '⭐ ' : '') + '📋 ' + a.label;
      btn.title = a.empfohlen ? 'Empfohlene Antragsvariante' : 'Alternative Antragsvariante';
      link.appendChild(btn);
      antraegeContainer.appendChild(link);
    }
  }

  // Grundlage-Box
  const g = p.grundlage || {};
  document.getElementById('grundlage-box').innerHTML = `
    <strong>Rechtsgrundlage:</strong> ${g.rechtsnorm} (${g.festlegung})<br>
    <strong>HLZF-Quelle:</strong> ${g.hlzf_quelle || 'Platzhalter — vor Antragstellung verifizieren'}<br>
    <strong>Pruef-ID:</strong> ${data.id}
  `;

  showScreen('report');
}

document.getElementById('btn-neu').addEventListener('click', () => {
  chosenFile = null;
  dropzone.classList.remove('has-file');
  dropzoneText.innerHTML = `<div class="icon">📂</div><div><strong>Datei hierher ziehen</strong> oder klicken zum Auswaehlen<br><small style="color:var(--muted)">Erwartet: Spalte A = Datum/Uhrzeit, Spalte B = Leistung (kW)</small></div>`;
  btnAnalyseStart.disabled = true;
  fileInput.value = '';
  showScreen('stamm');
});

// expose for inline handlers
window.showScreen = showScreen;
