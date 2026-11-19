'use strict';

/**
 * Tech-Cleaner : choix de la version affichée.
 *
 * Le même code sert pour les deux sites :
 *  - version CLIENT  : sur les adresses listées dans CLIENT_HOSTS (site public)
 *  - version ATELIER : partout ailleurs (ex. prozac-reloaded.github.io/banc-test)
 *
 * Pour prévisualiser la version client depuis l'atelier : ajouter ?client à l'adresse.
 */

export const CLIENT_HOSTS = [
  'test-manette.techcleaner.fr',
];

function detectClientMode() {
  try {
    if (CLIENT_HOSTS.includes(location.hostname)) return true;
    return new URLSearchParams(location.search).has('client');
  } catch {
    return false;
  }
}

export const TC_CLIENT_MODE = detectClientMode();

if (TC_CLIENT_MODE) {
  document.documentElement.classList.add('tc-client');
}
