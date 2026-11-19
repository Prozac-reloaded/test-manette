'use strict';

/**
 * Tech-Cleaner : version CLIENT (test-manette.techcleaner.fr)
 *
 *  - Pré-diagnostic : tests fonctionnels + drift / circularité des joysticks,
 *    prestation conseillée avec prix, lien de prise de RDV.
 *  - Recalibrage TMR : réservé aux clients ayant un code personnel (lié au n° de série).
 *    Le calibrage reste temporaire tant que le client n'a pas cliqué sur « Enregistrer ».
 */

import { TC_CLIENT_MODE } from './mode.js';
import { tcSession, QUICK_TEST_LABELS_FR } from './session.js';
import { checkTmrCode, normalizeSerial } from './tmr-code.js';
import { draw_stick_dial, CIRCULARITY_DATA_SIZE, calculateCircularityError } from '../stick-renderer.js';

// ---------------------------------------------------------------------------
// Paramètres (modifiables)
// ---------------------------------------------------------------------------

export const CLIENT_CONFIG = {
  bookingUrl: 'https://www.techcleaner.fr/booking-calendar/reparation-manettes',
  phone: '06 63 47 78 58',
  email: 'techcleaner95@gmail.com',
  toolName: 'test-manette.techcleaner.fr',

  centerMaxOffset: 0.06,   // drift toléré au repos (6 %)
  circularityMax: 15,      // circularité tolérée (%)
  centerSampleMs: 3000,
  circularityMinBins: 40,  // secteurs couverts (sur 48) pour valider une mesure de circularité

  // Prestations conseillées selon le modèle (prix en €, null = sur devis)
  offers: {
    DS5:      { sticks: { name: 'Upgrade joysticks TMR (fin du drift)', price: 50 }, other: { name: 'Forfait Réparation DualSense', price: 30 } },
    DS5_Edge: { sticks: { name: 'Upgrade joysticks TMR DualSense Edge', price: 60 }, other: { name: 'Réparation DualSense Edge', price: null } },
    DS4:      { sticks: { name: 'Réparation manette PS4', price: 20 }, other: { name: 'Réparation manette PS4', price: 20 } },
  },

  // Manettes Xbox (test seul, via la Gamepad API du navigateur)
  xboxModels: {
    series: { label: 'Xbox Series X|S', sticks: { name: 'Upgrade joysticks TMR Xbox Series', price: 50 }, other: { name: 'Réparation manette Xbox Series', price: 30 } },
    one:    { label: 'Xbox One',        sticks: { name: 'Réparation manette Xbox One', price: 20 },       other: { name: 'Réparation manette Xbox One', price: 20 } },
    elite2: { label: 'Xbox Elite Series 2', sticks: { name: 'Réparation manette Elite Series 2', price: 50 }, other: { name: 'Réparation manette Elite Series 2', price: 50 } },
    scuf:   { label: 'Scuf (Xbox)',     sticks: { name: 'Upgrade joysticks TMR Scuf Xbox', price: 60 },   other: { name: 'Réparation manette Scuf', price: 50 } },
  },
};

const UNLOCK_KEY = 'tcTmrUnlocked';

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

let deps = {
  getController: () => null,
  calibrateCenter: (done) => done(false),
  calibrateRange: (done) => done(false),
  save: async () => {},
  reboot: async () => {},
};

const measures = {
  left: { circ: new Array(CIRCULARITY_DATA_SIZE).fill(0), center: null },
  right: { circ: new Array(CIRCULARITY_DATA_SIZE).fill(0), center: null },
  circRunning: false,
  centerRunning: false,
  circContext: null,   // 'diag' | 'verify'
};

const tmr = { unlocked: false, centerDone: false, rangeDone: false, verified: null, saved: false };

// Manette Xbox (Gamepad API)
const xbox = {
  active: false,
  index: null,
  model: null,          // 'series' | 'one' | 'elite2' | 'scuf' | 'other' | null
  sticks: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
  pressed: new Set(),   // index des boutons vus enfoncés
  triggerMax: [0, 0],   // course max LT / RT
  rumble: null,         // true | false | null (non testé)
  unsupportedShown: false,
  triggerRumble: null,
  raf: null,
};

function resetMeasures() {
  for (const side of ['left', 'right']) { measures[side].circ.fill(0); measures[side].center = null; }
  measures.circRunning = false;
  measures.centerRunning = false;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => `${(v * 100).toFixed(1)} %`;
const euros = (n) => `${Number.isInteger(n) ? n : n.toFixed(2).replace('.', ',')} €`;

function numberOfSticks() {
  if (xbox.active) return 2;
  return deps.getController()?.currentController?.getNumberOfSticks?.() ?? 2;
}

/** Position actuelle des joysticks : manette Sony (WebHID) ou Xbox (Gamepad API) */
function currentSticks() {
  if (xbox.active) return xbox.sticks;
  return deps.getController()?.button_states?.sticks ?? null;
}
function sides() { return numberOfSticks() === 1 ? ['left'] : ['left', 'right']; }
const sideName = (side) => numberOfSticks() === 1 ? 'joystick' : (side === 'left' ? 'joystick gauche' : 'joystick droit');

function circularity(side) {
  const d = measures[side].circ;
  const covered = d.filter(v => v > 0.3).length;
  return { covered, error: covered >= 10 ? calculateCircularityError(d) : null };
}

function loadUnlocked() {
  try { return JSON.parse(localStorage.getItem(UNLOCK_KEY)) || []; } catch { return []; }
}
function saveUnlocked(serial) {
  try {
    const list = new Set(loadUnlocked());
    list.add(normalizeSerial(serial));
    localStorage.setItem(UNLOCK_KEY, JSON.stringify([...list]));
  } catch { /* stockage indisponible */ }
}

// ---------------------------------------------------------------------------
// Initialisation / connexion
// ---------------------------------------------------------------------------

export function initTechCleanerClient(dependencies) {
  deps = { ...deps, ...dependencies };
  if (!TC_CLIENT_MODE) return;
  document.title = 'Testez votre manette – Tech-Cleaner';
  $('#tc-client-column').show();
  startGamepadDetection();
}

export function tcClientOnConnected() {
  if (!TC_CLIENT_MODE) return;
  stopXbox();
  $('#tcx-panel, #tcx-sony-hint').hide();
  resetMeasures();
  Object.assign(tmr, { unlocked: false, centerDone: false, rangeDone: false, verified: null, saved: false });
  const serial = tcSession.serialNumber;
  if (serial && loadUnlocked().includes(normalizeSerial(serial))) tmr.unlocked = true;
  $('#tcc-result').hide().html('');
  $('#tcc-code-input').val('');
  $('#tcc-code-msg').html('');
  renderAll();
  setTimeout(drawCanvas, 100);
}

export function tcClientOnQuickTestClosed() {
  if (TC_CLIENT_MODE) renderTests();
}

// ---------------------------------------------------------------------------
// Entrées manette
// ---------------------------------------------------------------------------

export function tc_client_handle_input(changes) {
  if (!TC_CLIENT_MODE || !changes?.sticks) return;
  if (measures.circRunning) {
    const N = CIRCULARITY_DATA_SIZE;
    for (const side of ['left', 'right']) {
      const s = changes.sticks[side];
      if (!s) continue;
      const dist = Math.hypot(s.x, s.y);
      const idx = (Math.round(Math.atan2(s.y, s.x) * N / 2 / Math.PI) + N) % N;
      measures[side].circ[idx] = Math.max(measures[side].circ[idx] ?? 0, dist);
    }
    renderCircProgress();
  }
  throttledDraw();
}

const throttledDraw = (() => {
  let t = null;
  return () => { if (!t) t = setTimeout(() => { t = null; drawCanvas(); }, 30); };
})();

function drawCanvas() {
  for (const id of ['tcc-canvas', 'tcc-tmr-canvas', 'tcx-canvas']) {
    const c = document.getElementById(id);
    if (!c || !c.offsetParent) continue;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const st = currentSticks() ?? { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    if (numberOfSticks() === 1) {
      draw_stick_dial(ctx, c.width / 2, 75, 60, st.left.x, st.left.y, { circularity_data: measures.left.circ });
    } else {
      draw_stick_dial(ctx, 80, 75, 60, st.left.x, st.left.y, { circularity_data: measures.left.circ });
      draw_stick_dial(ctx, c.width - 80, 75, 60, st.right.x, st.right.y, { circularity_data: measures.right.circ });
    }
  }
}

// ---------------------------------------------------------------------------
// Mesures
// ---------------------------------------------------------------------------

function measureCenter(statusSel) {
  return new Promise((resolve) => {
    if (!currentSticks() || measures.centerRunning) return resolve(false);
    measures.centerRunning = true;
    const acc = { left: [], right: [] };
    const t0 = Date.now();
    const timer = setInterval(() => {
      const st = currentSticks();
      if (st) { acc.left.push({ ...st.left }); acc.right.push({ ...st.right }); }
      const left = Math.max(0, CLIENT_CONFIG.centerSampleMs - (Date.now() - t0));
      $(statusSel).html(`<span class="text-warning"><i class="fas fa-hand me-1"></i>Ne touchez pas les joysticks… ${(left / 1000).toFixed(1)} s</span>`);
      if (left > 0) return;
      clearInterval(timer);
      for (const side of ['left', 'right']) {
        const pts = acc[side];
        if (!pts.length) continue;
        measures[side].center = {
          meanX: pts.reduce((a, p) => a + p.x, 0) / pts.length,
          meanY: pts.reduce((a, p) => a + p.y, 0) / pts.length,
          maxOffset: Math.max(...pts.map(p => Math.hypot(p.x, p.y))),
        };
      }
      measures.centerRunning = false;
      resolve(true);
    }, 20);
  });
}

function startCirc(context) {
  for (const side of ['left', 'right']) measures[side].circ.fill(0);
  measures.circRunning = true;
  measures.circContext = context;
}

function stopCirc() {
  measures.circRunning = false;
}

function renderCircProgress() {
  const sel = measures.circContext === 'verify' ? '#tcc-verify-status' : '#tcc-circ-status, #tcx-circ-status';
  const parts = sides().map(side => {
    const { covered } = circularity(side);
    const p = Math.min(100, Math.round(covered / CLIENT_CONFIG.circularityMinBins * 100));
    return `<div class="small">${esc(sideName(side))}</div>
      <div class="progress mb-1" style="height: 8px;"><div class="progress-bar ${p >= 100 ? 'bg-success' : ''}" style="width:${p}%"></div></div>`;
  });
  $(sel).html(`<div class="small text-warning mb-1"><i class="fas fa-rotate me-1"></i>Faites des tours complets, joystick poussé à fond, dans les deux sens.</div>${parts.join('')}`);
}

function stickVerdicts() {
  return sides().map(side => {
    const c = measures[side].center;
    const circ = circularity(side);
    return {
      side,
      center: c ? c.maxOffset : null,
      centerOk: c ? c.maxOffset <= CLIENT_CONFIG.centerMaxOffset : null,
      circ: circ.error,
      circOk: circ.error == null ? null : circ.error <= CLIENT_CONFIG.circularityMax,
      covered: circ.covered,
    };
  });
}

function stickResultHtml(v) {
  const mark = (ok) => ok == null ? '<span class="text-muted">non mesuré</span>' : ok ? '<span class="text-success fw-bold">✔ OK</span>' : '<span class="text-danger fw-bold">✘ Hors tolérance</span>';
  return v.map(s => `<div class="small"><b class="text-capitalize">${esc(sideName(s.side))}</b> — drift : ${s.center == null ? '' : pct(s.center) + ' '}${mark(s.centerOk)} · circularité : ${s.circ == null ? '' : s.circ.toFixed(1) + ' % '}${mark(s.circOk)}</div>`).join('');
}

// ---------------------------------------------------------------------------
// Pré-diagnostic : actions
// ---------------------------------------------------------------------------

export async function tcc_measure_drift() {
  $('#tcc-drift-btn, #tcx-drift-btn').prop('disabled', true);
  await measureCenter('#tcc-drift-status, #tcx-drift-status');
  $('#tcc-drift-btn, #tcx-drift-btn').prop('disabled', false);
  renderSticks();
}

export function tcc_toggle_circ() {
  if (!measures.circRunning) {
    startCirc('diag');
    $('#tcc-circ-btn, #tcx-circ-btn').removeClass('btn-outline-primary').addClass('btn-warning').html('<i class="fas fa-stop me-1"></i>J\'ai terminé');
    renderCircProgress();
  } else {
    stopCirc();
    $('#tcc-circ-btn, #tcx-circ-btn').removeClass('btn-warning').addClass('btn-outline-primary').html('<i class="fas fa-circle-notch me-1"></i>Tester l\'amplitude');
    renderSticks();
  }
}

export function tcc_open_quick_test() {
  window.show_quick_test_modal?.();
  // Mise à jour du résumé à la fermeture
  $('#quickTestModal').one('hidden.bs.modal', () => renderTests());
}

// ---------------------------------------------------------------------------
// Pré-diagnostic : calcul
// ---------------------------------------------------------------------------

function stickProblems() {
  const sticks = stickVerdicts();
  const problems = [];
  let stickIssue = false;
  for (const st of sticks) {
    if (st.centerOk === false) { stickIssue = true; problems.push(`Drift détecté sur le ${sideName(st.side)} (décalage au repos ${pct(st.center)})`); }
    if (st.circOk === false) { stickIssue = true; problems.push(`Amplitude irrégulière sur le ${sideName(st.side)} (circularité ${st.circ.toFixed(1)} %)`); }
  }
  const notChecked = [];
  if (sticks.some(x => x.centerOk == null)) notChecked.push('drift des joysticks non mesuré');
  if (sticks.some(x => x.circOk == null)) notChecked.push('amplitude des joysticks non mesurée');
  return { problems, notChecked, stickIssue };
}

/** Prestations + règle du double forfait (le plus cher plein tarif, le 2e à -50 %) */
function priceServices(services) {
  services = services.filter((o, i, arr) => arr.findIndex(x => x.name === o.name) === i);
  let lines = [];
  let total = null;
  if (services.length && services.every(o => o.price != null)) {
    const sorted = [...services].sort((a, b) => b.price - a.price);
    lines = sorted.map((o, i) => ({ name: o.name, price: i === 0 ? o.price : o.price / 2, discounted: i > 0, full: o.price }));
    total = lines.reduce((a, l) => a + l.price, 0);
  } else {
    lines = services.map(o => ({ name: o.name, price: o.price, discounted: false, full: o.price }));
  }
  return { lines, total };
}

function computeDiagnosis() {
  if (xbox.active) return computeXboxDiagnosis();
  const s = tcSession;
  const model = s.model;
  const tests = s.supportedQuickTests.length ? s.supportedQuickTests : Object.keys(s.quickTests);
  const failed = tests.filter(id => s.quickTests[id] === false);
  const untested = tests.filter(id => s.quickTests[id] !== true && s.quickTests[id] !== false);
  const sp = stickProblems();
  const problems = [...sp.problems];
  const stickIssue = sp.stickIssue;
  failed.forEach(id => problems.push(`Défaut constaté : ${QUICK_TEST_LABELS_FR[id] || id}`));
  const otherIssue = failed.length > 0;

  const notChecked = [];
  if (untested.length) notChecked.push(`${untested.length} test(s) fonctionnel(s) non réalisé(s)`);
  notChecked.push(...sp.notChecked);

  // Prestations conseillées
  let services = [];
  const offers = CLIENT_CONFIG.offers[model];
  if (!s.isClone && offers) {
    if (stickIssue) services.push(offers.sticks);
    if (otherIssue) services.push(offers.other);
  } else if (!s.isClone && (stickIssue || otherIssue)) {
    services.push({ name: 'Réparation manette', price: null });
  }
  const { lines, total } = priceServices(services);

  return { problems, notChecked, lines, total, isClone: s.isClone, hasProblem: problems.length > 0 };
}

function diagnosisText(d) {
  const s = tcSession;
  const device = xbox.active
    ? `Manette : ${CLIENT_CONFIG.xboxModels[xbox.model]?.label || 'Xbox (modèle non précisé)'}`
    : `Manette : ${s.deviceName || '?'}${s.serialNumber ? ` – n° ${s.serialNumber}` : ''}`;
  const out = [
    `Pré-diagnostic ${CLIENT_CONFIG.toolName} – ${new Date().toLocaleString('fr-FR')}`,
    device,
  ];
  if (d.isClone) out.push('Attention : manette détectée comme non d\'origine.');
  out.push(d.problems.length ? `Problèmes détectés :\n- ${d.problems.join('\n- ')}` : 'Aucun défaut détecté par le test.');
  if (d.lines.length) {
    out.push(`Prestation conseillée : ${d.lines.map(l => `${l.name}${l.price != null ? ` (${euros(l.price)}${l.discounted ? ', 2e forfait -50 %' : ''})` : ' (sur devis)'}`).join(' + ')}`);
    if (d.total != null) out.push(`Estimation : ${euros(d.total)}`);
  }
  return out.join('\n');
}

export function tcc_show_diagnosis() {
  if (measures.circRunning) tcc_toggle_circ();
  const d = computeDiagnosis();
  let html = '';

  if (d.isClone) {
    html += `<div class="alert alert-warning small"><i class="fas fa-triangle-exclamation me-1"></i>
      Cette manette ne semble pas être un modèle d'origine Sony. Contactez-nous avant de prendre rendez-vous : nous vous dirons si une réparation est possible.</div>`;
  }

  if (!d.hasProblem) {
    html += `<div class="alert alert-success"><b><i class="fas fa-circle-check me-1"></i>Aucun défaut détecté.</b><br>
      <span class="small">Votre manette a réussi les tests réalisés. Si vous constatez quand même un problème (souvent intermittent), le diagnostic en atelier est gratuit.</span></div>`;
  } else {
    html += `<div class="alert alert-danger mb-2"><b><i class="fas fa-screwdriver-wrench me-1"></i>Problème(s) détecté(s)</b>
      <ul class="small mb-0 mt-1">${d.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
    if (d.lines.length) {
      html += `<div class="card mb-2"><div class="card-body py-2">
        <div class="small text-muted mb-1">Prestation conseillée</div>
        ${d.lines.map(l => `<div class="d-flex justify-content-between"><span>${esc(l.name)}${l.discounted ? ' <span class="badge bg-success">2e forfait -50 %</span>' : ''}</span>
          <b>${l.price == null ? 'Sur devis' : (l.discounted ? `<s class="text-muted fw-normal me-1">${euros(l.full)}</s>` : '') + euros(l.price)}</b></div>`).join('')}
        ${d.total != null && d.lines.length > 1 ? `<hr class="my-1"><div class="d-flex justify-content-between"><span>Total estimé</span><b>${euros(d.total)}</b></div>` : ''}
        <div class="small text-muted mt-1">Estimation indicative. Diagnostic gratuit en atelier, prix confirmé avant toute intervention.</div>
      </div></div>`;
    }
  }

  if (d.needModel) {
    html += `<div class="alert alert-warning small py-2"><i class="fas fa-hand-pointer me-1"></i>Choisissez le modèle de votre manette en haut du test pour afficher le prix conseillé.</div>`;
  }

  if (d.notChecked.length) {
    html += `<div class="small text-muted mb-2"><i class="fas fa-circle-info me-1"></i>Pour un résultat complet : ${esc(d.notChecked.join(', '))}.</div>`;
  }

  html += `<div class="d-flex gap-2 flex-wrap">
      <button type="button" class="btn btn-success" onclick="tcc_book()"><i class="fas fa-calendar-check me-1"></i>Prendre rendez-vous</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" onclick="tcc_copy_diagnosis()"><i class="fas fa-copy me-1"></i>Copier mon diagnostic</button>
    </div>
    <div class="small mt-2" id="tcc-copy-msg"></div>
    <div class="small text-muted mt-2">Une question ? ${esc(CLIENT_CONFIG.phone)} · <a href="mailto:${esc(CLIENT_CONFIG.email)}">${esc(CLIENT_CONFIG.email)}</a></div>`;

  const target = xbox.active ? 'tcx-result' : 'tcc-result';
  $('#' + target).html(html).show();
  document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export async function tcc_copy_diagnosis() {
  const ok = await copyText(diagnosisText(computeDiagnosis()));
  $('#tcc-copy-msg').html(ok ? '<span class="text-success">Diagnostic copié.</span>' : '<span class="text-danger">Copie impossible sur ce navigateur.</span>');
}

export async function tcc_book() {
  const win = window.open(CLIENT_CONFIG.bookingUrl, '_blank');
  const ok = await copyText(diagnosisText(computeDiagnosis()));
  $('#tcc-copy-msg').html(ok
    ? '<span class="text-success"><i class="fas fa-clipboard-check me-1"></i>Votre diagnostic est copié : collez-le (Ctrl+V) dans le champ message du formulaire de réservation.</span>'
    : '');
  if (!win) location.href = CLIENT_CONFIG.bookingUrl;
}

// ---------------------------------------------------------------------------
// Recalibrage TMR
// ---------------------------------------------------------------------------

export async function tcc_unlock() {
  const serial = tcSession.serialNumber;
  const code = $('#tcc-code-input').val();
  if (!serial) { $('#tcc-code-msg').html('<span class="text-danger">Connectez d\'abord votre manette.</span>'); return; }
  if (await checkTmrCode(serial, code)) {
    tmr.unlocked = true;
    saveUnlocked(serial);
    $('#tcc-code-msg').html('');
    renderTmr();
  } else {
    $('#tcc-code-msg').html(`<span class="text-danger">Code incorrect pour cette manette (n° ${esc(serial)}). Vérifiez le code sur votre rapport Tech-Cleaner ou contactez-nous.</span>`);
  }
}

export function tcc_tmr_center() {
  deps.calibrateCenter((success) => {
    if (success) { tmr.centerDone = true; tmr.verified = null; }
    renderTmr();
  });
}

export function tcc_tmr_range() {
  deps.calibrateRange((success) => {
    if (success) { tmr.rangeDone = true; tmr.verified = null; }
    renderTmr();
  });
}

export async function tcc_tmr_verify() {
  if (measures.circRunning && measures.circContext === 'verify') {
    stopCirc();
    const v = stickVerdicts();
    const coverOk = v.every(s => s.covered >= CLIENT_CONFIG.circularityMinBins);
    tmr.verified = coverOk && v.every(s => s.centerOk && s.circOk);
    tmr.lastVerdicts = v;
    tmr.coverOk = coverOk;
    renderTmr();
    return;
  }
  $('#tcc-verify-btn').prop('disabled', true);
  resetMeasures();
  await measureCenter('#tcc-verify-status');
  startCirc('verify');
  renderCircProgress();
  $('#tcc-verify-btn').prop('disabled', false).removeClass('btn-primary').addClass('btn-warning').html('<i class="fas fa-stop me-1"></i>J\'ai fait plusieurs tours');
}

export async function tcc_tmr_save() {
  $('#tcc-save-btn').prop('disabled', true);
  try {
    await deps.save();
    tmr.saved = true;
  } finally {
    renderTmr();
  }
}

export async function tcc_tmr_cancel() {
  await deps.reboot();
  Object.assign(tmr, { centerDone: false, rangeDone: false, verified: null });
  renderTmr();
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function renderTests() {
  const s = tcSession;
  const tests = s.supportedQuickTests;
  if (!tests.length) { $('#tcc-tests-summary').html(''); return; }
  const done = tests.filter(id => s.quickTests[id] === true || s.quickTests[id] === false).length;
  const ko = tests.filter(id => s.quickTests[id] === false);
  $('#tcc-tests-summary').html(done === 0
    ? '<span class="text-muted">Pas encore réalisé.</span>'
    : `${done}/${tests.length} tests réalisés${ko.length ? ` — <span class="text-danger fw-bold">${ko.length} défaut(s) : ${esc(ko.map(id => QUICK_TEST_LABELS_FR[id] || id).join(', '))}</span>` : ' — <span class="text-success fw-bold">aucun défaut</span>'}`);
}

function renderSticks() {
  const v = stickVerdicts();
  const driftHtml = v.map(s => `<div class="small"><b class="text-capitalize">${esc(sideName(s.side))}</b> — ${s.center == null ? '<span class="text-muted">non mesuré</span>' : `${pct(s.center)} ${s.centerOk ? '<span class="text-success fw-bold">✔ OK</span>' : '<span class="text-danger fw-bold">✘ Drift</span>'}`}</div>`).join('');
  $('#tcc-drift-status, #tcx-drift-status').html(v.some(s => s.center != null) ? `<div class="small fw-semibold">Drift au repos</div>${driftHtml}` : '');
  const circHtml = v.map(s => `<div class="small"><b class="text-capitalize">${esc(sideName(s.side))}</b> — ${s.circ == null ? '<span class="text-muted">non mesuré</span>' : `${s.circ.toFixed(1)} % ${s.circOk ? '<span class="text-success fw-bold">✔ OK</span>' : '<span class="text-danger fw-bold">✘ Hors tolérance</span>'}`}${s.circ != null && s.covered < CLIENT_CONFIG.circularityMinBins ? ' <span class="text-warning">(tours incomplets)</span>' : ''}</div>`).join('');
  $('#tcc-circ-status, #tcx-circ-status').html(v.some(s => s.circ != null) ? `<div class="small fw-semibold mt-1">Amplitude (circularité)</div>${circHtml}` : '');
  drawCanvas();
}

function renderTmr() {
  const connected = !!tcSession.serialNumber;
  $('#tcc-tmr-locked').toggle(!tmr.unlocked);
  $('#tcc-tmr-steps').toggle(tmr.unlocked);
  $('#tcc-code-input, #tcc-code-btn').prop('disabled', !connected);
  if (!tmr.unlocked) return;

  const stepState = (done) => done ? '<i class="fas fa-circle-check text-success"></i>' : '<i class="far fa-circle text-muted"></i>';
  $('#tcc-step1-state').html(stepState(tmr.centerDone));
  $('#tcc-step2-state').html(stepState(tmr.rangeDone));
  $('#tcc-step3-state').html(stepState(tmr.verified === true));
  $('#tcc-step4-state').html(stepState(tmr.saved));

  $('#tcc-range-btn').prop('disabled', !tmr.centerDone || tmr.saved);
  $('#tcc-center-btn').prop('disabled', tmr.saved);
  $('#tcc-verify-btn').prop('disabled', !tmr.rangeDone || tmr.saved)
    .removeClass('btn-warning').addClass('btn-primary').html('<i class="fas fa-magnifying-glass me-1"></i>Vérifier le résultat');
  $('#tcc-save-btn').prop('disabled', tmr.verified !== true || tmr.saved);
  $('#tcc-cancel-btn').toggle((tmr.centerDone || tmr.rangeDone) && !tmr.saved);

  if (tmr.verified === true) {
    $('#tcc-verify-status').html(`<div class="text-success small fw-bold mb-1">Calibrage correct, vous pouvez l'enregistrer.</div>${stickResultHtml(tmr.lastVerdicts)}`);
  } else if (tmr.verified === false) {
    $('#tcc-verify-status').html(`<div class="text-danger small fw-bold mb-1">${tmr.coverOk ? 'Résultat hors tolérance.' : 'Tours incomplets : faites plusieurs tours complets, joystick poussé à fond.'}
      Recommencez l'étape 2${tmr.coverOk ? ' (ou les étapes 1 et 2)' : ''}, puis vérifiez à nouveau. Si le problème persiste, contactez-nous.</div>${stickResultHtml(tmr.lastVerdicts)}`);
  } else if (!measures.circRunning && !measures.centerRunning) {
    $('#tcc-verify-status').html('');
  }

  $('#tcc-saved-msg').toggle(tmr.saved);
}

function renderAll() {
  const s = tcSession;
  $('#tcc-model').text(s.deviceName || '');
  renderTests();
  renderSticks();
  renderTmr();
}

// ---------------------------------------------------------------------------
// Manettes Xbox (Gamepad API) : test seul, sans calibrage
// ---------------------------------------------------------------------------

// Boutons à tester (disposition « standard » des navigateurs)
const XBOX_BUTTONS = [
  { i: 0, label: 'A', name: 'A' }, { i: 1, label: 'B', name: 'B' }, { i: 2, label: 'X', name: 'X' }, { i: 3, label: 'Y', name: 'Y' },
  { i: 4, label: 'LB', name: 'LB' }, { i: 5, label: 'RB', name: 'RB' }, { i: 6, label: 'LT', name: 'LT' }, { i: 7, label: 'RT', name: 'RT' },
  { i: 8, label: 'View', name: 'View' }, { i: 9, label: 'Menu', name: 'Menu' },
  { i: 10, label: 'L3', name: 'L3 (clic du stick gauche)' }, { i: 11, label: 'R3', name: 'R3 (clic du stick droit)' },
  { i: 12, label: '↑', name: 'croix haut' }, { i: 13, label: '↓', name: 'croix bas' }, { i: 14, label: '←', name: 'croix gauche' }, { i: 15, label: '→', name: 'croix droite' },
];

// Identifiants USB (visibles sur Mac, Linux, Android ; pas sous Windows où le modèle est demandé au client)
const XBOX_PRODUCTS = {
  '02d1': 'one', '02dd': 'one', '02e0': 'one', '02ea': 'one', '02fd': 'one',
  '0b12': 'series', '0b13': 'series', '0b20': 'series', '0b21': 'series',
  '0b00': 'elite2', '0b05': 'elite2', '0b22': 'elite2',
};
const VENDOR_SONY = '054c';
const VENDOR_MICROSOFT = '045e';
const VENDOR_SCUF = '2e95';

/** Classe une manette d'après l'identifiant fourni par le navigateur */
export function classifyGamepad(id) {
  const s = String(id || '');
  const m = s.match(/Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})/i) || s.match(/^([0-9a-f]{4})-([0-9a-f]{4})-/i);
  const vendor = m ? m[1].toLowerCase() : null;
  const product = m ? m[2].toLowerCase() : null;
  if (vendor === VENDOR_SONY || (!vendor && /dualsense|dualshock|playstation|wireless controller/i.test(s))) return { kind: 'sony' };
  if (vendor === VENDOR_MICROSOFT) return { kind: 'xbox', model: XBOX_PRODUCTS[product] || null };
  if (vendor === VENDOR_SCUF) return { kind: 'xbox', model: 'scuf' };
  if (!vendor && /xinput|xbox/i.test(s)) return { kind: 'xbox', model: null }; // Windows : toutes les manettes Xbox
  return { kind: 'unsupported' };
}

function sonyConnected() {
  return !!deps.getController()?.currentController;
}

function startGamepadDetection() {
  if (!('getGamepads' in navigator)) return;
  window.addEventListener('gamepadconnected', (e) => onGamepadFound(e.gamepad));
  window.addEventListener('gamepaddisconnected', (e) => {
    if (xbox.active && e.gamepad.index === xbox.index) {
      xbox.index = null;
      $('#tcx-lost').show();
    }
  });
  // Filet de sécurité si l'événement a été manqué
  setInterval(() => {
    if ((xbox.active && xbox.index != null) || sonyConnected()) return;
    for (const gp of navigator.getGamepads()) if (gp) onGamepadFound(gp);
  }, 1000);
}

function onGamepadFound(gp) {
  if (!gp || sonyConnected()) return;
  const c = classifyGamepad(gp.id);
  if (xbox.active) {
    // reconnexion de la manette en cours de test
    if (xbox.index == null && c.kind === 'xbox') { xbox.index = gp.index; $('#tcx-lost').hide(); }
    return;
  }
  if (c.kind === 'sony') { $('#tcx-sony-hint').show(); return; }
  if (c.kind === 'unsupported') { if (!xbox.unsupportedShown) showUnsupported(); return; }
  activateXbox(gp.index, c.model);
}

function showUnsupported() {
  xbox.unsupportedShown = true;
  $('#tcx-panel').show();
  $('#tcx-test').hide();
  $('#tcx-unsupported').show();
}

function activateXbox(index, model) {
  Object.assign(xbox, {
    active: true, index, model, pressed: new Set(), triggerMax: [0, 0], rumble: null, triggerRumble: null,
  });
  resetMeasures();
  $('#offlinebar').hide();
  $('#tcx-panel').show();
  $('#tcx-unsupported, #tcx-lost').hide();
  $('#tcx-test').show();
  $('#tcx-result').hide().html('');
  renderXboxButtons(new Set());
  renderXboxModel();
  renderXboxRumble();
  renderSticks();
  if (!xbox.raf) xbox.raf = requestAnimationFrame(pollXbox);
}

function stopXbox() {
  if (xbox.raf) cancelAnimationFrame(xbox.raf);
  xbox.raf = null;
  xbox.active = false;
}

let lastPressedKey = '';
function pollXbox() {
  xbox.raf = null;
  if (!xbox.active) return;
  const gp = xbox.index != null ? navigator.getGamepads()[xbox.index] : null;
  if (gp) {
    const ax = gp.axes;
    xbox.sticks = { left: { x: ax[0] || 0, y: ax[1] || 0 }, right: { x: ax[2] || 0, y: ax[3] || 0 } };
    const now = new Set();
    gp.buttons.forEach((b, i) => { if (b.pressed) { now.add(i); xbox.pressed.add(i); } });
    [6, 7].forEach((bi, k) => { xbox.triggerMax[k] = Math.max(xbox.triggerMax[k], gp.buttons[bi]?.value || 0); });
    const key = [...now].join(',') + '|' + gp.buttons[6]?.value?.toFixed(2) + '|' + gp.buttons[7]?.value?.toFixed(2);
    if (key !== lastPressedKey) { lastPressedKey = key; renderXboxButtons(now, gp); }
    tc_client_handle_input({ sticks: xbox.sticks });
  }
  xbox.raf = requestAnimationFrame(pollXbox);
}

function renderXboxButtons(now, gp = null) {
  const html = XBOX_BUTTONS.map(b => {
    const tested = xbox.pressed.has(b.i);
    const down = now.has(b.i);
    const cls = down ? 'bg-primary text-white border-primary' : tested ? 'bg-success text-white border-success' : 'bg-body-tertiary';
    return `<span class="tcx-btn border rounded ${cls}" title="${esc(b.name)}">${esc(b.label)}</span>`;
  }).join('');
  $('#tcx-buttons').html(html);
  const done = XBOX_BUTTONS.filter(b => xbox.pressed.has(b.i)).length;
  $('#tcx-buttons-count').html(`${done}/${XBOX_BUTTONS.length} boutons testés${done === XBOX_BUTTONS.length ? ' <span class="text-success fw-bold">✔</span>' : ''}`);
  [0, 1].forEach(k => {
    const cur = gp?.buttons[6 + k]?.value || 0;
    const max = xbox.triggerMax[k];
    $(`#tcx-trig-${k} .progress-bar`).css('width', `${Math.round(cur * 100)}%`);
    $(`#tcx-trig-${k}-max`).html(max > 0 ? `course max ${Math.round(max * 100)} % ${max >= 0.9 ? '<span class="text-success fw-bold">✔</span>' : ''}` : '');
  });
}

function renderXboxModel() {
  $('#tcx-models .btn').each((_, el) => {
    const on = el.dataset.model === xbox.model;
    $(el).toggleClass('btn-primary', on).toggleClass('btn-outline-primary', !on);
  });
  const other = xbox.model === 'other';
  $('#tcx-test-body').toggle(!other);
  $('#tcx-other-msg').toggle(other);
}

export function tcx_select_model(model) {
  xbox.model = model;
  renderXboxModel();
  if ($('#tcx-result').is(':visible')) tcc_show_diagnosis();
}

function rumbleSupport() {
  const act = xbox.index != null ? navigator.getGamepads()[xbox.index]?.vibrationActuator : null;
  return {
    main: !!act,
    trigger: !!act && Array.isArray(act.effects) && act.effects.includes('trigger-rumble'),
  };
}

function renderXboxRumble() {
  const sup = rumbleSupport();
  $('#tcx-rumble-main').toggle(sup.main);
  $('#tcx-rumble-trigger').toggle(sup.trigger);
  $('#tcx-rumble-none').toggle(!sup.main);
  const st = (v) => v === true ? '<span class="text-success fw-bold">✔ OK</span>' : v === false ? '<span class="text-danger fw-bold">✘ Aucune vibration</span>' : '';
  $('#tcx-rumble-main-state').html(st(xbox.rumble));
  $('#tcx-rumble-trigger-state').html(st(xbox.triggerRumble));
}

export async function tcx_rumble(kind) {
  const act = xbox.index != null ? navigator.getGamepads()[xbox.index]?.vibrationActuator : null;
  if (!act) return;
  const $q = $(`#tcx-rumble-${kind}-q`);
  try {
    if (kind === 'trigger') await act.playEffect('trigger-rumble', { duration: 1200, leftTrigger: 1, rightTrigger: 1 });
    else await act.playEffect('dual-rumble', { duration: 1200, strongMagnitude: 1, weakMagnitude: 1 });
  } catch (e) { /* certains navigateurs refusent : on pose quand même la question */ }
  $q.show();
}

export function tcx_rumble_answer(kind, ok) {
  if (kind === 'trigger') xbox.triggerRumble = ok; else xbox.rumble = ok;
  $(`#tcx-rumble-${kind}-q`).hide();
  renderXboxRumble();
}

export function tcx_restart() {
  location.reload();
}

function computeXboxDiagnosis() {
  const sp = stickProblems();
  const problems = [...sp.problems];
  const notChecked = [...sp.notChecked];
  let otherIssue = false;

  if (xbox.pressed.size >= 4) {
    const missing = XBOX_BUTTONS.filter(b => !xbox.pressed.has(b.i));
    if (missing.length) {
      otherIssue = true;
      problems.push(`Bouton(s) sans réponse pendant le test : ${missing.map(b => b.name).join(', ')}`);
    }
  } else {
    notChecked.push('test des boutons non réalisé');
  }
  [0, 1].forEach(k => {
    const v = xbox.triggerMax[k];
    if (v > 0.1 && v < 0.9) { otherIssue = true; problems.push(`Course incomplète de la gâchette ${k ? 'droite (RT)' : 'gauche (LT)'} (${Math.round(v * 100)} %)`); }
  });
  if (xbox.rumble === false) { otherIssue = true; problems.push('Vibrations : aucune vibration ressentie'); }
  if (xbox.triggerRumble === false) { otherIssue = true; problems.push('Vibrations des gâchettes : aucune vibration ressentie'); }
  if (xbox.rumble === null && rumbleSupport().main) notChecked.push('vibrations non testées');

  const offer = CLIENT_CONFIG.xboxModels[xbox.model];
  const services = [];
  if (offer) {
    if (sp.stickIssue) services.push(offer.sticks);
    if (otherIssue) services.push(offer.other);
  }
  const { lines, total } = priceServices(services);
  return { problems, notChecked, lines, total, isClone: false, hasProblem: problems.length > 0, needModel: !offer && problems.length > 0 };
}

// Exposition pour les onclick
Object.assign(window, {
  tcc_measure_drift, tcc_toggle_circ, tcc_open_quick_test, tcc_show_diagnosis, tcc_copy_diagnosis, tcc_book,
  tcc_unlock, tcc_tmr_center, tcc_tmr_range, tcc_tmr_verify, tcc_tmr_save, tcc_tmr_cancel,
  tcx_select_model, tcx_rumble, tcx_rumble_answer, tcx_restart,
});
