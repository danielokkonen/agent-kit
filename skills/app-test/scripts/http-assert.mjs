// Generic HTTP assertion hook for app-test targets whose backend is an HTTP API rather than a
// local SQLite/DB file. Register it in your profile's target config, e.g.:
//   assertions: [{ file: '<abs path to this file>' }]
// and rely on the runner passing `baseUrl` from the url target (or pass absolute paths).
//
// Check shapes — each entry in a step's `assertions` array is one of:
//   { method?, path, status?, expect?, body? }
//     - method:  'GET' | 'POST' | ...            (default 'GET')
//     - path:    request route or absolute URL
//     - status:  expected HTTP status code       (default 200)
//     - expect:  object that must be a subset of the parsed JSON response body
//     - body:    request body for POST/PUT, sent as JSON

export default async function httpAssert({ baseUrl, phase, checks = [] }) {
  if (phase === 'launch') return; // readiness is handled by the runner's health check
  for (const check of checks) await runCheck(baseUrl, check);
}

async function runCheck(base, check) {
  const method = (check.method ?? 'GET').toUpperCase();
  const url = isAbsoluteUrl(check.path) ? check.path : joinUrl(base, check.path);
  if (!url) throw new Error(`http-assert: no baseUrl available for path "${check.path}"`);

  const init = { method };
  if (check.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(check.body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`http-assert: ${method} ${url} failed to connect: ${err.message}`);
  }

  const expectedStatus = check.status ?? 200;
  if (res.status !== expectedStatus) {
    throw new Error(`http-assert: ${method} ${url} status is ${res.status}, expected ${expectedStatus}`);
  }

  if (check.expect !== undefined) {
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`http-assert: response from ${url} was not valid JSON`);
    }
    assertSubset(data, check.expect, url);
  }
}

function isAbsoluteUrl(p) {
  return /^https?:\/\//i.test(p ?? '');
}

function joinUrl(base, p) {
  if (!base) return null;
  const b = base.replace(/\/+$/, '');
  return b + (p.startsWith('/') ? p : `/${p}`);
}

function assertSubset(actual, expected, url) {
  for (const [key, want] of Object.entries(expected)) {
    const has = actual !== null && typeof actual === 'object' && key in actual;
    if (!has || !deepEqual(actual[key], want)) {
      throw new Error(
        `http-assert: ${url} body.${key} is ${JSON.stringify(has ? actual[key] : undefined)}, expected ${JSON.stringify(want)}`,
      );
    }
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false; // primitives were already compared above
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && deepEqual(a[k], b[k]));
}
