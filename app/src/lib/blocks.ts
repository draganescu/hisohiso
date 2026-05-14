// ─── Universal block properties ───────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

interface BlockBase {
  type: string;
  id?: string;
  confidence?: Confidence;
  collapsed?: boolean;
  summary?: string;
}

// ─── 1. Buttons ───────────────────────────────────────────────────────────

export interface ButtonOption {
  label: string;
  value: string;
}

export interface ButtonsBlock extends BlockBase {
  type: 'buttons';
  id: string;
  prompt: string;
  style?: 'inline' | 'stacked';
  options: ButtonOption[];
  multi?: boolean;
}

// ─── 2. Swipe ─────────────────────────────────────────────────────────────

export interface SwipeCard {
  value: string;
  title: string;
  body: string;
  pros?: string[];
  cons?: string[];
}

export interface SwipeBlock extends BlockBase {
  type: 'swipe';
  id: string;
  prompt: string;
  cards: SwipeCard[];
}

// ─── 3. Slider ────────────────────────────────────────────────────────────

export interface SliderEndpoint {
  value: number;
  label: string;
}

export interface SliderBlock extends BlockBase {
  type: 'slider';
  id: string;
  prompt: string;
  min: SliderEndpoint;
  max: SliderEndpoint;
  default?: number;
  steps?: number;
}

// ─── 4. Checklist ─────────────────────────────────────────────────────────

export interface ChecklistItem {
  value: string;
  label: string;
  checked?: boolean;
}

export interface ChecklistBlock extends BlockBase {
  type: 'checklist';
  id: string;
  prompt: string;
  items: ChecklistItem[];
  confirm_label?: string;
}

// ─── 5. Sortable ──────────────────────────────────────────────────────────

export interface SortableItem {
  value: string;
  label: string;
}

export interface SortableBlock extends BlockBase {
  type: 'sortable';
  id: string;
  prompt: string;
  items: SortableItem[];
  confirm_label?: string;
}

// ─── 6. Diff ──────────────────────────────────────────────────────────────

export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffBlock extends BlockBase {
  type: 'diff';
  file: string;
  language?: string;
  hunks: DiffHunk[];
  stats?: { additions: number; deletions: number };
}

// ─── 7. File Tree ─────────────────────────────────────────────────────────

export interface FileTreeNode {
  path: string;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
  children?: FileTreeNode[];
}

export interface FileTreeBlock extends BlockBase {
  type: 'file-tree';
  nodes: FileTreeNode[];
}

// ─── 8. Terminal ──────────────────────────────────────────────────────────

export interface TerminalBlock extends BlockBase {
  type: 'terminal';
  command: string;
  output: string;
  exit_code?: number;
}

// ─── 9. Progress ──────────────────────────────────────────────────────────

export type StepStatus = 'done' | 'active' | 'pending' | 'failed';

export interface ProgressStep {
  label: string;
  status: StepStatus;
}

export interface ProgressBlock extends BlockBase {
  type: 'progress';
  title?: string;
  steps: ProgressStep[];
}

// ─── 10. Code ─────────────────────────────────────────────────────────────

export interface CodeBlock extends BlockBase {
  type: 'code';
  file?: string;
  language?: string;
  start_line?: number;
  content: string;
  highlight_lines?: number[];
}

// ─── 11. Before/After ────────────────────────────────────────────────────

export interface CodeSide {
  label: string;
  content: string;
}

export interface BeforeAfterBlock extends BlockBase {
  type: 'before-after';
  file?: string;
  language?: string;
  before: CodeSide;
  after: CodeSide;
}

// ─── 12. Error ────────────────────────────────────────────────────────────

export interface ErrorBlock extends BlockBase {
  type: 'error';
  title: string;
  file?: string;
  line?: number;
  stack?: string;
  suggestion?: string;
}

// ─── 13. Confirm Danger ──────────────────────────────────────────────────

export interface ConfirmDangerBlock extends BlockBase {
  type: 'confirm-danger';
  id: string;
  title: string;
  description: string;
  command?: string;
  confirm_label?: string;
  cancel_label?: string;
}

// ─── 14. Commit ───────────────────────────────────────────────────────────

export interface CommitBlock extends BlockBase {
  type: 'commit';
  id: string;
  message: string;
  files?: string[];
  stats?: { additions: number; deletions: number };
}

// ─── 15. Run Command ─────────────────────────────────────────────────────

export interface RunCommandBlock extends BlockBase {
  type: 'run-command';
  id: string;
  command: string;
  description?: string;
  risk?: 'safe' | 'moderate' | 'dangerous';
}

// ─── 16. Thinking ─────────────────────────────────────────────────────────

export interface ThinkingBlock extends BlockBase {
  type: 'thinking';
  content: string;
}

// ─── 17. Cost ─────────────────────────────────────────────────────────────

export interface CostBlock extends BlockBase {
  type: 'cost';
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  estimated_cost?: number;
  session_total_cost?: number;
}

// ─── 19. File Peek ────────────────────────────────────────────────────────

export interface FilePeekBlock extends BlockBase {
  type: 'file-peek';
  file: string;
  language?: string;
  start_line?: number;
  content: string;
  total_lines?: number;
}

// ─── 20. Carousel ─────────────────────────────────────────────────────────

export interface CarouselCard {
  title: string;
  subtitle?: string;
  preview?: string;
  meta?: string;
}

export interface CarouselBlock extends BlockBase {
  type: 'carousel';
  title?: string;
  cards: CarouselCard[];
}

// ─── 21. Link Preview ────────────────────────────────────────────────────

export interface LinkPreviewBlock extends BlockBase {
  type: 'link-preview';
  url: string;
  title: string;
  description?: string;
  domain?: string;
}

// ─── Union type ───────────────────────────────────────────────────────────

export type Block =
  | ButtonsBlock
  | SwipeBlock
  | SliderBlock
  | ChecklistBlock
  | SortableBlock
  | DiffBlock
  | FileTreeBlock
  | TerminalBlock
  | ProgressBlock
  | CodeBlock
  | BeforeAfterBlock
  | ErrorBlock
  | ConfirmDangerBlock
  | CommitBlock
  | RunCommandBlock
  | ThinkingBlock
  | CostBlock
  | FilePeekBlock
  | CarouselBlock
  | LinkPreviewBlock;

// ─── Block response (user interaction reply) ──────────────────────────────

export interface BlockResponse {
  block_id: string;
  type: string;
  value: string | number | boolean | string[];
}

// ─── Interactive block type guard ─────────────────────────────────────────

export type InteractiveBlock =
  | ButtonsBlock
  | SwipeBlock
  | SliderBlock
  | ChecklistBlock
  | SortableBlock
  | ConfirmDangerBlock
  | CommitBlock
  | RunCommandBlock;

export const isInteractiveBlock = (block: Block): block is InteractiveBlock =>
  ['buttons', 'swipe', 'slider', 'checklist', 'sortable', 'confirm-danger', 'commit', 'run-command'].includes(block.type);
