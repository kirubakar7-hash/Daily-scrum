/** Resolves the `cors` middleware's `origin` option from environment configuration. A pure function
 *  (rather than inline top-level code in index.js, where the result is baked in once at import time from
 *  process.env) so it's independently testable with different env combinations in one process.
 *
 *  - CORS_ORIGIN set → locked to exactly those origin(s) (comma-separated for more than one).
 *  - CORS_ORIGIN unset, production → false (refuse ALL cross-origin). This app's supported production
 *    deployment (Vercel) serves frontend and API from the same origin, so same-origin requests never go
 *    through CORS at all — CORS_ORIGIN being unset is a valid, safe configuration there, not a
 *    misconfiguration, and must never crash startup or fall back to a wide-open policy.
 *  - CORS_ORIGIN unset, not production → true (wide open — local dev convenience only, since Vite's dev
 *    server runs on a different port than the API). */
export function resolveCorsOrigin(corsOriginEnv, nodeEnv) {
  if (corsOriginEnv) return corsOriginEnv.split(',').map((o) => o.trim());
  return nodeEnv === 'production' ? false : true;
}
