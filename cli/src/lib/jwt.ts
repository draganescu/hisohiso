// Local, verification-free reads of a JWT's exp claim. The daemon doesn't
// validate tokens (Mercure does) — it only needs to predict whether the server
// will still accept one, so it can refresh via POST /api/rooms/:hash/sub-token
// before subscribing with a dead JWT.

// Epoch milliseconds of the token's exp claim, or null when the token is
// malformed or carries no exp. Null means "nothing to predict" — callers
// treat it as not-expiring and let the server be the judge.
export const jwtExpMs = (jwt: string): number | null => {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
};

// How close to a subscriber JWT's exp a restoring daemon refreshes it rather
// than reusing it. 24h against the server's 7-day PARTICIPANT_JWT_TTL: wide
// enough that clock skew or a long uptime between restarts can't slip a
// nearly-dead JWT through, narrow enough that a freshly-minted one is reused.
// Mid-run expiry is handled separately by the SSE 401 refresh path.
export const SUBSCRIBER_JWT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

export const jwtExpiresWithin = (jwt: string, marginMs: number): boolean => {
  const exp = jwtExpMs(jwt);
  if (exp === null) return false;
  return exp - Date.now() <= marginMs;
};
