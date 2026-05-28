import { CSSProperties } from 'react';
import { FONT_MONO } from '../theme';

// Pseudo-random module grid that LOOKS like a real qrcode-terminal --small output:
// 21x21 modules rendered using half-block chars (▀ ▄ █ space) so two rows
// share one line. Includes faked finder patterns in three corners.
const SIZE = 21;

const seed = (i: number, j: number) => {
  const x = Math.sin(i * 92.83 + j * 17.71) * 43758.5453;
  return x - Math.floor(x) > 0.50;
};

const finder = (i: number, j: number): boolean | null => {
  const inCorner = (ci: number, cj: number) =>
    i >= ci && i < ci + 7 && j >= cj && j < cj + 7;
  let ci: number | null = null;
  let cj: number | null = null;
  if (inCorner(0, 0)) { ci = 0; cj = 0; }
  else if (inCorner(0, SIZE - 7)) { ci = 0; cj = SIZE - 7; }
  else if (inCorner(SIZE - 7, 0)) { ci = SIZE - 7; cj = 0; }
  if (ci === null || cj === null) return null;
  const ri = i - ci;
  const rj = j - cj;
  const onOuter = ri === 0 || ri === 6 || rj === 0 || rj === 6;
  const onInner = ri >= 2 && ri <= 4 && rj >= 2 && rj <= 4;
  return onOuter || onInner;
};

const moduleAt = (i: number, j: number) => {
  const f = finder(i, j);
  if (f !== null) return f;
  return seed(i, j);
};

export const QrAscii = ({
  fontSize = 22,
  color = '#e7e7e7',
  background = 'transparent',
  style,
}: {
  fontSize?: number;
  color?: string;
  background?: string;
  style?: CSSProperties;
}) => {
  const lines: string[] = [];
  // Quiet zone: 1 module padding around. Render in pairs of rows.
  const grid: boolean[][] = [];
  const padded = SIZE + 2; // 1-module quiet zone on each side
  for (let i = 0; i < padded; i++) {
    grid[i] = [];
    for (let j = 0; j < padded; j++) {
      if (i === 0 || i === padded - 1 || j === 0 || j === padded - 1) {
        grid[i][j] = false;
      } else {
        grid[i][j] = moduleAt(i - 1, j - 1);
      }
    }
  }

  for (let i = 0; i < padded; i += 2) {
    let line = '';
    for (let j = 0; j < padded; j++) {
      const top = grid[i][j];
      const bot = i + 1 < padded ? grid[i + 1][j] : false;
      if (top && bot) line += '█';
      else if (top && !bot) line += '▀';
      else if (!top && bot) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }

  return (
    <pre
      style={{
        margin: 0,
        fontFamily: FONT_MONO,
        fontSize,
        lineHeight: 1,
        color,
        background,
        letterSpacing: '0.02em',
        whiteSpace: 'pre',
        ...style,
      }}
    >
      {lines.join('\n')}
    </pre>
  );
};
