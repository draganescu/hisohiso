import { CSSProperties, ReactNode } from 'react';
import { FONT_MONO } from '../theme';

type Props = {
  children?: ReactNode;
  title?: string;
  width?: number;
  height?: number;
  style?: CSSProperties;
};

export const TerminalFrame = ({
  children,
  title = 'andrei@air — hisohiso',
  width = 980,
  height = 1240,
  style,
}: Props) => {
  return (
    <div
      style={{
        width,
        height,
        backgroundColor: '#1c1c1c',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow:
          '0 60px 120px rgba(10,10,10,0.30), 0 24px 48px rgba(10,10,10,0.20), inset 0 0 0 1px rgba(255,255,255,0.05)',
        display: 'flex',
        flexDirection: 'column',
        ...style,
      }}
    >
      {/* Title bar */}
      <div
        style={{
          height: 40,
          backgroundColor: '#2a2a2a',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          position: 'relative',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <Dot color="#ff5f57" />
          <Dot color="#ffbd2e" />
          <Dot color="#28c940" />
        </div>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            textAlign: 'center',
            color: 'rgba(255,255,255,0.55)',
            fontSize: 16,
            fontFamily: FONT_MONO,
            letterSpacing: '-0.005em',
            pointerEvents: 'none',
          }}
        >
          {title}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          backgroundColor: '#0d0d0d',
          padding: '24px 28px',
          fontFamily: FONT_MONO,
          fontSize: 22,
          lineHeight: 1.45,
          color: '#e7e7e7',
          overflow: 'hidden',
          whiteSpace: 'pre',
        }}
      >
        {children}
      </div>
    </div>
  );
};

const Dot = ({ color }: { color: string }) => (
  <div style={{ width: 14, height: 14, borderRadius: '50%', backgroundColor: color }} />
);

type LineProps = {
  prompt?: string;
  text?: string;
  className?: string;
  color?: string;
  caret?: boolean;
  dim?: boolean;
};

export const TermLine = ({ prompt, text = '', color = '#e7e7e7', caret = false, dim = false }: LineProps) => (
  <div style={{ color: dim ? 'rgba(231,231,231,0.55)' : color, display: 'flex' }}>
    {prompt && <span style={{ color: '#7dd3fc', marginRight: 6 }}>{prompt}</span>}
    <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
    {caret && <Caret />}
  </div>
);

export const Caret = () => (
  <span
    style={{
      display: 'inline-block',
      width: '0.55em',
      height: '1.05em',
      marginLeft: 2,
      backgroundColor: '#e7e7e7',
      verticalAlign: 'text-bottom',
    }}
  />
);

// Typewriter helpers
export const sliceText = (text: string, charsRevealed: number) =>
  text.slice(0, Math.max(0, Math.min(text.length, charsRevealed)));
