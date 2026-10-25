import { HttpError } from './database.mjs';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const methods = new Set(['GET', 'HEAD', 'POST']);
const headers = [
  'content-type',
  'x-hik-local',
  'x-saas-user',
  'x-recording-id',
  'x-recording-meta',
  'range',
];

export function checkedOrigin(value) {
  if (typeof value !== 'string' || value === 'null' || value.includes('*'))
    throw new Error('Use an exact frontend origin.');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Use a valid frontend origin.');
  }
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    !(
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && localHosts.has(parsed.hostname))
    )
  ) {
    throw new Error('Frontend origins require HTTPS except on loopback.');
  }
  return value;
}

export function frontendOriginsFromEnv(value = '') {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(checkedOrigin);
}

export function httpPolicy({
  publicOrigin = null,
  frontendOrigins = [],
  cookieSameSite = 'Strict',
} = {}) {
  const allowed = new Set(frontendOrigins.map(checkedOrigin));
  if (!['Strict', 'Lax', 'None'].includes(cookieSameSite))
    throw new Error('Choose Strict, Lax or None for COOKIE_SAME_SITE.');
  if (cookieSameSite === 'None' && !publicOrigin)
    throw new Error('Cross-site cookies require an HTTPS PUBLIC_ORIGIN.');
  if (publicOrigin && new URL(publicOrigin).protocol !== 'https:')
    throw new Error('Public API hosting requires HTTPS.');
  return {
    apply(req, res, requestOrigin) {
      res.setHeader('Vary', 'Origin');
      const origin = req.headers.origin;
      if (
        (origin && ![publicOrigin || requestOrigin, ...allowed].includes(origin)) ||
        (!origin && req.headers['sec-fetch-site'] === 'cross-site')
      )
        throw new HttpError('Origin is not allowed.', 403);
      if (origin && allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader(
          'Access-Control-Expose-Headers',
          'Content-Range, Accept-Ranges, Content-Length, Content-Disposition',
        );
      }
    },
    preflight(req, res) {
      if (!req.headers.origin || !allowed.has(req.headers.origin))
        throw new HttpError('Origin is not allowed.', 403);
      if (!methods.has(req.headers['access-control-request-method']))
        throw new HttpError('Method is not allowed.', 405);
      const requested = String(req.headers['access-control-request-headers'] || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (requested.some((header) => !headers.includes(header)))
        throw new HttpError('Request headers are not allowed.', 403);
      res.writeHead(204, {
        'Access-Control-Allow-Methods': [...methods].join(', '),
        'Access-Control-Allow-Headers': headers.join(', '),
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      });
      res.end();
    },
    cookie(token) {
      return `hik_saas=${token}; HttpOnly; SameSite=${cookieSameSite}; Path=/; Max-Age=${token ? 604800 : 0}${publicOrigin ? '; Secure' : ''}`;
    },
  };
}
