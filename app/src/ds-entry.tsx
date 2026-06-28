// Design-system entry — re-exports every component synced to claude.ai/design.
// Authored as a /design-sync input. NOT imported by the app itself (the app
// mounts from main.tsx); this module only declares the design-system surface
// so the converter can bundle it and extract each component's type contract.

// ── Message blocks ─────────────────────────────────────────────────────────
export { BlockRenderer } from './components/blocks/BlockRenderer';
export { ConfidenceDot } from './components/blocks/ConfidenceDot';
export { BeforeAfterBlockView } from './components/blocks/BeforeAfterBlock';
export { ButtonsBlockView } from './components/blocks/ButtonsBlock';
export { CarouselBlockView } from './components/blocks/CarouselBlock';
export { ChecklistBlockView } from './components/blocks/ChecklistBlock';
export { CodeBlockView } from './components/blocks/CodeBlock';
export { CommitBlockView } from './components/blocks/CommitBlock';
export { ConfirmDangerBlockView } from './components/blocks/ConfirmDangerBlock';
export { CostBlockView } from './components/blocks/CostBlock';
export { DiffBlockView } from './components/blocks/DiffBlock';
export { ErrorBlockView } from './components/blocks/ErrorBlock';
export { FilePeekBlockView } from './components/blocks/FilePeekBlock';
export { FileTreeBlockView } from './components/blocks/FileTreeBlock';
export { LabelBlockView } from './components/blocks/LabelBlock';
export { LinkPreviewBlockView } from './components/blocks/LinkPreviewBlock';
export { ListBlockView } from './components/blocks/ListBlock';
export { ProgressBlockView } from './components/blocks/ProgressBlock';
export { ProseBlockView } from './components/blocks/ProseBlock';
export { RunCommandBlockView } from './components/blocks/RunCommandBlock';
export { SliderBlockView } from './components/blocks/SliderBlock';
export { SortableBlockView } from './components/blocks/SortableBlock';
export { SwatchesBlockView } from './components/blocks/SwatchesBlock';
export { SwipeBlockView } from './components/blocks/SwipeBlock';
export { TerminalBlockView } from './components/blocks/TerminalBlock';
export { ThinkingBlockView } from './components/blocks/ThinkingBlock';

// ── App chrome ─────────────────────────────────────────────────────────────
export { default as Avatar } from './components/Avatar';
export { default as AppLock } from './components/AppLock';
export { default as AppLockSettings } from './components/AppLockSettings';
export { ControlCommandBar } from './components/ControlCommandBar';
export { GroupedChannelList } from './components/GroupedChannelList';
export { default as InstallPrompt } from './components/InstallPrompt';
export { default as QrModal } from './components/QrModal';
export { RoomCard } from './components/RoomCard';
export { RoomRow } from './components/RoomRow';
export { default as RoomsRail } from './components/RoomsRail';
export { default as ThemeToggle } from './components/ThemeToggle';
