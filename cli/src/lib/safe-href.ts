// Scheme denylist mirror of app/src/lib/safeHref.ts. Defense in depth: even
// if the PWA render gate regresses, peer-bound encrypted payloads never carry
// an executable-scheme URL because we strip it here before re-broadcasting
// the agent's blocks.
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

// Walks an array of agent-emitted blocks and neutralizes URL fields that
// would execute script in the PWA origin. Currently only link-preview has a
// URL field; this is the choke point to extend if new block types add one.
export const sanitizeBlocks = (blocks: unknown[] | null): unknown[] | null => {
  if (!blocks) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const b = block as Record<string, unknown>;
    if (b.type === 'link-preview' && typeof b.url === 'string' && safeHref(b.url) === null) {
      return { ...b, url: '' };
    }
    return block;
  });
};
