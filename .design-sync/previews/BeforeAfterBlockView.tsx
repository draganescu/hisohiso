import { BeforeAfterBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const RefactorToggle = () => (
  <div style={frame}>
    <BeforeAfterBlockView
      block={{
        type: 'before-after',
        file: 'src/lib/presence.ts',
        language: 'ts',
        before: {
          label: 'Before',
          content: `function startPoll() {
  clearInterval(timer);
  timer = setInterval(poll, 1000);
}`,
        },
        after: {
          label: 'After',
          content: `function startPoll() {
  if (timer) clearInterval(timer);
  timer = setInterval(poll, POLL_MS);
}`,
        },
      }}
    />
  </div>
);

export const ConfigMigration = () => (
  <div style={frame}>
    <BeforeAfterBlockView
      block={{
        type: 'before-after',
        file: 'Caddyfile',
        before: {
          label: 'v0.11',
          content: `:8080 {
  root * /app
  php_server
}`,
        },
        after: {
          label: 'v0.12',
          content: `:8080 {
  root * /app/public
  encode zstd gzip
  php_server
}`,
        },
      }}
    />
  </div>
);
