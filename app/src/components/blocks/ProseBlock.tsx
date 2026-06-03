import { useMemo } from 'react';
import type { ProseBlock as ProseBlockType } from '../../lib/blocks';

interface Props {
  block: ProseBlockType;
}

type Token =
  | { kind: 'h1' | 'h2' | 'h3' | 'p'; text: string }
  | { kind: 'ul'; items: string[] };

const tokenize = (input: string): Token[] => {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const tokens: Token[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    tokens.push({ kind: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    tokens.push({ kind: 'ul', items: list });
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = /^[-*]\s+(.*)/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }
    flushList();
    const h3 = /^###\s+(.*)/.exec(line);
    const h2 = /^##\s+(.*)/.exec(line);
    const h1 = /^#\s+(.*)/.exec(line);
    if (h3) { flushParagraph(); tokens.push({ kind: 'h3', text: h3[1] }); continue; }
    if (h2) { flushParagraph(); tokens.push({ kind: 'h2', text: h2[1] }); continue; }
    if (h1) { flushParagraph(); tokens.push({ kind: 'h1', text: h1[1] }); continue; }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return tokens;
};

const renderInline = (text: string): React.ReactNode[] => {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={key++} className="font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      out.push(<code key={key++} className="rounded bg-rule-soft px-1 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">{tok.slice(1, -1)}</code>);
    } else {
      out.push(<em key={key++} className="italic">{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

export const ProseBlockView = ({ block }: Props) => {
  const tokens = useMemo(() => tokenize(block.content), [block.content]);
  return (
    <div className="mt-3 space-y-3 text-[0.9375rem] leading-7 text-ink-soft">
      {tokens.map((tok, i) => {
        if (tok.kind === 'h1') return <h2 key={i} className="text-xl font-semibold text-ink">{renderInline(tok.text)}</h2>;
        if (tok.kind === 'h2') return <h3 key={i} className="text-lg font-semibold text-ink">{renderInline(tok.text)}</h3>;
        if (tok.kind === 'h3') return <h4 key={i} className="text-base font-semibold text-ink">{renderInline(tok.text)}</h4>;
        if (tok.kind === 'ul') return (
          <ul key={i} className="space-y-1.5 pl-1">
            {tok.items.map((item, j) => (
              <li key={j} className="flex gap-2">
                <span className="shrink-0 select-none text-ink-dim">{'•'}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{renderInline(item)}</span>
              </li>
            ))}
          </ul>
        );
        return <p key={i} className="whitespace-pre-wrap break-words">{renderInline(tok.text)}</p>;
      })}
    </div>
  );
};
