import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { PhoneFrame } from '../components/PhoneFrame';
import { RoomShell, ChatMsg, Knock } from '../pwa/RoomShell';
import { C } from '../theme';

const BASE_MESSAGES: ChatMsg[] = [
  { type: 'text', id: 'm1', who: 'me', sender: 'You', content: 'anyone there?' },
  { type: 'text', id: 'm2', who: 'them', sender: 'alex', content: 'here. quiet for now.' },
];

const SYSTEM_JOINED: ChatMsg = {
  type: 'system',
  id: 'sys1',
  content: 'Mira joined',
  timestamp: 'just now',
};

const KNOCKS: Knock[] = [
  { id: 'k1', note: 'hey it’s Mira from work', when: 'just now' },
];

export const ApproveScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phoneIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  // Bell ring (only visible 20-70)
  const ringOpacity = interpolate(frame, [20, 45, 70], [0, 0.5, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ringScale = interpolate(frame, [20, 70], [1, 2.6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const showQueue = frame > 70 && frame < 175;
  const approvedAt = 160;
  const messages: ChatMsg[] = frame > approvedAt ? [...BASE_MESSAGES, SYSTEM_JOINED] : BASE_MESSAGES;

  const bellRing = ringOpacity > 0 && (
    <span
      style={{
        position: 'absolute',
        inset: -6,
        borderRadius: '50%',
        border: '2px solid #b91c1c',
        opacity: ringOpacity,
        transform: `scale(${ringScale})`,
        pointerEvents: 'none',
      }}
      aria-hidden
    />
  );

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: 80,
          width: '100%',
          textAlign: 'center',
          opacity: cap,
        }}
      >
        <div style={{ fontSize: 36, color: C.inkSoft, fontWeight: 500, letterSpacing: '-0.01em' }}>
          The bell lights up
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: C.inkDim }}>
          someone inside approves the knock
        </div>
      </div>

      <div
        style={{
          opacity: phoneIn,
          transform: `translateY(${interpolate(phoneIn, [0, 1], [60, 0])}px)`,
          width: '100%',
          height: '100%',
        }}
      >
        <PhoneFrame scale={0.92} translateY={50} time="9:42">
          <RoomShell
            channelColor="hsl(140, 55%, 80%)"
            channelName="launch crew"
            handle="andrei"
            badgeCount={frame > 18 && frame < approvedAt ? 1 : 0}
            messages={messages}
            showQueue={showQueue}
            knocks={KNOCKS}
            bellRingOverlay={bellRing}
          />
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};
