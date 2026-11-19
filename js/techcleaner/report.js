'use strict';

/**
 * Tech-Cleaner : rapport de bon fonctionnement après tests et calibrage.
 *
 * - reprend les infos lues sur la manette (modèle, n° de série, carte, firmware…)
 * - reprend les résultats du Quick Test
 * - mesure les joysticks : décalage au repos (centre) et circularité
 * - formulaire atelier (client, référence, interventions, garantie, observations)
 * - génère un rapport A4 imprimable / enregistrable en PDF
 * - conserve un historique local (navigateur) avec réimpression et export
 */

import { tcSession, QUICK_TEST_LABELS_FR } from './session.js';
import { draw_stick_dial, CIRCULARITY_DATA_SIZE, calculateCircularityError } from '../stick-renderer.js';
import { tmrCodeFor } from './tmr-code.js';

// ---------------------------------------------------------------------------
// Paramètres atelier (modifiables)
// ---------------------------------------------------------------------------

export const TC_CONFIG = {
  company: 'Tech-Cleaner',
  tagline: 'Atelier de réparation consoles & manettes',
  address: 'Aincourt (95510) – Val-d\'Oise',
  phone: '06 63 47 78 58',
  email: 'techcleaner95@gmail.com',
  website: 'techcleaner.fr',
  // Adresse de la version client (recalibrage TMR à domicile)
  clientToolUrl: 'test-manette.techcleaner.fr',
  // Logo optionnel : déposer le fichier dans images/ (laisser '' pour le logo texte)
  logoUrl: 'images/techcleaner-logo.png',

  // Seuils de conformité joysticks (valeurs normalisées, 1.0 = débattement max)
  centerMaxOffset: 0.06,       // décalage max au repos toléré (6 %)
  circularityMax: 15,          // erreur de circularité max tolérée (%)
  circularityFactory: 10,      // référence usine Sony (~10 %)
  centerSampleMs: 3000,        // durée de la mesure du centre
  circularityMinBins: 40,      // nb de secteurs (sur 48) à couvrir pour valider la mesure

  // Garanties
  warrantyDefaultMonths: 3,    // manettes / accessoires
  warrantyTmrMonths: 6,        // upgrade TMR
};

export const INTERVENTIONS = [
  { id: 'diag', label: 'Diagnostic complet' },
  { id: 'clean', label: 'Nettoyage intérieur' },
  { id: 'tmr', label: 'Upgrade joysticks TMR (anti-drift)' },
  { id: 'stick', label: 'Remplacement joystick(s) analogique(s)' },
  { id: 'buttons', label: 'Remplacement boutons / membranes' },
  { id: 'triggers', label: 'Réparation gâchettes / ressorts' },
  { id: 'usbc', label: 'Remplacement connecteur USB-C' },
  { id: 'battery', label: 'Remplacement batterie' },
  { id: 'calib', label: 'Calibrage des joysticks' },
];

const HISTORY_KEY = 'tcReportHistory';
const HISTORY_MAX = 300;

// ---------------------------------------------------------------------------
// État du module
// ---------------------------------------------------------------------------

let deps = { getController: () => null };

const measures = {
  left: { circ: new Array(CIRCULARITY_DATA_SIZE).fill(0), center: null },
  right: { circ: new Array(CIRCULARITY_DATA_SIZE).fill(0), center: null },
  circRunning: false,
  centerRunning: false,
};

function resetMeasures() {
  for (const side of ['left', 'right']) {
    measures[side].circ.fill(0);
    measures[side].center = null;
  }
  measures.circRunning = false;
  measures.centerRunning = false;
}

export function initTechCleanerReport(dependencies) {
  deps = { ...deps, ...dependencies };
}

/** À appeler à chaque nouvelle connexion de manette */
export function tcOnControllerConnected() {
  resetMeasures();
  $('#tc-form')[0]?.reset();
  $('#tc-verdict-override').val('auto');
  updateWarrantySuggestion();
}

export function isTechCleanerReportVisible() {
  return $('#tcReportModal').hasClass('show');
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)} %`);
const stripHtml = (s) => { const d = document.createElement('div'); d.innerHTML = String(s ?? ''); return d.textContent.trim(); };

// Libellés matériel en français, quelle que soit la langue de l'interface
const KEY_FR = {
  'serial number': 'N° de série', 'color': 'Couleur', 'board model': 'Carte mère', 'fw build date': 'Firmware (date)',
  'device type': 'Authenticité', 'hw model': 'Modèle matériel', 'fw version': 'Version firmware',
};
const VALUE_FR = {
  original: 'Origine constructeur', originale: 'Origine constructeur', clone: 'Non d\'origine (clone)',
  white: 'Blanc', black: 'Noir', red: 'Rouge', blue: 'Bleu', pink: 'Rose', purple: 'Violet', grey: 'Gris', gray: 'Gris',
  'midnight black': 'Noir minuit', 'cosmic red': 'Rouge cosmique', 'nova pink': 'Rose nova', 'galactic purple': 'Violet galactique',
  'starlight blue': 'Bleu stellaire', 'gray camouflage': 'Camouflage gris', 'grey camouflage': 'Camouflage gris',
};
const frKey = (k) => KEY_FR[String(k).toLowerCase()] || k;
const frValue = (v) => VALUE_FR[String(v).toLowerCase()] || v;

function fmtDate(iso, withTime = true) {
  const d = new Date(iso);
  const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('fr-FR', opts);
}

function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0); // ex. 31/08 + 6 mois -> 28/02
  return d.toISOString();
}

function numberOfSticks() {
  return deps.getController()?.currentController?.getNumberOfSticks?.() ?? 2;
}

function circularityError(data) {
  return data.filter(v => v > 0.2).length ? calculateCircularityError(data) : null;
}

function circularityCoverage(data) {
  return data.filter(v => v > 0.3).length;
}

function genReportId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const rnd = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `TC-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${rnd}`;
}

// ---------------------------------------------------------------------------
// Mesures joysticks (live)
// ---------------------------------------------------------------------------

export function techcleaner_handle_input(changes) {
  if (measures.circRunning && changes?.sticks) {
    for (const side of ['left', 'right']) {
      const s = changes.sticks[side];
      if (!s) continue;
      const { x, y } = s;
      const dist = Math.sqrt(x * x + y * y);
      const N = CIRCULARITY_DATA_SIZE;
      const idx = (Math.round(Math.atan2(y, x) * N / 2 / Math.PI) + N) % N;
      measures[side].circ[idx] = Math.max(measures[side].circ[idx] ?? 0, dist);
    }
    updateCircularityStatus();
  }
  if (changes?.sticks) throttledDraw();
}

const throttledDraw = (() => {
  let t = null;
  return () => {
    if (t) return;
    t = setTimeout(() => { t = null; drawLiveCanvas(); }, 30);
  };
})();

function drawLiveCanvas() {
  const c = document.getElementById('tc-stick-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const sticks = deps.getController()?.button_states?.sticks ?? { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  const sz = 60, yb = 75;
  if (numberOfSticks() === 1) {
    draw_stick_dial(ctx, c.width / 2, yb, sz, sticks.left.x, sticks.left.y, { circularity_data: measures.left.circ });
  } else {
    draw_stick_dial(ctx, 80, yb, sz, sticks.left.x, sticks.left.y, { circularity_data: measures.left.circ });
    draw_stick_dial(ctx, c.width - 80, yb, sz, sticks.right.x, sticks.right.y, { circularity_data: measures.right.circ });
  }
}

function sides() {
  return numberOfSticks() === 1 ? ['left'] : ['left', 'right'];
}

function updateCircularityStatus() {
  const parts = sides().map(side => {
    const cov = circularityCoverage(measures[side].circ);
    const err = circularityError(measures[side].circ);
    const name = side === 'left' ? 'Gauche' : 'Droit';
    const ok = cov >= TC_CONFIG.circularityMinBins;
    return `${name} : ${err == null ? '—' : err.toFixed(1) + ' %'} <span class="text-${ok ? 'success' : 'warning'}">(${Math.round(cov / CIRCULARITY_DATA_SIZE * 100)} % du tour couvert)</span>`;
  });
  $('#tc-circ-status').html(parts.join('<br>'));
}

function updateCenterStatus() {
  const parts = sides().map(side => {
    const m = measures[side].center;
    const name = side === 'left' ? 'Gauche' : 'Droit';
    if (!m) return `${name} : non mesuré`;
    const ok = m.maxOffset <= TC_CONFIG.centerMaxOffset;
    return `${name} : décalage max ${pct(m.maxOffset)} <span class="text-${ok ? 'success' : 'danger'}">${ok ? '✔' : '✘'}</span>`;
  });
  $('#tc-center-status').html(parts.join('<br>'));
}

export function tc_measure_center() {
  if (measures.centerRunning) return;
  const ctrl = deps.getController();
  if (!ctrl) return;
  measures.centerRunning = true;
  const $btn = $('#tc-center-btn').prop('disabled', true);
  const acc = { left: [], right: [] };
  const started = Date.now();
  const timer = setInterval(() => {
    const st = ctrl.button_states?.sticks;
    if (st) {
      acc.left.push({ ...st.left });
      acc.right.push({ ...st.right });
    }
    const remaining = Math.max(0, TC_CONFIG.centerSampleMs - (Date.now() - started));
    $('#tc-center-status').text(`Mesure en cours… ne touchez pas les joysticks (${(remaining / 1000).toFixed(1)} s)`);
    if (remaining <= 0) {
      clearInterval(timer);
      for (const side of ['left', 'right']) {
        const pts = acc[side];
        if (!pts.length) continue;
        const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
        const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        const maxOffset = Math.max(...pts.map(p => Math.hypot(p.x, p.y)));
        measures[side].center = { meanX: mx, meanY: my, maxOffset, samples: pts.length };
      }
      measures.centerRunning = false;
      $btn.prop('disabled', false);
      updateCenterStatus();
    }
  }, 20);
}

export function tc_toggle_circularity() {
  if (!measures.circRunning) {
    for (const side of ['left', 'right']) measures[side].circ.fill(0);
    measures.circRunning = true;
    $('#tc-circ-btn').removeClass('btn-outline-primary').addClass('btn-warning')
      .html('<i class="fas fa-stop me-1"></i>Terminer la mesure');
    $('#tc-circ-status').text('Faites plusieurs tours complets avec chaque joystick, en butée, dans les deux sens.');
  } else {
    measures.circRunning = false;
    $('#tc-circ-btn').removeClass('btn-warning').addClass('btn-outline-primary')
      .html('<i class="fas fa-circle-notch me-1"></i>Mesurer la circularité');
    updateCircularityStatus();
  }
  drawLiveCanvas();
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function renderDetectedInfo() {
  const s = tcSession;
  const rows = [
    ['Manette', s.deviceName || '—'],
    ['N° de série', s.serialNumber || '—'],
    ...s.infoItems.filter(i => !i.isExtra && i.key && !/serial|série/i.test(i.key)).map(i => [frKey(i.key), frValue(stripHtml(i.value))]),
  ];
  $('#tc-detected-info').html(rows.map(([k, v]) =>
    `<dt class="col-5 text-muted">${esc(k)}</dt><dd class="col-7 text-end mb-1">${esc(v)}</dd>`).join(''));

  const tests = s.supportedQuickTests.length ? s.supportedQuickTests : Object.keys(s.quickTests);
  if (!tests.length) {
    $('#tc-quicktest-summary').html('<span class="text-muted">Aucun test lancé pour l\'instant.</span>');
  } else {
    $('#tc-quicktest-summary').html(tests.map(id => {
      const r = s.quickTests[id];
      const badge = r === true ? 'bg-success">OK' : r === false ? 'bg-danger">Échec' : 'bg-secondary">Non testé';
      return `<span class="badge ${badge}</span>&nbsp;${esc(QUICK_TEST_LABELS_FR[id] || id)}`;
    }).join('<br>'));
  }
  $('#tc-calib-auto').text([
    s.centerCalibrated ? 'Calibrage centre effectué' : null,
    s.rangeCalibrated ? 'Calibrage amplitude effectué' : null,
    s.calibrationSaved ? 'Calibrage enregistré dans la manette' : null,
  ].filter(Boolean).join(' · ') || 'Aucun calibrage enregistré pendant cette session.');
}

function renderInterventionsCheckboxes() {
  const $c = $('#tc-interventions');
  if ($c.children().length) return;
  $c.html(INTERVENTIONS.map(i => `
    <div class="form-check col-sm-6">
      <input class="form-check-input tc-interv" type="checkbox" value="${i.id}" id="tc-i-${i.id}">
      <label class="form-check-label" for="tc-i-${i.id}">${esc(i.label)}</label>
    </div>`).join(''));
  $c.on('change', '.tc-interv', () => { updateWarrantySuggestion(); updateTmrCodeDisplay(); });
}

function updateWarrantySuggestion() {
  if ($('#tc-warranty').data('touched')) return;
  const tmr = $('#tc-i-tmr').is(':checked');
  $('#tc-warranty').val(String(tmr ? TC_CONFIG.warrantyTmrMonths : TC_CONFIG.warrantyDefaultMonths));
}

async function updateTmrCodeDisplay() {
  const $d = $('#tc-tmr-code');
  if (!$d.length) return;
  if (!$('#tc-i-tmr').is(':checked') || !tcSession.serialNumber) { $d.hide(); return; }
  const code = await tmrCodeFor(tcSession.serialNumber);
  $d.html(`<i class="fas fa-key me-1"></i>Code recalibrage TMR du client : <b class="font-monospace">${esc(code)}</b> <span class="text-muted">(imprimé sur le rapport)</span>`).show();
}

export function tc_open_report_modal() {
  renderInterventionsCheckboxes();
  updateTmrCodeDisplay();
  renderDetectedInfo();
  updateCenterStatus();
  updateCircularityStatus();
  renderHistory();
  bootstrap.Modal.getOrCreateInstance('#tcReportModal').show();
  setTimeout(drawLiveCanvas, 200);
}

export function tc_open_quick_test_from_report() {
  bootstrap.Modal.getOrCreateInstance('#tcReportModal').hide();
  setTimeout(() => window.show_quick_test_modal?.(), 400);
}

// ---------------------------------------------------------------------------
// Construction des données du rapport
// ---------------------------------------------------------------------------

function collectReportData() {
  const s = tcSession;
  const now = new Date();
  const checked = $('.tc-interv:checked').map((_, el) => el.value).get();
  const interventions = INTERVENTIONS.filter(i => checked.includes(i.id)).map(i => i.label);
  const other = $('#tc-interv-other').val().trim();
  if (other) interventions.push(other);

  const sticks = sides().map(side => ({
    side,
    center: measures[side].center,
    circularity: circularityError(measures[side].circ),
    coverage: circularityCoverage(measures[side].circ),
    circ: [...measures[side].circ],
  }));

  const warrantyMonths = parseInt($('#tc-warranty').val(), 10) || 0;

  return {
    version: 1,
    id: genReportId(now),
    createdAt: now.toISOString(),
    client: $('#tc-client').val().trim(),
    orderRef: $('#tc-order').val().trim(),
    technician: $('#tc-tech').val().trim(),
    interventions,
    interventionIds: checked,
    warrantyMonths,
    warrantyEnd: warrantyMonths ? addMonths(now.toISOString(), warrantyMonths) : null,
    observations: $('#tc-notes').val().trim(),
    nonOriginal: $('#tc-nonorig').is(':checked') ? ($('#tc-nonorig-detail').val().trim() || 'éléments non d\'origine') : '',
    verdictOverride: $('#tc-verdict-override').val(),
    device: {
      name: s.deviceName,
      model: s.model,
      serialNumber: s.serialNumber,
      isClone: s.isClone,
      info: s.infoItems.filter(i => !i.isExtra && i.key).map(i => ({ key: frKey(i.key), value: frValue(stripHtml(i.value)) })),
      battery: stripHtml(deps.getController()?.batteryStatus?.bat_txt ?? ''),
    },
    quickTests: (s.supportedQuickTests.length ? s.supportedQuickTests : Object.keys(s.quickTests))
      .map(id => ({ id, label: QUICK_TEST_LABELS_FR[id] || id, result: s.quickTests[id] ?? null })),
    calibration: { center: s.centerCalibrated, range: s.rangeCalibrated, saved: s.calibrationSaved },
    sticks,
    thresholds: { centerMaxOffset: TC_CONFIG.centerMaxOffset, circularityMax: TC_CONFIG.circularityMax },
  };
}

/** Évalue la conformité. Retourne { status: 'ok'|'reserve'|'fail', reasons: [] } */
export function computeVerdict(r) {
  const fails = [];
  const warns = [];
  r.quickTests.filter(t => t.result === false).forEach(t => fails.push(`Test « ${t.label} » en échec`));
  for (const st of r.sticks) {
    const name = st.side === 'left' ? 'gauche' : 'droit';
    if (st.center && st.center.maxOffset > r.thresholds.centerMaxOffset) fails.push(`Décalage au repos du joystick ${name} hors tolérance`);
    if (st.circularity != null && st.coverage >= 10 && st.circularity > r.thresholds.circularityMax) fails.push(`Circularité du joystick ${name} hors tolérance`);
    if (!st.center) warns.push(`Centre du joystick ${name} non mesuré`);
    if (st.circularity == null || st.coverage < 10) warns.push(`Circularité du joystick ${name} non mesurée`);
  }
  if (r.device.isClone) warns.push('Manette non d\'origine (clone) détectée');

  let status = fails.length ? 'fail' : (warns.length ? 'reserve' : 'ok');
  if (r.verdictOverride && r.verdictOverride !== 'auto') status = r.verdictOverride;
  return { status, fails, warns };
}

// ---------------------------------------------------------------------------
// Rendu HTML du rapport
// ---------------------------------------------------------------------------

function polarSvg(circ, center, size = 150) {
  const c = size / 2, R = size / 2 - 8;
  const N = circ.length;
  let wedges = '';
  for (let i = 0; i < N; i++) {
    const kd = circ[i], kd1 = circ[(i + 1) % N];
    if (!kd || !kd1) continue;
    const a = i * 2 * Math.PI / N, a1 = ((i + 1) % N) * 2 * Math.PI / N;
    const dd = Math.abs(1 - (kd + kd1) / 2);
    const cc = (kd + kd1) / 2;
    const hh = cc <= 1 ? 220 - 220 * Math.min(1, Math.max(0, dd - 0.05) / 0.1)
                       : (245 + 115 * Math.min(1, Math.max(0, dd - 0.05) / 0.15)) % 360;
    wedges += `<polygon points="${c},${c} ${c + Math.cos(a) * kd * R},${c + Math.sin(a) * kd * R} ${c + Math.cos(a1) * kd1 * R},${c + Math.sin(a1) * kd1 * R}" fill="hsla(${hh|0},100%,50%,0.55)"/>`;
  }
  const dot = center ? `<circle cx="${c + center.meanX * R}" cy="${c + center.meanY * R}" r="3" fill="#111"/>` : '';
  const tol = center !== undefined ? `<circle cx="${c}" cy="${c}" r="${TC_CONFIG.centerMaxOffset * R}" fill="none" stroke="#1a7f37" stroke-width="1"/>` : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${c}" cy="${c}" r="${R}" fill="#fff" stroke="#333" stroke-width="1.2"/>
    ${wedges}
    <circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="#333" stroke-width="1.2"/>
    <line x1="${c - R}" y1="${c}" x2="${c + R}" y2="${c}" stroke="#bbb"/><line x1="${c}" y1="${c - R}" x2="${c}" y2="${c + R}" stroke="#bbb"/>
    ${tol}${dot}
  </svg>`;
}

const okMark = '<span class="ok">✔</span>';
const koMark = '<span class="ko">✘</span>';
const naMark = '<span class="na">—</span>';

export function buildReportHtml(r) {
  const v = computeVerdict(r);
  const verdictLabel = { ok: 'CONFORME', reserve: 'CONFORME AVEC RÉSERVES', fail: 'NON CONFORME' }[v.status];
  const verdictText = {
    ok: 'La manette a passé avec succès l\'ensemble des tests réalisés. Son bon fonctionnement est constaté à la date du rapport.',
    reserve: 'La manette fonctionne correctement sur les points testés, avec les réserves indiquées ci-dessous.',
    fail: 'Un ou plusieurs points ne sont pas conformes (voir détail ci-dessous).',
  }[v.status];

  const deviceRows = [
    ['Modèle', r.device.name],
    ['N° de série', r.device.serialNumber],
    ...r.device.info.filter(i => !/serial|série/i.test(i.key)),
    ...(r.device.battery ? [['Batterie (au test)', r.device.battery]] : []),
  ].map(x => Array.isArray(x) ? x : [x.key, x.value])
   .map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val || '—')}</td></tr>`).join('');

  const testsRows = r.quickTests.length
    ? r.quickTests.map(t => `<tr><td>${esc(t.label)}</td><td class="c">${t.result === true ? okMark + ' Conforme' : t.result === false ? koMark + ' Défaut' : naMark + ' Non testé'}</td></tr>`).join('')
    : '<tr><td colspan="2" class="muted">Aucun test fonctionnel enregistré.</td></tr>';

  const stickCols = r.sticks.map(st => {
    const name = r.sticks.length === 1 ? 'Joystick' : (st.side === 'left' ? 'Joystick gauche' : 'Joystick droit');
    const cOk = st.center ? st.center.maxOffset <= r.thresholds.centerMaxOffset : null;
    const circMeasured = st.circularity != null && st.coverage >= 10;
    const rOk = circMeasured ? st.circularity <= r.thresholds.circularityMax : null;
    return `<div class="stick">
      <div class="stick-title">${name}</div>
      ${polarSvg(st.circ, st.center)}
      <table class="mini">
        <tr><th>Centre au repos</th><td>${st.center ? pct(st.center.maxOffset) + ' ' + (cOk ? okMark : koMark) : naMark}</td></tr>
        <tr><th>Circularité</th><td>${circMeasured ? st.circularity.toFixed(1) + ' % ' + (rOk ? okMark : koMark) : naMark}</td></tr>
      </table>
    </div>`;
  }).join('');

  const calib = [
    r.calibration.center ? 'Calibrage du centre' : null,
    r.calibration.range ? 'Calibrage de l\'amplitude' : null,
    r.calibration.saved ? 'Enregistré dans la mémoire de la manette' : null,
  ].filter(Boolean);

  const reserves = [];
  if (r.nonOriginal) {
    reserves.push(`Des éléments non d'origine ont été constatés sur cette manette (${esc(r.nonOriginal)}). Ils ne relèvent pas de notre intervention et ne sont pas couverts par la garantie ${esc(TC_CONFIG.company)}.`);
  }
  if (r.device.isClone) {
    reserves.push('L\'analyse électronique indique que cette manette n\'est pas un modèle d\'origine constructeur. Les résultats et la garantie portent uniquement sur l\'intervention réalisée.');
  }
  v.warns.filter(w => !/clone/.test(w)).forEach(w => reserves.push(esc(w) + '.'));

  const logo = TC_CONFIG.logoUrl
    ? `<img src="${esc(new URL(TC_CONFIG.logoUrl, location.href).href)}" alt="" class="logo" onerror="this.remove()">` : '';

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>Rapport ${esc(r.id)} – ${esc(TC_CONFIG.company)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Roboto, Arial, sans-serif; color: #1d1d1f; font-size: 11.5px; margin: 0; background: #eef0f3; }
  .page { width: 210mm; min-height: 297mm; margin: 10px auto; background: #fff; padding: 12mm; box-shadow: 0 2px 12px rgba(0,0,0,.12); }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0b63ce; padding-bottom: 10px; }
  .brand { display: flex; gap: 12px; align-items: center; }
  .logo { height: 52px; }
  .brand-name { font-size: 24px; font-weight: 800; letter-spacing: .5px; color: #0b63ce; }
  .brand-sub { color: #555; font-size: 11px; }
  .contact { text-align: right; font-size: 10.5px; color: #444; line-height: 1.5; }
  h1 { font-size: 17px; margin: 14px 0 2px; }
  .meta { color: #555; margin-bottom: 10px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  section { border: 1px solid #dcdfe4; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; break-inside: avoid; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .6px; color: #0b63ce; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3px 4px; vertical-align: top; border-bottom: 1px solid #f0f1f3; }
  th { color: #555; font-weight: 600; width: 45%; }
  td.c { white-space: nowrap; }
  .ok { color: #1a7f37; font-weight: 700; } .ko { color: #c62828; font-weight: 700; } .na { color: #999; }
  .muted { color: #888; }
  .tmr .code { font-family: Consolas, monospace; font-size: 15px; font-weight: 800; letter-spacing: 2px; background: #eef4ff; border: 1px dashed #0b63ce; padding: 2px 8px; border-radius: 4px; display: inline-block; }
  .sticks { display: flex; justify-content: space-around; gap: 12px; }
  .stick { text-align: center; }
  .stick-title { font-weight: 700; margin-bottom: 4px; }
  table.mini th { width: auto; }
  .legend { font-size: 9.5px; color: #666; margin-top: 6px; }
  .verdict { border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; display: flex; gap: 14px; align-items: center; }
  .verdict .label { font-size: 16px; font-weight: 800; white-space: nowrap; }
  .v-ok { background: #e8f5ec; border: 2px solid #1a7f37; } .v-ok .label { color: #1a7f37; }
  .v-reserve { background: #fff6e5; border: 2px solid #d48806; } .v-reserve .label { color: #a86400; }
  .v-fail { background: #fdecec; border: 2px solid #c62828; } .v-fail .label { color: #c62828; }
  ul { margin: 4px 0 0 16px; padding: 0; }
  .sign { display: flex; justify-content: space-between; margin-top: 14px; gap: 20px; }
  .sign div { flex: 1; border-top: 1px solid #999; padding-top: 4px; color: #555; min-height: 50px; }
  footer { margin-top: 12px; font-size: 9.5px; color: #666; border-top: 1px solid #ddd; padding-top: 6px; }
  .toolbar { text-align: center; margin: 10px; }
  .toolbar button { font-size: 14px; padding: 8px 18px; border: 0; border-radius: 6px; background: #0b63ce; color: #fff; cursor: pointer; }
  @media print { body { background: #fff; } .page { margin: 0; box-shadow: none; width: auto; min-height: auto; padding: 0; } .toolbar { display: none; } }
</style></head>
<body>
<div class="toolbar"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div>
<div class="page">
  <header>
    <div class="brand">${logo}<div><div class="brand-name">${esc(TC_CONFIG.company.toUpperCase())}</div><div class="brand-sub">${esc(TC_CONFIG.tagline)}</div></div></div>
    <div class="contact">${esc(TC_CONFIG.address)}<br>${esc(TC_CONFIG.phone)}<br>${esc(TC_CONFIG.email)}<br>${esc(TC_CONFIG.website)}</div>
  </header>

  <h1>Rapport de test et de calibrage</h1>
  <div class="meta">Rapport n° <b>${esc(r.id)}</b> — établi le ${fmtDate(r.createdAt)}${r.orderRef ? ` — Réf. ${esc(r.orderRef)}` : ''}</div>

  <div class="verdict v-${v.status}">
    <div class="label">${verdictLabel}</div>
    <div>${verdictText}${v.fails.length ? `<ul>${v.fails.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div>
  </div>

  <div class="grid">
    <section>
      <h2>Client &amp; intervention</h2>
      <table>
        <tr><th>Client</th><td>${esc(r.client || '—')}</td></tr>
        ${r.orderRef ? `<tr><th>Référence</th><td>${esc(r.orderRef)}</td></tr>` : ''}
        <tr><th>Intervention(s)</th><td>${r.interventions.length ? r.interventions.map(esc).join('<br>') : '—'}</td></tr>
        <tr><th>Garantie</th><td>${r.warrantyMonths ? `${r.warrantyMonths} mois, jusqu'au ${fmtDate(r.warrantyEnd, false)}` : 'Sans objet'}</td></tr>
        ${r.technician ? `<tr><th>Technicien</th><td>${esc(r.technician)}</td></tr>` : ''}
      </table>
    </section>
    <section>
      <h2>Manette</h2>
      <table>${deviceRows}</table>
    </section>
  </div>

  <div class="grid">
    <section>
      <h2>Tests fonctionnels</h2>
      <table>${testsRows}</table>
    </section>
    <section>
      <h2>Joysticks</h2>
      <div class="sticks">${stickCols}</div>
      <div class="legend">Centre au repos : décalage maximal mesuré joysticks relâchés (tolérance ≤ ${pct(r.thresholds.centerMaxOffset, 0)}, cercle vert).
        Circularité : écart moyen au cercle parfait en butée (tolérance ≤ ${r.thresholds.circularityMax} % ; référence usine ≈ ${TC_CONFIG.circularityFactory} %).
        ${calib.length ? `<br><b>Calibrage :</b> ${calib.join(' · ')}.` : ''}</div>
    </section>
  </div>

  ${r.tmrCode ? `<section class="tmr"><h2>Recalibrage TMR à domicile</h2>
    <div>Vos joysticks TMR peuvent être recalibrés à tout moment, depuis un ordinateur (Chrome ou Edge) avec la manette branchée en USB :
    rendez-vous sur <b>${esc(TC_CONFIG.clientToolUrl)}</b>, rubrique « Recalibrage TMR », et saisissez votre code personnel.</div>
    <div style="margin-top: 6px;">Votre code : <span class="code">${esc(r.tmrCode)}</span>
    <span class="muted">— valable uniquement pour cette manette (n° ${esc(r.device.serialNumber)})</span></div>
  </section>` : ''}
  ${r.observations ? `<section><h2>Observations</h2><div>${nl2br(r.observations)}</div></section>` : ''}
  ${reserves.length ? `<section><h2>Remarques</h2><ul>${reserves.map(x => `<li>${x}</li>`).join('')}</ul></section>` : ''}

  <div class="sign"><div>Le technicien${r.technician ? ` : ${esc(r.technician)}` : ''}</div><div>Cachet ${esc(TC_CONFIG.company)}</div></div>

  <footer>
    Ce rapport atteste des résultats constatés lors des tests réalisés en atelier, à la date indiquée, sur la manette identifiée ci-dessus.
    La garantie ${esc(TC_CONFIG.company)} couvre les pièces posées et la main-d'œuvre de l'intervention mentionnée ; elle ne couvre pas la casse, l'oxydation, les chutes,
    ni l'ouverture ou la modification de la manette par un tiers. Conservez ce rapport : il vous sera demandé en cas de retour sous garantie.
  </footer>
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Génération, historique
// ---------------------------------------------------------------------------

function openReportWindow(html, existingWindow = null) {
  const w = existingWindow || window.open('', '_blank');
  if (!w) {
    // Fenêtre bloquée : téléchargement du fichier HTML à la place
    downloadFile(html, 'rapport-techcleaner.html', 'text/html');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) { console.warn('Historique non enregistré', e); }
}

export async function tc_generate_report() {
  if (measures.circRunning) tc_toggle_circularity();
  // Ouvrir la fenêtre tout de suite (sinon bloquée par le navigateur après un await)
  const win = window.open('', '_blank');
  const r = collectReportData();
  if (r.interventionIds.includes('tmr') && r.device.serialNumber) {
    r.tmrCode = await tmrCodeFor(r.device.serialNumber);
  }
  const list = loadHistory();
  list.unshift(r);
  saveHistory(list);
  renderHistory();
  openReportWindow(buildReportHtml(r), win);
}

function renderHistory() {
  const list = loadHistory();
  const $tb = $('#tc-history-body');
  if (!$tb.length) return;
  if (!list.length) {
    $tb.html('<tr><td colspan="5" class="text-muted">Aucun rapport pour l\'instant.</td></tr>');
    return;
  }
  $tb.html(list.map((r, i) => {
    const v = computeVerdict(r).status;
    const badge = { ok: 'success">Conforme', reserve: 'warning text-dark">Réserves', fail: 'danger">Non conforme' }[v];
    return `<tr>
      <td class="small">${fmtDate(r.createdAt)}<br><span class="text-muted">${esc(r.id)}</span></td>
      <td>${esc(r.client || '—')}${r.orderRef ? `<br><span class="text-muted small">${esc(r.orderRef)}</span>` : ''}</td>
      <td class="small">${esc(r.device?.name || '')}<br><span class="text-muted">${esc(r.device?.serialNumber || '')}</span>${r.tmrCode ? `<br><span class="font-monospace">Code TMR ${esc(r.tmrCode)}</span>` : ''}</td>
      <td><span class="badge bg-${badge}</span></td>
      <td class="text-end"><button class="btn btn-sm btn-outline-primary" onclick="tc_reprint_report(${i})" title="Réimprimer"><i class="fas fa-print"></i></button></td>
    </tr>`;
  }).join(''));
}

export async function tc_generate_tmr_code() {
  const serial = $('#tc-gen-serial').val().trim();
  const code = serial ? await tmrCodeFor(serial) : null;
  $('#tc-gen-result').html(code
    ? `Code : <b class="font-monospace fs-5">${esc(code)}</b> <button type="button" class="btn btn-sm btn-link" onclick="navigator.clipboard.writeText('${code}')">Copier</button>`
    : '<span class="text-danger">Saisissez un n° de série.</span>');
}

export function tc_reprint_report(index) {
  const r = loadHistory()[index];
  if (r) openReportWindow(buildReportHtml(r));
}

export function tc_export_history() {
  const list = loadHistory();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(JSON.stringify(list, null, 2), `historique-rapports-techcleaner-${stamp}.json`, 'application/json');

  // Export tableur (CSV ; séparateur point-virgule pour Excel FR)
  const head = ['Date', 'N° rapport', 'Client', 'Référence', 'Manette', 'N° série', 'Interventions', 'Garantie (mois)', 'Verdict', 'Code TMR'];
  const rows = list.map(r => [fmtDate(r.createdAt), r.id, r.client, r.orderRef, r.device?.name, r.device?.serialNumber,
    (r.interventions || []).join(' + '), r.warrantyMonths, { ok: 'Conforme', reserve: 'Réserves', fail: 'Non conforme' }[computeVerdict(r).status], r.tmrCode || '']);
  const csv = [head, ...rows].map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  downloadFile('﻿' + csv, `historique-rapports-techcleaner-${stamp}.csv`, 'text/csv');
}

export function tc_import_history(input) {
  const file = input.files?.[0];
  if (!file) return;
  file.text().then(txt => {
    const imported = JSON.parse(txt);
    if (!Array.isArray(imported)) throw new Error('format');
    const ids = new Set(loadHistory().map(r => r.id));
    const merged = [...imported.filter(r => r?.id && !ids.has(r.id)), ...loadHistory()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    saveHistory(merged);
    renderHistory();
  }).catch(() => alert('Fichier d\'historique invalide.'))
    .finally(() => { input.value = ''; });
}

// Exposition pour les onclick du template
Object.assign(window, {
  tc_open_report_modal, tc_measure_center, tc_toggle_circularity, tc_generate_report,
  tc_reprint_report, tc_export_history, tc_import_history, tc_open_quick_test_from_report, tc_generate_tmr_code,
});
