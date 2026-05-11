// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

const MAX_LINE_BYTES = 2048;

export type ConventionTag = 'ASK' | 'PICK' | 'STATUS' | 'DONE' | 'BLOCKED' | 'CHAT';

export type ParsedLine = {
  tag: ConventionTag;
  text: string;
  options?: string[];
  isStderr?: boolean;
};

const TAG_PATTERNS: Array<{ tag: ConventionTag; regex: RegExp }> = [
  { tag: 'ASK', regex: /^\[ASK\]\s+(.+)/ },
  { tag: 'PICK', regex: /^\[PICK\]\s+(.+)/ },
  { tag: 'STATUS', regex: /^\[STATUS\]\s+(.+)/ },
  { tag: 'DONE', regex: /^\[DONE\]\s+(.+)/ },
  { tag: 'BLOCKED', regex: /^\[BLOCKED\]\s+(.+)/ },
];

export const stripAnsi = (text: string): string => text.replace(ANSI_REGEX, '');

export const truncateLine = (line: string): string => {
  const bytes = Buffer.byteLength(line, 'utf-8');
  if (bytes <= MAX_LINE_BYTES) return line;
  const buf = Buffer.from(line, 'utf-8');
  const truncated = buf.subarray(0, MAX_LINE_BYTES).toString('utf-8');
  return `${truncated} (truncated; ${bytes} bytes)`;
};

export const parseLine = (raw: string, isStderr = false): ParsedLine => {
  const stripped = stripAnsi(raw);
  const line = truncateLine(stripped);

  for (const { tag, regex } of TAG_PATTERNS) {
    const match = line.match(regex);
    if (match) {
      const text = match[1]!.trim();
      if (tag === 'PICK') {
        const parts = text.split('|').map((s) => s.trim());
        const question = parts[0]!;
        const options = parts.slice(1);
        return { tag, text: question, options, isStderr };
      }
      return { tag, text, isStderr };
    }
  }

  return { tag: 'CHAT', text: line, isStderr };
};

export type InboundMessage = {
  type: 'yes_no';
  value: 'yes' | 'no';
} | {
  type: 'pick';
  value: string;
} | {
  type: 'free_text';
  value: string;
};

export const formatInboundForStdin = (msg: InboundMessage): string => {
  switch (msg.type) {
    case 'yes_no':
      return `${msg.value}\n`;
    case 'pick':
      return `${msg.value}\n`;
    case 'free_text':
      return `[FROM USER] ${msg.value}\n`;
  }
};
