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
  return deps.getController()?.currentController?.getNumberOfSticks?.() ?? 2;
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
}

export function tcClientOnConnected() {
  if (!TC_CLIENT_MODE) return;
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
  for (const id of ['tcc-canvas', 'tcc-tmr-canvas']) {
    const c = document.getElementById(id);
    if (!c || !c.offsetParent) continue;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const st = deps.getController()?.button_states?.sticks ?? { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
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
    const ctrl = deps.getController();
    if (!ctrl || measures.centerRunning) return resolve(false);
    measures.centerRunning = true;
    const acc = { left: [], right: [] };
    const t0 = Date.now();
    const timer = setInterval(() => {
      const st = ctrl.button_states?.sticks;
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
  const sel = measures.circContext === 'verify' ? '#tcc-verify-status' : '#tcc-circ-status';
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
  $('#tcc-drift-btn').prop('disabled', true);
  await measureCenter('#tcc-drift-status');
  $('#tcc-drift-btn').prop('disabled', false);
  renderSticks();
}

export function tcc_toggle_circ() {
  if (!measures.circRunning) {
    startCirc('diag');
    $('#tcc-circ-btn').removeClass('btn-outline-primary').addClass('btn-warning').html('<i class="fas fa-stop me-1"></i>J\'ai terminé');
    renderCircProgress();
  } else {
    stopCirc();
    $('#tcc-circ-btn').removeClass('btn-warning').addClass('btn-outline-primary').html('<i class="fas fa-circle-notch me-1"></i>Tester l\'amplitude');
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

function computeDiagnosis() {
  const s = tcSession;
  const model = s.model;
  const tests = s.supportedQuickTests.length ? s.supportedQuickTests : Object.keys(s.quickTests);
  const failed = tests.filter(id => s.quickTests[id] === false);
  const untested = tests.filter(id => s.quickTests[id] !== true && s.quickTests[id] !== false);
  const sticks = stickVerdicts();

  const problems = [];
  let stickIssue = false;
  for (const st of sticks) {
    if (st.centerOk === false) { stickIssue = true; problems.push(`Drift détecté sur le ${sideName(st.side)} (décalage au repos ${pct(st.center)})`); }
    if (st.circOk === false) { stickIssue = true; problems.push(`Amplitude irrégulière sur le ${sideName(st.side)} (circularité ${st.circ.toFixed(1)} %)`); }
  }
  failed.forEach(id => problems.push(`Défaut constaté : ${QUICK_TEST_LABELS_FR[id] || id}`));
  const otherIssue = failed.length > 0;

  const notChecked = [];
  if (untested.length) notChecked.push(`${untested.length} test(s) fonctionnel(s) non réalisé(s)`);
  if (sticks.some(x => x.centerOk == null)) notChecked.push('drift des joysticks non mesuré');
  if (sticks.some(x => x.circOk == null)) notChecked.push('amplitude des joysticks non mesurée');

  // Prestations conseillées
  let services = [];
  const offers = CLIENT_CONFIG.offers[model];
  if (!s.isClone && offers) {
    if (stickIssue) services.push(offers.sticks);
    if (otherIssue) services.push(offers.other);
    // une même prestation ne compte qu'une fois
    services = services.filter((o, i, arr) => arr.findIndex(x => x.name === o.name) === i);
  } else if (!s.isClone && (stickIssue || otherIssue)) {
    services.push({ name: 'Réparation manette', price: null });
  }

  // Double forfait : le plus cher plein tarif, le 2e à -50 %
  let lines = [];
  let total = null;
  if (services.length && services.every(o => o.price != null)) {
    const sorted = [...services].sort((a, b) => b.price - a.price);
    lines = sorted.map((o, i) => ({ name: o.name, price: i === 0 ? o.price : o.price / 2, discounted: i > 0, full: o.price }));
    total = lines.reduce((a, l) => a + l.price, 0);
  } else {
    lines = services.map(o => ({ name: o.name, price: o.price, discounted: false, full: o.price }));
  }

  return { problems, notChecked, lines, total, isClone: s.isClone, hasProblem: problems.length > 0 };
}

function diagnosisText(d) {
  const s = tcSession;
  const out = [
    `Pré-diagnostic ${CLIENT_CONFIG.toolName} – ${new Date().toLocaleString('fr-FR')}`,
    `Manette : ${s.deviceName || '?'}${s.serialNumber ? ` – n° ${s.serialNumber}` : ''}`,
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

  if (d.notChecked.length) {
    html += `<div class="small text-muted mb-2"><i class="fas fa-circle-info me-1"></i>Pour un résultat complet : ${esc(d.notChecked.join(', '))}.</div>`;
  }

  html += `<div class="d-flex gap-2 flex-wrap">
      <button type="button" class="btn btn-success" onclick="tcc_book()"><i class="fas fa-calendar-check me-1"></i>Prendre rendez-vous</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" onclick="tcc_copy_diagnosis()"><i class="fas fa-copy me-1"></i>Copier mon diagnostic</button>
    </div>
    <div class="small mt-2" id="tcc-copy-msg"></div>
    <div class="small text-muted mt-2">Une question ? ${esc(CLIENT_CONFIG.phone)} · <a href="mailto:${esc(CLIENT_CONFIG.email)}">${esc(CLIENT_CONFIG.email)}</a></div>`;

  $('#tcc-result').html(html).show();
  document.getElementById('tcc-result')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  $('#tcc-drift-status').html(v.some(s => s.center != null) ? `<div class="small fw-semibold">Drift au repos</div>${driftHtml}` : '');
  const circHtml = v.map(s => `<div class="small"><b class="text-capitalize">${esc(sideName(s.side))}</b> — ${s.circ == null ? '<span class="text-muted">non mesuré</span>' : `${s.circ.toFixed(1)} % ${s.circOk ? '<span class="text-success fw-bold">✔ OK</span>' : '<span class="text-danger fw-bold">✘ Hors tolérance</span>'}`}${s.circ != null && s.covered < CLIENT_CONFIG.circularityMinBins ? ' <span class="text-warning">(tours incomplets)</span>' : ''}</div>`).join('');
  $('#tcc-circ-status').html(v.some(s => s.circ != null) ? `<div class="small fw-semibold mt-1">Amplitude (circularité)</div>${circHtml}` : '');
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

// Exposition pour les onclick
Object.assign(window, {
  tcc_measure_drift, tcc_toggle_circ, tcc_open_quick_test, tcc_show_diagnosis, tcc_copy_diagnosis, tcc_book,
  tcc_unlock, tcc_tmr_center, tcc_tmr_range, tcc_tmr_verify, tcc_tmr_save, tcc_tmr_cancel,
});
