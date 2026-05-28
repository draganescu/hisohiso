import { ReactNode } from 'react';

type Props = {
  children: ReactNode;
  scale?: number;
  rotate?: number;
  translateX?: number;
  translateY?: number;
  time?: string;
  width?: number;
  height?: number;
};

// Modern iPhone (15+/16) proportions:
//   - Device aspect ratio ~ 9:19.5
//   - Dynamic Island ≈ 124×35, centered, ~12px below the screen edge
//   - Bezel ≈ 14px around a 56px-radius screen inside a 70px-radius frame
export const PhoneFrame = ({
  children,
  scale = 1,
  rotate = 0,
  translateX = 0,
  translateY = 0,
  time = '9:41',
  width = 720,
  height,
}: Props) => {
  const h = height ?? Math.round((width * 19.5) / 9);
  const bezel = Math.round(width * 0.02);
  const frameRadius = Math.round(width * 0.105);
  const screenRadius = frameRadius - bezel;
  const diW = Math.round(width * 0.175);
  const diH = Math.round(diW * 0.28);
  const statusH = Math.round(h * 0.045);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `translate(${translateX}px, ${translateY}px) rotate(${rotate}deg) scale(${scale})`,
      }}
    >
      <div
        style={{
          width,
          height: h,
          borderRadius: frameRadius,
          background: 'linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 50%, #1a1a1a 100%)',
          padding: bezel,
          boxShadow:
            '0 60px 120px rgba(10,10,10,0.20), 0 24px 48px rgba(10,10,10,0.16), inset 0 0 0 1.5px rgba(255,255,255,0.06)',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: screenRadius,
            backgroundColor: '#f5f5f3',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {/* Status bar */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: statusH,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `0 ${Math.round(width * 0.08)}px`,
              fontSize: Math.round(width * 0.028),
              fontWeight: 600,
              color: '#0a0a0a',
              letterSpacing: '-0.01em',
              zIndex: 4,
            }}
          >
            <span>{time}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <SignalIcon size={Math.round(width * 0.025)} />
              <WifiIcon size={Math.round(width * 0.025)} />
              <BatteryIcon w={Math.round(width * 0.04)} h={Math.round(width * 0.022)} />
            </span>
          </div>

          {/* Dynamic Island */}
          <div
            style={{
              position: 'absolute',
              top: Math.round(width * 0.018),
              left: '50%',
              transform: 'translateX(-50%)',
              width: diW,
              height: diH,
              borderRadius: diH / 2,
              backgroundColor: '#0a0a0a',
              zIndex: 5,
            }}
          />

          {/* Page content (under status bar) */}
          <div style={{ position: 'absolute', inset: 0, paddingTop: statusH }}>{children}</div>
        </div>
      </div>
    </div>
  );
};

const SignalIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 17 11" fill="currentColor">
    <rect x="0" y="7" width="3" height="4" rx="0.5" />
    <rect x="4.5" y="5" width="3" height="6" rx="0.5" />
    <rect x="9" y="2.5" width="3" height="8.5" rx="0.5" />
    <rect x="13.5" y="0" width="3" height="11" rx="0.5" />
  </svg>
);

const WifiIcon = ({ size }: { size: number }) => (
  <svg width={size * 1.2} height={size} viewBox="0 0 16 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M2 5 Q8 0 14 5" />
    <path d="M4 7 Q8 3.5 12 7" />
    <circle cx="8" cy="9.5" r="0.9" fill="currentColor" />
  </svg>
);

const BatteryIcon = ({ w, h }: { w: number; h: number }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: w,
        height: h,
        border: '1.2px solid #0a0a0a',
        borderRadius: 3,
        padding: 1,
      }}
    >
      <span
        style={{
          display: 'block',
          width: '92%',
          height: '100%',
          backgroundColor: '#0a0a0a',
          borderRadius: 1.5,
        }}
      />
    </span>
    <span
      style={{
        display: 'inline-block',
        width: 1.5,
        height: h * 0.45,
        backgroundColor: '#0a0a0a',
        borderRadius: 0.5,
        marginLeft: 1,
      }}
    />
  </span>
);
