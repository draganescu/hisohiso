import { ConfidenceDot } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

const row: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
};

export const AllLevels = () => (
  <div style={frame}>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        padding: '12px 4px',
        flexWrap: 'wrap',
      }}
    >
      <span style={row}>
        <ConfidenceDot level="high" />
        High
      </span>
      <span style={row}>
        <ConfidenceDot level="medium" />
        Medium
      </span>
      <span style={row}>
        <ConfidenceDot level="low" />
        Low
      </span>
    </div>
  </div>
);

export const InContext = () => (
  <div style={frame}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 4px' }}>
      <span style={row}>
        <ConfidenceDot level="high" />
        Confident the race is in the presence poller
      </span>
      <span style={row}>
        <ConfidenceDot level="medium" />
        The Redis TTL of 30s is probably right
      </span>
      <span style={row}>
        <ConfidenceDot level="low" />
        Unsure this reproduces on Safari
      </span>
    </div>
  </div>
);
