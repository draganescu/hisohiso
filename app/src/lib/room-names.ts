// Deterministic two-word fallback name for chat rooms whose user-set nickname
// is empty. The name is derived from the room hash so the same room renders
// the same name on every reload, on every device that joins it — but it's
// NEVER written to storage. That keeps three things clean:
//
//   1. The user's kebab → Rename always beats the fallback (no storage to
//      compare against), and renaming to empty restores the fallback.
//   2. Control rooms don't get stuck on a punk default before the daemon's
//      hostname stamp arrives — control rooms simply opt out (caller passes
//      kind !== 'chat' and falls back to "Unnamed channel" instead).
//   3. Two clients joining the same room see the same name without any
//      coordination — the hash is the only shared input.
//
// Both lists kept short and curated so collisions feel like a feature
// (you'd remember "Velvet Cobra"), not a bug.

const ADJECTIVES = [
  'velvet', 'neon', 'chrome', 'electric', 'midnight', 'ghost', 'riot', 'disco',
  'sunset', 'ember', 'frost', 'glitter', 'static', 'hollow', 'lunar', 'viper',
  'mango', 'plasma', 'scarlet', 'savage', 'glitch', 'paper', 'cosmic', 'atomic',
  'phantom', 'rebel', 'vintage', 'sapphire', 'bionic', 'quartz',
];

const NOUNS = [
  'cobra', 'mosh', 'sloth', 'honey', 'skater', 'phoenix', 'wolf', 'howl',
  'tide', 'comet', 'heron', 'hawk', 'lotus', 'echo', 'drift', 'spark',
  'quake', 'glide', 'coil', 'crash', 'bloom', 'storm', 'vortex', 'anchor',
  'tempest', 'tiger', 'beat', 'kismet', 'panther', 'thorn',
];

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Pull two 32-bit slices from the hash so the adjective and noun aren't
// locked to the same byte window — two rooms that share a hash prefix
// (mathematically rare, but) wouldn't collide on both halves.
export const generateRoomName = (roomHash: string): string => {
  const adjSeed = parseInt(roomHash.slice(0, 8) || '0', 16) || 0;
  const nounSeed = parseInt(roomHash.slice(8, 16) || '0', 16) || 0;
  const adj = ADJECTIVES[adjSeed % ADJECTIVES.length];
  const noun = NOUNS[nounSeed % NOUNS.length];
  return `${titleCase(adj)} ${titleCase(noun)}`;
};
