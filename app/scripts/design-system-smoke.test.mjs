import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const styles = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const roomController = readFileSync(resolve(root, 'src/pages/RoomController.tsx'), 'utf8');
const roomsPage = readFileSync(resolve(root, 'src/pages/RoomsPage.tsx'), 'utf8');
const roomCreator = readFileSync(resolve(root, 'src/pages/RoomCreator.tsx'), 'utf8');

assert.match(styles, /--accent:\s*#ff4d8d/, 'design tokens expose the riso pink accent color');
assert.match(styles, /\.app-chrome\b/, 'app chrome shell class exists');
assert.match(styles, /\.glass-panel\b/, 'glass panel surface class exists');
assert.match(styles, /\.floating-action\b/, 'floating action class exists');
assert.match(styles, /\.message-card\b/, 'message card class exists');
assert.match(styles, /prefers-reduced-motion/, 'reduced motion preference is respected');

assert.match(roomController, /className="app-shell app-chrome/, 'room uses redesigned app chrome');
assert.match(roomController, /pointer-events-auto pill-control/, 'header controls float as glass pills over the messages');
assert.match(roomController, /className="floating-action/, 'compose CTA uses redesigned floating action');
assert.match(roomController, /className=\{`message-card/, 'messages use redesigned message card primitive');
assert.match(roomController, /className="modal-frame"/, 'overlays use the modal-frame outer wrapper');
assert.match(roomController, /className="modal-shell flex/, 'overlays use redesigned modal shell');

assert.match(roomsPage, /className="app-page app-chrome/, 'rooms index uses redesigned app page');
assert.match(roomCreator, /className="app-page app-chrome/, 'room creator uses redesigned app page');

console.log('design system smoke OK');
