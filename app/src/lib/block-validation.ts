import type { Block, Confidence } from './blocks';

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

const hexColorRe = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const isHexColor = (value: unknown): value is string => isString(value) && hexColorRe.test(value.trim());

const confidenceLevels = new Set(['high', 'medium', 'low']);
const stepStatuses = new Set(['done', 'active', 'pending', 'failed']);
const fileStatuses = new Set(['added', 'modified', 'deleted', 'renamed']);
const riskLevels = new Set(['safe', 'moderate', 'dangerous']);

const baseBlock = (block: AnyRecord): AnyRecord => {
  const base: AnyRecord = { type: block.type };
  if (isString(block.id)) base.id = block.id;
  if (isString(block.summary)) base.summary = block.summary;
  if (typeof block.collapsed === 'boolean') base.collapsed = block.collapsed;
  if (isString(block.confidence) && confidenceLevels.has(block.confidence)) {
    base.confidence = block.confidence as Confidence;
  }
  return base;
};

const toBlock = (value: AnyRecord): Block => value as unknown as Block;

const invalidBlock = (type: string, reason: string, block: AnyRecord): Block => ({
  type: 'error',
  title: `Invalid ${type} block`,
  suggestion: `${reason}. The message was still opened safely instead of crashing the page.`,
  summary: isString(block.summary) ? block.summary : undefined,
});

const validateFileTreeNode = (node: unknown): AnyRecord | null => {
  if (!isRecord(node) || !isString(node.path)) return null;
  const out: AnyRecord = { path: node.path };
  if (isString(node.status) && fileStatuses.has(node.status)) out.status = node.status;
  if (Array.isArray(node.children)) {
    const children = node.children.map(validateFileTreeNode).filter((child): child is AnyRecord => child !== null);
    if (children.length > 0) out.children = children;
  }
  return out;
};

const validateBlock = (raw: unknown): Block | null => {
  if (!isRecord(raw) || !isString(raw.type)) return null;

  switch (raw.type) {
    case 'buttons': {
      if (!isString(raw.id) || !isString(raw.prompt) || !Array.isArray(raw.options)) {
        return invalidBlock(raw.type, 'Expected id, prompt, and options[]', raw);
      }
      const options = raw.options.filter((option): option is { label: string; value: string } => (
        isRecord(option) && isString(option.label) && isString(option.value)
      ));
      if (options.length === 0) return invalidBlock(raw.type, 'Expected at least one option with label and value', raw);
      return toBlock({ ...baseBlock(raw), id: raw.id, prompt: raw.prompt, options, multi: typeof raw.multi === 'boolean' ? raw.multi : undefined });
    }
    case 'swipe': {
      if (!isString(raw.id) || !isString(raw.prompt) || !Array.isArray(raw.cards)) {
        return invalidBlock(raw.type, 'Expected id, prompt, and cards[]', raw);
      }
      const cards = raw.cards.filter((card): card is { value: string; title: string; body: string; pros?: string[]; cons?: string[] } => (
        isRecord(card) && isString(card.value) && isString(card.title) && isString(card.body)
      ));
      if (cards.length === 0) return invalidBlock(raw.type, 'Expected at least one card with value, title, and body', raw);
      return toBlock({ ...baseBlock(raw), id: raw.id, prompt: raw.prompt, cards });
    }
    case 'slider':
      if (!isString(raw.id) || !isString(raw.prompt) || !isRecord(raw.min) || !isRecord(raw.max) || !isNumber(raw.min.value) || !isString(raw.min.label) || !isNumber(raw.max.value) || !isString(raw.max.label)) {
        return invalidBlock(raw.type, 'Expected id, prompt, min{value,label}, and max{value,label}', raw);
      }
      return toBlock({ ...baseBlock(raw), id: raw.id, prompt: raw.prompt, min: raw.min, max: raw.max, default: isNumber(raw.default) ? raw.default : undefined, steps: isNumber(raw.steps) ? raw.steps : undefined });
    case 'checklist':
      if (!isString(raw.id) || !isString(raw.prompt) || !Array.isArray(raw.items)) return invalidBlock(raw.type, 'Expected id, prompt, and items[]', raw);
      return toBlock({ ...baseBlock(raw), id: raw.id, prompt: raw.prompt, items: raw.items.filter((item): item is { value: string; label: string; checked?: boolean } => isRecord(item) && isString(item.value) && isString(item.label)) });
    case 'sortable':
      if (!isString(raw.id) || !isString(raw.prompt) || !Array.isArray(raw.items)) return invalidBlock(raw.type, 'Expected id, prompt, and items[]', raw);
      return toBlock({ ...baseBlock(raw), id: raw.id, prompt: raw.prompt, items: raw.items.filter((item): item is { value: string; label: string } => isRecord(item) && isString(item.value) && isString(item.label)) });
    case 'diff':
      if (!isString(raw.file) || !Array.isArray(raw.hunks)) return invalidBlock(raw.type, 'Expected file and hunks[]', raw);
      return toBlock({
        ...raw,
        sha: isString(raw.sha) ? raw.sha : undefined,
        committed_sha: isString(raw.committed_sha) ? raw.committed_sha : undefined,
      });
    case 'file-tree': {
      if (!Array.isArray(raw.nodes)) return invalidBlock(raw.type, 'Expected nodes[]; flat files[] is not renderable', raw);
      const nodes = raw.nodes.map(validateFileTreeNode).filter((node): node is AnyRecord => node !== null);
      if (nodes.length === 0) return invalidBlock(raw.type, 'Expected at least one node with a path', raw);
      return toBlock({ ...baseBlock(raw), nodes });
    }
    case 'terminal':
      if (!isString(raw.command) || !isString(raw.output)) return invalidBlock(raw.type, 'Expected command and output strings; title/content is not renderable', raw);
      return toBlock({ ...baseBlock(raw), command: raw.command, output: raw.output, exit_code: isNumber(raw.exit_code) ? raw.exit_code : undefined });
    case 'progress':
      if (!Array.isArray(raw.steps)) return invalidBlock(raw.type, 'Expected steps[]', raw);
      return toBlock({ ...baseBlock(raw), id: isString(raw.id) ? raw.id : undefined, title: isString(raw.title) ? raw.title : undefined, steps: raw.steps.filter((step): step is { label: string; status: 'done' | 'active' | 'pending' | 'failed' } => isRecord(step) && isString(step.label) && isString(step.status) && stepStatuses.has(step.status)) });
    case 'code':
      if (!isString(raw.content)) return invalidBlock(raw.type, 'Expected content string', raw);
      return toBlock({ ...baseBlock(raw), file: isString(raw.file) ? raw.file : undefined, language: isString(raw.language) ? raw.language : undefined, start_line: isNumber(raw.start_line) ? raw.start_line : undefined, content: raw.content, highlight_lines: Array.isArray(raw.highlight_lines) ? raw.highlight_lines.filter(isNumber) : undefined });
    case 'before-after':
      if (!isRecord(raw.before) || !isRecord(raw.after) || !isString(raw.before.content) || !isString(raw.after.content)) return invalidBlock(raw.type, 'Expected before and after objects with content', raw);
      return toBlock(raw);
    case 'error':
      if (!isString(raw.title)) return invalidBlock(raw.type, 'Expected title string', raw);
      return toBlock(raw);
    case 'confirm-danger':
      if (!isString(raw.id) || !isString(raw.title) || !isString(raw.description)) return invalidBlock(raw.type, 'Expected id, title, and description', raw);
      return toBlock(raw);
    case 'commit':
      if (!isString(raw.id) || !isString(raw.message)) return invalidBlock(raw.type, 'Expected id and message', raw);
      return toBlock({ ...baseBlock(raw), id: raw.id, message: raw.message, files: isStringArray(raw.files) ? raw.files : undefined });
    case 'run-command':
      if (!isString(raw.id) || !isString(raw.command)) return invalidBlock(raw.type, 'Expected id and command', raw);
      return toBlock({ ...baseBlock(raw), id: raw.id, command: raw.command, description: isString(raw.description) ? raw.description : undefined, risk: isString(raw.risk) && riskLevels.has(raw.risk) ? raw.risk : undefined });
    case 'thinking':
      if (!isString(raw.content)) return invalidBlock(raw.type, 'Expected content string', raw);
      return toBlock(raw);
    case 'cost':
      return toBlock(raw);
    case 'file-peek':
      if (!isString(raw.file) || !isString(raw.content)) return invalidBlock(raw.type, 'Expected file and content strings', raw);
      return toBlock(raw);
    case 'carousel':
      if (!Array.isArray(raw.cards)) return invalidBlock(raw.type, 'Expected cards[]', raw);
      return toBlock(raw);
    case 'link-preview':
      if (!isString(raw.url)) return invalidBlock(raw.type, 'Expected url string', raw);
      return toBlock(raw);
    case 'list': {
      if (!Array.isArray(raw.items)) return invalidBlock(raw.type, 'Expected items[]', raw);
      const items = raw.items.filter(isString);
      if (items.length === 0) return invalidBlock(raw.type, 'Expected at least one string item', raw);
      const style = isString(raw.style) && ['bullet', 'numbered', 'check'].includes(raw.style) ? raw.style : undefined;
      return toBlock({ ...baseBlock(raw), title: isString(raw.title) ? raw.title : undefined, style, items });
    }
    case 'prose':
      if (!isString(raw.content)) return invalidBlock(raw.type, 'Expected content string', raw);
      return toBlock({ ...baseBlock(raw), content: raw.content });
    case 'label':
      if (!isString(raw.text)) return invalidBlock(raw.type, 'Expected text string', raw);
      return toBlock({ ...baseBlock(raw), text: raw.text });
    case 'swatches': {
      if (!Array.isArray(raw.schemes)) return invalidBlock(raw.type, 'Expected schemes[]', raw);
      const schemes = raw.schemes
        .map((scheme) => {
          if (!isRecord(scheme) || !Array.isArray(scheme.colors)) return null;
          // Only accept literal hex colors. A value goes straight into an inline
          // style background, so anything that isn't #rgb / #rgba / #rrggbb /
          // #rrggbbaa is dropped — no CSS injection surface.
          const colors = scheme.colors
            .filter((color): color is AnyRecord => isRecord(color) && isHexColor(color.hex))
            .map((color) => ({ hex: (color.hex as string).trim().toLowerCase(), name: isString(color.name) ? color.name : undefined }));
          if (colors.length === 0) return null;
          return { name: isString(scheme.name) ? scheme.name : undefined, note: isString(scheme.note) ? scheme.note : undefined, colors };
        })
        .filter((scheme): scheme is NonNullable<typeof scheme> => scheme !== null);
      if (schemes.length === 0) return invalidBlock(raw.type, 'Expected at least one scheme with valid #hex colors', raw);
      return toBlock({ ...baseBlock(raw), title: isString(raw.title) ? raw.title : undefined, schemes });
    }
    default:
      return null;
  }
};

export const sanitizeBlocksForRender = (blocks: unknown[] | null | undefined): Block[] => {
  if (!Array.isArray(blocks)) return [];
  return blocks.map(validateBlock).filter((block): block is Block => block !== null);
};
