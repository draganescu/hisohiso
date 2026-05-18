// Scheme denylist for agent-supplied URLs. Anything that can execute script
// in the PWA origin is rejected; everything else (http, https, mailto, tel,
// relative paths) passes through unchanged. We deliberately denylist schemes
// rather than allowlist domains — peer-authored URLs are untrusted but their
// destinations are not our business; the browser sandboxes them by origin
// once they open in a new tab.
const EXECUTABLE_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'blob:',
  'file:',
  'filesystem:',
]);

export const safeHref = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://invalid.local/');
  } catch {
    return null;
  }

  if (EXECUTABLE_SCHEMES.has(parsed.protocol.toLowerCase())) return null;
  return trimmed;
};
