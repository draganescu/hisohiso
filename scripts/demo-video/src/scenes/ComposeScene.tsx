import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { PhoneFrame } from '../components/PhoneFrame';
import { RoomShell, ChatMsg } from '../pwa/RoomShell';
import { ComposeModal } from '../pwa/ComposeModal';
import { C } from '../theme';

const BASE_MESSAGES: ChatMsg[] = [
  { type: 'text', id: 'p1', who: 'them', sender: 'Mira', content: 'and if I close the tab?' },
  { type: 'text', id: 'p2', who: 'me', sender: 'You', content: 'IndexedDB stays. server doesn’t.' },
];

const SENT: ChatMsg = {
  type: 'text',
  id: 'sent',
  who: 'me',
  sender: 'You',
  content: 'great — let’s keep this channel open through the launch.',
};

const DRAFT = 'great — let’s keep this channel open through the launch.';

export const ComposeScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phoneIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  // Modal slides up around frame 35; closes around 165
  const modalOpenAt = 35;
  const modalCloseAt = 165;
  const modalOpen = frame >= modalOpenAt && frame < modalCloseAt;
  const modalSlide = interpolate(
    frame,
    [modalOpenAt, modalOpenAt + 18, modalCloseAt - 6, modalCloseAt],
    [1, 0, 0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // Typewriter for the draft
  const typeStart = modalOpenAt + 30;
  const typed = DRAFT.slice(
    0,
    Math.max(0, Math.min(DRAFT.length, Math.floor((frame - typeStart) / 1.6))),
  );

  // Send press tap (~150)
  const sendDisabled = typed.trim().length === 0;
  const sendPressAt = 150;
  const sendPress = interpolate(
    frame,
    [sendPressAt, sendPressAt + 6, sendPressAt + 12],
    [1, 0.94, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // After modal closes, the new bubble appears in the chat
  const sentAppearsAt = modalCloseAt + 5;
  const messages: ChatMsg[] = frame >= sentAppearsAt ? [...BASE_MESSAGES, SENT] : BASE_MESSAGES;

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
          Tap Compose to write
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: C.inkDim }}>
          full-screen modal · keyboard gets the room
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
        <PhoneFrame scale={0.92} translateY={50} time="9:44">
          <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
            <RoomShell
              channelColor="hsl(140, 55%, 80%)"
              channelName="launch crew"
              handle="andrei"
              messages={messages}
              hideComposer={modalOpen}
            />

            {modalOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 60,
                  transform: `translateY(${modalSlide * 100}%) scale(${
                    frame >= sendPressAt && frame <= sendPressAt + 12 ? sendPress : 1
                  })`,
                  transformOrigin: 'top right',
                  willChange: 'transform',
                }}
              >
                <ComposeModal handle="andrei" value={typed} sendDisabled={sendDisabled} />
              </div>
            )}
          </div>
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};
