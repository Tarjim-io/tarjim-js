/*!
 * Tarjim reference client. MIT licensed.
 * A readable, dependency-free client for the Tarjim delivery protocol, loaded as a classic script.
 * Configuration belongs in the page, never in this file, so a self-hosted copy stays identical to
 * the release asset.
 *
 * One start() runs the whole protocol once: read the meta document, read the manifest it points
 * to, pick ONE locale, download that locale's JSON slice for every bundle, verify, and answer
 * lookups from memory. A language switch is a new start(). Nothing is stored, polled or cached.
 */
(function (root) {
  'use strict';

  var VERSION = '0.1.0';
  var API_VERSION = '2026-07-29';
  var REQUEST_TIMEOUT_MS = 20000;
  var ALLOWED_ATTRIBUTES = ['alt', 'title', 'width', 'height', 'loading'];

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function has(object, name) {
    return Object.prototype.hasOwnProperty.call(object, name);
  }

  // ---------------------------------------------------------------------------------------------
  // Configuration

  function isLoopback(url) {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  }

  // The delivery URL is opaque: it is used exactly as given and its path is never parsed. It must
  // be clean so that the query string this client appends is the only one.
  function deliveryUrlProblem(value) {
    if (typeof value !== 'string' || value === '') return 'deliveryUrl is required';
    var url;
    try {
      url = new URL(value);
    } catch (e) {
      return 'deliveryUrl is not a URL';
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) {
      return 'deliveryUrl must be https';
    }
    if (url.username || url.password || value.indexOf('?') !== -1 || value.indexOf('#') !== -1) {
      return 'deliveryUrl must not have credentials, a query or a fragment';
    }
    if (value.charAt(value.length - 1) === '/') return 'deliveryUrl must not end with a slash';
    return null;
  }

  function configProblem(config, fetchFunction) {
    var problem = deliveryUrlProblem(config.deliveryUrl);
    if (problem) return problem;
    if (typeof config.apiKey !== 'string' || config.apiKey === '') return 'apiKey is required';
    var bundle = config.defaultBundle;
    if (!isObject(bundle) || (bundle.type !== 'namespace' && bundle.type !== 'custom') || typeof bundle.name !== 'string') {
      return 'defaultBundle must be { type: "namespace" | "custom", name }';
    }
    if (typeof config.fallbackLanguage !== 'string' || config.fallbackLanguage === '') return 'fallbackLanguage is required';
    if (config.language !== undefined && typeof config.language !== 'string') return 'language must be a string';
    if (typeof fetchFunction !== 'function') return 'fetch is not available';
    return null;
  }

  // The version travels raw in the query string, so it is reduced to three plain integers first.
  // It never makes start() fail.
  function normaliseAppVersion(value) {
    if (typeof value !== 'string') return '0.0.0';
    var text = value.charAt(0) === 'v' ? value.slice(1) : value;
    var run = /^[0-9.]*/.exec(text)[0];
    var numbers = run.split('.');
    // "2." and "2.x" leave an empty run behind the last dot; it is dropped, not rejected.
    if (numbers.length > 1 && numbers[numbers.length - 1] === '') numbers.pop();
    numbers = numbers.slice(0, 3);
    var parts = [];
    for (var i = 0; i < 3; i++) {
      var digits = numbers[i] === undefined ? '0' : numbers[i];
      if (!/^[0-9]+$/.test(digits)) return '0.0.0';
      var number = parseInt(digits, 10);
      if (!Number.isSafeInteger(number)) return '0.0.0';
      parts.push(String(number));
    }
    var result = parts.join('.');
    return result.length > 32 ? '0.0.0' : result;
  }

  // ---------------------------------------------------------------------------------------------
  // Reports

  // A report tells the page something went wrong. It never carries the API key, a signed query or
  // any header value, and each code is sent once per start().
  function createReporter(onReport) {
    var sent = {};
    return function report(code, message, details) {
      if (sent[code]) return;
      sent[code] = true;
      var entry = Object.assign({ code: code, message: message }, details);
      try {
        if (typeof root.console !== 'undefined' && root.console && root.console.debug) root.console.debug(entry);
      } catch (e) {
        /* reporting must never break the page */
      }
      try {
        if (typeof onReport === 'function') onReport(entry);
      } catch (e) {
        /* the page's handler is not our problem */
      }
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Requests

  // Resolves to { ok, status, bytes }; ok is false when no usable answer came back at all (a
  // network error, a timeout or a redirect). A redirect is never followed: it would carry the key
  // to another host.
  async function send(fetchFunction, url, headers) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    var init = { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', signal: controller.signal };
    if (headers) init.headers = headers;
    try {
      var response = await fetchFunction(url, init);
      if (response.type === 'opaqueredirect' || response.redirected) return { ok: false };
      var bytes = new Uint8Array(await response.arrayBuffer());
      return { ok: true, status: response.status, bytes: bytes };
    } catch (e) {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function sha256Hex(bytes) {
    var digest = new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes));
    var hex = '';
    for (var i = 0; i < digest.length; i++) hex += (digest[i] < 16 ? '0' : '') + digest[i].toString(16);
    return hex;
  }

  function parseJson(bytes) {
    try {
      return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch (e) {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Locales

  // Locale keys are compared after canonicalising, but a request always uses the manifest's own
  // spelling: the client never constructs a locale key.
  function canonicalLocale(value) {
    try {
      return new Intl.Locale(value).toString().toLowerCase();
    } catch (e) {
      return String(value).toLowerCase();
    }
  }

  function findLocale(wanted, available) {
    var target = canonicalLocale(wanted);
    for (var i = 0; i < available.length; i++) {
      if (canonicalLocale(available[i]) === target) return available[i];
    }
    return null;
  }

  // Only the JSON file is ever used, so a locale listed with no JSON file cannot be selected.
  function jsonFile(manifest, bundleId, locale) {
    var perLocale = manifest.slices[bundleId];
    var files = isObject(perLocale) ? perLocale[locale] : null;
    var file = isObject(files) ? files.json : null;
    return isObject(file) && typeof file.hash === 'string' ? file : null;
  }

  function manifestLocales(manifest) {
    var seen = [];
    Object.keys(manifest.slices).forEach(function (bundleId) {
      if (!isObject(manifest.slices[bundleId])) return;
      Object.keys(manifest.slices[bundleId]).forEach(function (locale) {
        if (seen.indexOf(locale) === -1 && jsonFile(manifest, bundleId, locale)) seen.push(locale);
      });
    });
    return seen;
  }

  // ---------------------------------------------------------------------------------------------
  // Slices

  // Values are untrusted: anything that is not the expected shape is treated as missing.
  function normaliseLeaf(raw) {
    if (!isObject(raw)) return null;
    return {
      id: typeof raw.id === 'string' || (typeof raw.id === 'number' && isFinite(raw.id)) ? String(raw.id) : null,
      value: typeof raw.value === 'string' ? raw.value : null,
      type: typeof raw.type === 'string' ? raw.type : null,
      className: typeof raw.class === 'string' && /^[A-Za-z0-9_ -]*$/.test(raw.class) ? raw.class : null,
      attributes: isObject(raw.attributes) ? raw.attributes : null,
      pluralIds: Array.isArray(raw.plural_child_keys) ? raw.plural_child_keys.map(String) : null,
      arrayIds: Array.isArray(raw.string_array_child_keys) ? raw.string_array_child_keys.map(String) : null,
    };
  }

  function isHttpsUrl(value) {
    try {
      return new URL(value).protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  // Maps without a prototype, so a key called "__proto__" or "constructor" is just a key.
  function normaliseKeys(rawKeys) {
    var container = { byName: Object.create(null), byId: Object.create(null) };
    if (!isObject(rawKeys)) return container;
    Object.keys(rawKeys).forEach(function (name) {
      var leaf = normaliseLeaf(rawKeys[name]);
      if (!leaf) return;
      leaf.name = name;
      container.byName[name] = leaf;
      if (leaf.id !== null && !(leaf.id in container.byId)) container.byId[leaf.id] = leaf;
    });
    return container;
  }

  // A flat slice has one container; a nested slice has one per namespace.
  function decodeSlice(slice) {
    var decoded = { flat: null, namespaces: null };
    if (isObject(slice.namespaces)) {
      decoded.namespaces = Object.create(null);
      Object.keys(slice.namespaces).forEach(function (namespace) {
        decoded.namespaces[namespace] = normaliseKeys(slice.namespaces[namespace]);
      });
    } else {
      decoded.flat = normaliseKeys(slice.keys);
    }
    return decoded;
  }

  // ---------------------------------------------------------------------------------------------
  // Formatting

  var NAMED_PLACEHOLDER = /\{([^{}]+)\}/y;
  var LEGACY_PLACEHOLDER = /%%([^%\s]+)%%/y;
  var PRINTF_PLACEHOLDER = /%(?:(\d+)\$)?([sd@])/y;

  // Sticky patterns match only at the given position, so no copy of the rest of the text is made.
  function matchAt(pattern, text, position) {
    pattern.lastIndex = position;
    return pattern.exec(text);
  }

  // One left-to-right scan; what is inserted is never scanned again.
  //   {name}            object arguments
  //   %s %d %@ %1$s     positional arguments (printf style); %% is a literal percent sign
  //   %%name%%          object arguments, only with legacyPercentPlaceholders
  function format(text, args, options) {
    var named = isObject(args) ? args : null;
    var positional = Array.isArray(args) ? args : null;
    // Inside a plural value the count stands in for every printf argument.
    var countOnly = !!named && options.plural;
    if (countOnly) positional = [named.count];
    if (!named && !positional) return text;

    var out = '';
    var next = 0;
    var i = 0;
    while (i < text.length) {
      var char = text.charAt(i);
      var match;
      if (char === '{' && named && (match = matchAt(NAMED_PLACEHOLDER, text, i)) && has(named, match[1])) {
        out += String(named[match[1]]);
        i += match[0].length;
      } else if (char === '%') {
        if (options.legacy && named && (match = matchAt(LEGACY_PLACEHOLDER, text, i)) && has(named, match[1])) {
          out += String(named[match[1]]);
          i += match[0].length;
        } else if (!positional) {
          // Object arguments leave percent signs alone outside the plural rule.
          out += '%';
          i += 1;
        } else if ((match = matchAt(PRINTF_PLACEHOLDER, text, i))) {
          var index = match[1] ? Number(match[1]) - 1 : countOnly ? 0 : next++;
          if (index >= 0 && index < positional.length) out += String(positional[index]);
          else out += match[0];
          i += match[0].length;
        } else if (text.charAt(i + 1) === '%') {
          out += '%';
          i += 2;
        } else {
          out += '%';
          i += 1;
        }
      } else {
        out += char;
        i += 1;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Bundles

  // Bundle ids compare by their number ("ns7" before "ns10"), then as text.
  function compareBundleIds(a, b) {
    var x = a.replace(/\D/g, '').replace(/^0+/, '');
    var y = b.replace(/\D/g, '').replace(/^0+/, '');
    if (x.length !== y.length) return x.length - y.length;
    if (x !== y) return x < y ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function bundleKey(type, name) {
    return type + '\n' + name;
  }

  // Of the manifest bundles sharing a type and name, the lowest id is the one that answers. That
  // holds even when it has nothing for the selected locale or its slice failed to load: a lookup
  // never moves on to another bundle with the same name.
  function chooseBundles(manifest) {
    var chosen = Object.create(null);
    Object.keys(manifest.bundles).forEach(function (id) {
      var bundle = manifest.bundles[id];
      if (!isObject(bundle) || typeof bundle.type !== 'string' || typeof bundle.name !== 'string') return;
      var key = bundleKey(bundle.type, bundle.name);
      if (!(key in chosen) || compareBundleIds(id, chosen[key]) < 0) chosen[key] = id;
    });
    return chosen;
  }

  // Namespaces are searched in the order the manifest lists them, then any others, sorted. The
  // order of the keys inside the slice itself plays no part.
  function namespaceOrder(slot) {
    var listed = isObject(slot.bundle) && Array.isArray(slot.bundle.namespaces) ? slot.bundle.namespaces.map(String) : [];
    var others = Object.keys(slot.decoded.namespaces)
      .filter(function (name) {
        return listed.indexOf(name) === -1;
      })
      .sort();
    return listed.concat(others);
  }

  function findLeaf(slot, key, namespace) {
    if (!slot || !slot.decoded) return null;
    var containers = [];
    if (slot.decoded.flat) {
      containers.push(slot.decoded.flat);
    } else {
      (typeof namespace === 'string' ? [namespace] : slot.order).forEach(function (name) {
        if (name in slot.decoded.namespaces) containers.push(slot.decoded.namespaces[name]);
      });
    }
    for (var i = 0; i < containers.length; i++) {
      if (key in containers[i].byName) return { leaf: containers[i].byName[key], container: containers[i] };
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // The client

  function createClient(state) {
    var slotsById = Object.create(null);
    state.slots.forEach(function (slot) {
      slotsById[slot.id] = slot;
      if (slot.decoded && slot.decoded.namespaces) slot.order = namespaceOrder(slot);
    });

    function slotFor(options) {
      var wanted = options && isObject(options.bundle) ? options.bundle : state.defaultBundle;
      if (!isObject(wanted) || typeof wanted.type !== 'string' || typeof wanted.name !== 'string') return null;
      var id = state.chosen[bundleKey(wanted.type, wanted.name)];
      return id === undefined ? null : slotsById[id] || null;
    }

    function lookup(key, options) {
      return findLeaf(slotFor(options), String(key), options ? options.namespace : undefined);
    }

    function formatOptions(plural) {
      return { plural: plural, legacy: state.legacyPercentPlaceholders };
    }

    // A listed child counts only when its id is listed AND its name is "<key>.<form>"; a key that
    // merely has such a name is not a plural form.
    function pluralChild(found, key, form) {
      var ids = found.leaf.pluralIds;
      for (var i = 0; i < ids.length; i++) {
        var child = found.container.byId[ids[i]];
        if (child && child.name === key + '.' + form) return child;
      }
      return null;
    }

    // A locale key that is not a valid language tag has no plural rules: every count is "other".
    var pluralRules = null;
    try {
      if (state.language !== null) pluralRules = new Intl.PluralRules(state.language);
    } catch (e) {
      pluralRules = null;
    }

    function pluralForm(found, key, count) {
      if (count === 0 && pluralChild(found, key, 'zero')) return 'zero';
      return pluralRules ? pluralRules.select(count) : 'other';
    }

    function translate(key, args, options) {
      key = String(key);
      var found = lookup(key, options);
      if (!found) return key;
      var leaf = found.leaf;
      var count = isObject(args) ? args.count : undefined;
      if (leaf.pluralIds && typeof count === 'number') {
        var child = pluralChild(found, key, pluralForm(found, key, count)) || pluralChild(found, key, 'other');
        if (child && child.value) return format(child.value, args, formatOptions(true));
        if (leaf.value) return format(leaf.value, args, formatOptions(true));
        return key;
      }
      if (!leaf.value) return key;
      if (args === undefined) return leaf.value;
      return format(leaf.value, args, formatOptions(false));
    }

    function translateArray(key, options) {
      var found = lookup(key, options);
      var result = [];
      if (!found || !found.leaf.arrayIds) return result;
      found.leaf.arrayIds.forEach(function (id) {
        var child = found.container.byId[id];
        if (child && child.value !== null) result.push(child.value);
      });
      return result;
    }

    function entry(key, options) {
      var found = lookup(key, options);
      if (!found || !found.leaf.value || found.leaf.id === null) return null;
      var leaf = found.leaf;
      var attributes = {};
      var dropped = [];
      if (leaf.attributes) {
        Object.keys(leaf.attributes).forEach(function (name) {
          var allowed = ALLOWED_ATTRIBUTES.indexOf(name) !== -1 && typeof leaf.attributes[name] === 'string';
          if (allowed) attributes[name] = leaf.attributes[name];
          else dropped.push(name);
        });
      }
      if (dropped.length) state.report('attribute-dropped', 'Attributes outside the allow-list were dropped', { names: dropped });
      var type = leaf.type === null ? 'text' : leaf.type;
      // The page puts a media value into src or href, where a script or data URL would run.
      if (type !== 'text' && !isHttpsUrl(leaf.value)) {
        state.report('media-url-rejected', 'A media value is not an https URL and was not returned');
        return null;
      }
      return {
        value: leaf.value,
        id: leaf.id,
        type: type,
        attributes: Object.keys(attributes).length ? attributes : null,
        className: leaf.className,
      };
    }

    // No lookup ever throws, whatever the slice contained.
    function safely(fallback, work) {
      return function () {
        try {
          return work.apply(null, arguments);
        } catch (e) {
          return fallback.apply(null, arguments);
        }
      };
    }

    return {
      t: safely(function (key) { return String(key); }, translate),
      tArray: safely(function () { return []; }, translateArray),
      entry: safely(function () { return null; }, entry),
      language: state.language,
      active: state.active,
    };
  }

  function inactiveClient(defaultBundle) {
    return createClient({ slots: [], chosen: Object.create(null), defaultBundle: defaultBundle, active: false, language: null, report: function () {} });
  }

  // ---------------------------------------------------------------------------------------------
  // The protocol

  async function run(config) {
    var fetchFunction = config.fetch || root.fetch;
    var problem = configProblem(config, fetchFunction);
    var report = createReporter(config.onReport);
    if (problem) {
      report('config', problem);
      return inactiveClient(config.defaultBundle);
    }
    if (!root.crypto || !root.crypto.subtle) {
      report('insecure-context', 'Hashing needs a secure context (https)');
      return inactiveClient(config.defaultBundle);
    }

    var appVersion = normaliseAppVersion(config.appVersion);
    if (appVersion !== config.appVersion) {
      report('app-version-normalised', 'appVersion was normalised', { from: String(config.appVersion), to: appVersion });
    }

    var session = {
      config: config,
      fetch: fetchFunction,
      report: report,
      keyHeaders: { 'X-Tarjim-Apikey': config.apiKey, 'X-Tarjim-Api-Version': API_VERSION },
      metaUrl:
        config.deliveryUrl + '?appVersion=' + appVersion + '&platform=web&sdkVersion=ref-' + VERSION +
        '&release=0&language=',
    };

    var meta = await readMeta(session, config.language || config.fallbackLanguage);
    if (!meta) return inactiveClient(config.defaultBundle);
    session.meta = meta;
    session.origin = meta.authenticated === true;

    var manifest = await readManifest(session);
    if (!manifest) return inactiveClient(config.defaultBundle);

    var language = selectLocale(manifest, config);
    if (language === null) {
      report('locale-unavailable', 'Neither the requested language nor the fallback language is in the release');
      return inactiveClient(config.defaultBundle);
    }

    var slots = await loadSlots(session, manifest, language);
    var chosen = chooseBundles(manifest);
    var defaultId = chosen[bundleKey(config.defaultBundle.type, config.defaultBundle.name)];
    var active = slots.filter(function (slot) {
      return slot.id === defaultId;
    })[0];
    return createClient({
      slots: slots,
      chosen: chosen,
      defaultBundle: config.defaultBundle,
      active: !!(active && active.decoded),
      language: language,
      legacyPercentPlaceholders: config.legacyPercentPlaceholders === true,
      report: report,
    });
  }

  // Reads and checks the meta document for a language; null when it is unusable. Everything but a
  // stage with no release yet is reported.
  async function readMeta(session, language) {
    var answer = await send(session.fetch, session.metaUrl + encodeURIComponent(language), session.keyHeaders);
    if (!answer.ok) {
      session.report('network', 'The meta request failed');
      return null;
    }
    var body = parseJson(answer.bytes);
    if (answer.status !== 200) {
      // A stage with no release yet is a normal state, not a fault.
      if (answer.status === 404 && isObject(body) && body.code === 'delivery.stage_unreleased') return null;
      var details = { status: answer.status };
      if (isObject(body) && typeof body.code === 'string') details.problemCode = body.code;
      session.report('meta-status', 'The meta request was refused', details);
      return null;
    }
    if (!isObject(body) || body.schemaVersion === undefined) {
      session.report('meta-invalid', 'The meta document is not readable');
      return null;
    }
    if (body.schemaVersion !== 1) {
      session.report('meta-schema', 'The meta document has an unsupported schema version');
      return null;
    }
    // A key that is bound to no track cannot receive a release, so nothing else is requested.
    // Anything but a string counts as unbound, a missing field included.
    if (typeof body.track !== 'string') {
      session.report('unbound-key', 'The API key is not bound to a track');
      return null;
    }
    if (!metaIsComplete(body)) {
      session.report('meta-invalid', 'The meta document is missing fields');
      return null;
    }
    return body;
  }

  function metaIsComplete(meta) {
    var strings = typeof meta.checksum === 'string' && typeof meta.manifestUrl === 'string' && typeof meta.slicesBaseUrl === 'string';
    if (!strings) return false;
    return meta.authenticated === true || typeof meta.signedQuery === 'string';
  }

  // Origin mode: URLs are relative to the delivery URL and need the key. CDN mode: URLs are
  // absolute and signed, and are fetched as plain GETs with no custom header. Returns null for an
  // address that cannot be used.
  function objectRequest(session, reference, signedQuery) {
    try {
      if (session.origin) {
        var url = new URL(reference, session.config.deliveryUrl);
        // The key must never be sent to a host other than the one that issued the meta document.
        if (url.origin !== new URL(session.config.deliveryUrl).origin) return null;
        return { url: url.href, headers: session.keyHeaders };
      }
      if (reference.indexOf('https://') !== 0) return null;
      new URL(reference);
      return { url: reference + '?' + signedQuery, headers: null };
    } catch (e) {
      return null;
    }
  }

  async function readManifest(session) {
    var request = objectRequest(session, session.meta.manifestUrl, session.meta.signedQuery);
    if (!request) {
      session.report('meta-invalid', 'The manifest address in the meta document is not usable');
      return null;
    }
    var answer = await send(session.fetch, request.url, request.headers);
    if (!answer.ok || answer.status !== 200) {
      session.report('network', 'The manifest request failed');
      return null;
    }
    if ((await sha256Hex(answer.bytes)) !== session.meta.checksum) {
      session.report('manifest-integrity', 'The manifest does not match the checksum in the meta document');
      return null;
    }
    var manifest = parseJson(answer.bytes);
    if (!isObject(manifest) || manifest.schemaVersion !== 1 || !isObject(manifest.slices) || !isObject(manifest.bundles)) {
      session.report('manifest-schema', 'The manifest is not a supported version');
      return null;
    }
    return manifest;
  }

  // Exactly one locale is used. If neither the requested language nor the fallback is listed,
  // nothing is active; a key missing from the chosen locale is never looked up in another.
  function selectLocale(manifest, config) {
    var available = manifestLocales(manifest);
    var chosen = findLocale(config.language || config.fallbackLanguage, available);
    return chosen !== null ? chosen : findLocale(config.fallbackLanguage, available);
  }

  // Only the JSON file of each slice is fetched; the other file types are ignored.
  async function loadSlots(session, manifest, language) {
    var slots = [];
    Object.keys(manifest.slices).forEach(function (bundleId) {
      var file = jsonFile(manifest, bundleId, language);
      if (!file) return;
      slots.push({ id: bundleId, bundle: manifest.bundles[bundleId], file: file, decoded: null });
    });

    var failed = await fetchSlots(session, slots, session.meta.signedQuery);
    if (failed.length && !session.origin) failed = await retryWithNewSignature(session, failed);
    if (failed.length) session.report('object-unavailable', 'Some slices could not be fetched');
    return slots;
  }

  // Fetches, verifies and decodes the given slots. Returns the ones that were refused or could not
  // be reached; only in CDN mode can a fresh signature fix those.
  async function fetchSlots(session, slots, signedQuery) {
    var results = await Promise.all(
      slots.map(function (slot) {
        return fetchSlot(session, slot, signedQuery);
      })
    );
    return slots.filter(function (slot, i) {
      return results[i] === 'retry';
    });
  }

  async function fetchSlot(session, slot, signedQuery) {
    var request = objectRequest(session, session.meta.slicesBaseUrl + slot.file.hash + '.json', signedQuery);
    if (!request) {
      session.report('meta-invalid', 'The slice address in the meta document is not usable');
      return 'failed';
    }
    var answer = await send(session.fetch, request.url, request.headers);
    if (!answer.ok || [403, 404, 503].indexOf(answer.status) !== -1) return 'retry';
    if (answer.status !== 200) {
      session.report('object-unavailable', 'A slice could not be fetched');
      return 'failed';
    }

    var intact = answer.bytes.length === slot.file.size && (await sha256Hex(answer.bytes)) === slot.file.hash;
    if (!intact) {
      session.report('slice-integrity', 'A slice does not match its hash or size');
      return 'failed';
    }
    var slice = parseJson(answer.bytes);
    if (!isObject(slice) || slice.schemaVersion !== 1) {
      session.report('slice-schema', 'A slice is not a supported version');
      return 'failed';
    }
    slot.decoded = decodeSlice(slice);
    return 'loaded';
  }

  // Signatures expire, so a refused object may only need a fresh one. The meta document is read
  // again once per start(); if the release has changed meanwhile, the failed slices are given up.
  async function retryWithNewSignature(session, failed) {
    var again = await readMeta(session, session.config.language || session.config.fallbackLanguage);
    if (!again || again.checksum !== session.meta.checksum || again.signedQuery === session.meta.signedQuery) return failed;
    return fetchSlots(session, failed, again.signedQuery);
  }

  // ---------------------------------------------------------------------------------------------
  // Public API

  // Never rejects and never throws: a client that is not active answers every lookup with the key.
  function start(config) {
    try {
      return run(isObject(config) ? config : {}).catch(function () {
        return inactiveClient(undefined);
      });
    } catch (e) {
      return Promise.resolve(inactiveClient(undefined));
    }
  }

  root.TarjimReference = { version: VERSION, start: start };
})(typeof globalThis !== 'undefined' ? globalThis : this);
