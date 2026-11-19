'use strict';

/**
 * Tech-Cleaner : état de la session de test en cours.
 *
 * Mémorise ce qui a été constaté sur la manette connectée (infos matériel,
 * résultats du Quick Test, enregistrement du calibrage) pour pouvoir
 * l'inclure dans le rapport de bon fonctionnement.
 * Réinitialisé à chaque nouvelle connexion de manette.
 */

export const QUICK_TEST_LABELS_FR = {
  usb: 'Connecteur USB',
  buttons: 'Boutons',
  trackpad: 'Pavé tactile',
  imu: 'Gyroscope / accéléromètre',
  adaptive: 'Gâchettes adaptatives',
  haptic: 'Vibrations (haptique)',
  lights: 'Éclairage LED',
  speaker: 'Haut-parleur',
  headphone: 'Prise casque jack',
  microphone: 'Microphone',
};

function emptySession() {
  return {
    connectedAt: null,
    deviceName: '',
    model: '',
    serialNumber: null,
    isClone: false,
    infoItems: [],
    quickTests: {},          // { usb: true|false|null, ... }
    supportedQuickTests: [],
    calibrationSaved: false, // calibrage enregistré en mémoire permanente
    centerCalibrated: false,
    rangeCalibrated: false,
  };
}

export const tcSession = emptySession();

export function tcResetSession(data = {}) {
  Object.assign(tcSession, emptySession(), data, { connectedAt: new Date().toISOString() });
}

export function tcClearSession() {
  Object.assign(tcSession, emptySession());
}

export function tcSetQuickTestResult(testId, passed) {
  tcSession.quickTests[testId] = passed;
}

export function tcSetSupportedQuickTests(list) {
  tcSession.supportedQuickTests = Array.isArray(list) ? [...list] : [];
}

export function tcMarkCalibration(kind) {
  if (kind === 'saved') tcSession.calibrationSaved = true;
  if (kind === 'center') tcSession.centerCalibrated = true;
  if (kind === 'range') tcSession.rangeCalibrated = true;
}
