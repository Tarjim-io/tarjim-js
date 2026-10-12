/*!
 * Tarjim reference client. MIT licensed.
 * A readable, dependency-free client for the Tarjim delivery protocol, loaded as a classic script.
 * Configuration belongs in the page, never in this file, so a self-hosted copy stays identical to
 * the release asset.
 */
(function (root) {
  'use strict';

  var VERSION = '0.0.0';

  function start() {
    return Promise.reject(new Error('not implemented'));
  }

  var TarjimReference = { version: VERSION, start: start };

  root.TarjimReference = TarjimReference;
})(typeof globalThis !== 'undefined' ? globalThis : this);
