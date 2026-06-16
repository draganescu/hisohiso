import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const repoRoot = resolve(root, '..');
const styles = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const appIndex = readFileSync(resolve(root, 'index.html'), 'utf8');
const fontCss = readFileSync(resolve(root, 'public/fonts/riso-fonts.css'), 'utf8');
const roomController = readFileSync(resolve(root, 'src/pages/RoomController.tsx'), 'utf8');
const roomsPage = readFileSync(resolve(root, 'src/pages/RoomsPage.tsx'), 'utf8');
const roomCreator = readFileSync(resolve(root, 'src/pages/RoomCreator.tsx'), 'utf8');

assert.match(styles, /--accent:\s*#ff4d8d/, 'design tokens expose the riso pink accent color');
assert.match(styles, /\.app-chrome\b/, 'app chrome shell class exists');
assert.match(styles, /\.glass-panel\b/, 'glass panel surface class exists');
assert.match(styles, /\.floating-action\b/, 'floating action class exists');
assert.match(styles, /\.message-card\b/, 'message card class exists');
assert.match(styles, /prefers-reduced-motion/, 'reduced motion preference is respected');
assert.match(appIndex, /\/fonts\/riso-fonts\.css/, 'app loads self-hosted riso fonts');
assert.doesNotMatch(appIndex + fontCss, /fonts\.(googleapis|gstatic)\.com/, 'app font loading should not call Google at runtime');

const marketingHtmlPaths = [
  resolve(repoRoot, 'public/index.html'),
  ...readdirSync(resolve(repoRoot, 'public'))
    .map((entry) => resolve(repoRoot, 'public', entry, 'index.html'))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    }),
];
for (const path of marketingHtmlPaths) {
  const html = readFileSync(path, 'utf8');
  assert.match(html, /\/fonts\/riso-fonts\.css/, `${path} should load self-hosted riso fonts`);
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/, `${path} should not call Google Fonts`);
}

assert.match(roomController, /className="app-shell app-chrome/, 'room uses redesigned app chrome');
assert.match(roomController, /pointer-events-auto pill-control/, 'header controls float as glass pills over the messages');
assert.match(roomController, /className="floating-action/, 'compose CTA uses redesigned floating action');
assert.match(roomController, /className=\{`message-card/, 'messages use redesigned message card primitive');
assert.match(roomController, /className="modal-frame"/, 'overlays use the modal-frame outer wrapper');
assert.match(roomController, /className="modal-shell flex/, 'overlays use redesigned modal shell');

assert.match(roomsPage, /className="app-page app-chrome/, 'rooms index uses redesigned app page');
assert.match(roomCreator, /className="app-page app-chrome/, 'room creator uses redesigned app page');

console.log('design system smoke OK');
