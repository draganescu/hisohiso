import { CarouselBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const OpenPullRequests = () => (
  <div style={frame}>
    <CarouselBlockView
      block={{
        type: 'carousel',
        title: 'Open pull requests',
        cards: [
          {
            title: 'Fix switcher landing on oldest message',
            subtitle: '#221 · draganescu',
            preview: 'Scroll position now anchors to the latest read marker on room switch.',
            meta: '+34 -12 · 2 files',
          },
          {
            title: 'Desktop rail channel switch draft fix',
            subtitle: '#222 · draganescu',
            preview: 'Switching channels no longer submits the open compose draft.',
            meta: '+18 -5 · 1 file',
          },
          {
            title: 'Blur send race on mobile keyboard',
            subtitle: '#223 · draganescu',
            preview: 'Debounce blur so the send button keeps the pending message.',
            meta: '+9 -3 · 1 file',
          },
        ],
      }}
    />
  </div>
);

export const TestRunReports = () => (
  <div style={frame}>
    <CarouselBlockView
      block={{
        type: 'carousel',
        title: 'Recent CI runs',
        cards: [
          {
            title: 'room-session.test.ts',
            subtitle: 'passed in 1.8s',
            preview: '42 passed · 0 failed',
            meta: 'main @ 4315c83',
          },
          {
            title: 'presence.test.ts',
            subtitle: 'flaky · retried',
            preview: '19 passed · 1 retried',
            meta: 'main @ 2e0c219',
          },
          {
            title: 'pairing.e2e.ts',
            subtitle: 'passed in 6.2s',
            preview: '8 passed · 0 failed',
            meta: 'main @ 6713233',
          },
        ],
      }}
    />
  </div>
);
