// Small interactive helpers used by `hisohiso daemon start` and `hisohiso wrap`
// to ask the operator for a session knock message and to mint per-room pairing
// codes. Kept dependency-free — uses Node's built-in readline + crypto.

import { createInterface } from 'node:readline/promises';
import { randomInt } from 'node:crypto';

// Lowercase Crockford-style base32 (no i/l/o/u — unambiguous when read off a
// terminal and typed on a phone). 32 symbols => 5 bits each.
const CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CODE_LENGTH = 12; // 12 * 5 = ~60 bits

// Returns a high-entropy (~60-bit) pairing code. It is the per-room password
// fed into the PBKDF2 k_msg/k_knock derivation (crypto.ts) and is the factor an
// attacker who has ONLY the room URL does not possess. The old 4-digit code
// (~13 bits) was offline-brute-forceable in seconds (finding #93); ~60 bits
// over 600k PBKDF2 iterations puts an offline search out of reach. The operator
// transfers it to the phone once at control-room pairing; spawned agent rooms
// carry their own code automatically over the encrypted control channel, so the
// extra length costs nothing there. randomInt(0, 32) per char is unbiased.
export const generatePairingCode = (): string => {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
};

// Prompt the operator for a free-form line. Returns the trimmed line or
// throws if stdin is not a TTY (which would be the case for a backgrounded
// daemon — callers should handle that by reading from persisted state or
// failing loudly). `hidden` swaps stdout echo for asterisks so passphrases
// aren't visible over the operator's shoulder.
export const promptLine = async (question: string, opts?: { hidden?: boolean }): Promise<string> => {
  if (!process.stdin.isTTY) {
    throw new Error('promptLine: stdin is not a TTY (cannot prompt — re-run from a foreground terminal)');
  }

  if (opts?.hidden) {
    return promptHidden(question);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const line = await rl.question(question);
    return line.trim();
  } finally {
    rl.close();
  }
};

// Hidden-input prompt — masks each typed character with '*' rather than
// echoing the literal letter. Important for the session knock message,
// since the whole point is that it never appears anywhere observable
// (in scrollback, in screenshots, in a co-worker's peripheral vision).
const promptHidden = (question: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    let buf = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 0x03) { // Ctrl-C
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (code === 0x0d || code === 0x0a) { // CR or LF
          process.stdout.write('\n');
          cleanup();
          resolve(buf.trim());
          return;
        }
        if (code === 0x7f || code === 0x08) { // backspace
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (code < 0x20) continue; // ignore other control chars
        buf += ch;
        process.stdout.write('*');
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    };

    stdin.on('data', onData);
  });
};
