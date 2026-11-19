'use strict';

/**
 * Tech-Cleaner : code personnel de recalibrage TMR.
 *
 * Le code est calculé à partir du n° de série de la manette et d'une clé propre
 * à Tech-Cleaner. Même n° de série + même clé = même code, sur la version atelier
 * comme sur la version client : aucune base de données n'est nécessaire.
 *
 * ⚠ Ne pas modifier TMR_SECRET une fois des codes distribués : tous les anciens
 *   codes deviendraient invalides.
 */

const TMR_SECRET = '2egKr6IUZTY1FzS9LMcMMvNjktxHLoU2TMXWEtFn';

// Alphabet sans caractères ambigus (pas de 0/O, 1/I/L, U)
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function normalizeSerial(serial) {
  return String(serial ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Nettoie un code saisi : majuscules, sans espaces ni tirets */
export function normalizeCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

/** Retourne le code au format XXXX-XXXX pour un n° de série donné */
export async function tmrCodeFor(serial) {
  const s = normalizeSerial(serial);
  if (!s) return null;
  const bytes = await sha256(`${TMR_SECRET}|${s}`);
  let out = '';
  for (let i = 0; out.length < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Vérifie un code saisi par le client pour le n° de série de la manette connectée */
export async function checkTmrCode(serial, code) {
  const expected = await tmrCodeFor(serial);
  return !!expected && normalizeCode(expected) === normalizeCode(code);
}
