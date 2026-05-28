import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { PhoneFrame } from '../components/PhoneFrame';
import { RoomShell, ChatMsg } from '../pwa/RoomShell';
import { C } from '../theme';

type ScriptedMsg = {
  at: number;
  msg: ChatMsg;
};

const SCRIPT: ScriptedMsg[] = [
  { at: 20, msg: { type: 'text', id: 'a', who: 'me', sender: 'You', content: 'you’re in. welcome 👋' } },
  { at: 60, msg: { type: 'text', id: 'b', who: 'them', sender: 'Mira', content: 'thanks for letting me in' } },
  { at: 105, msg: { type: 'text', id: 'c', who: 'them', sender: 'Mira', content: 'is the server able to read any of this?' } },
  { at: 160, msg: { type: 'text', id: 'd', who: 'me', sender: 'You', content: 'nope. ciphertext only.' } },
  { at: 200, msg: { type: 'text', id: 'e', who: 'me', sender: 'You', content: 'message history lives on each device, in IndexedDB.' } },
  { at: 240, msg: { type: 'text', id: 'f', who: 'them', sender: 'Mira', content: 'and if I close the tab?' } },
];

export const ChatScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phoneIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  const messages = SCRIPT.filter((m) => frame >= m.at).map((m) => m.msg);

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
          They talk
        </div>
        <div style={{ marginTop: 10, fontSize: 22, color: C.inkDim }}>
          AES-256-GCM · server routes ciphertext only
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
        <PhoneFrame scale={0.92} translateY={50} time="9:43">
          <RoomShell
            channelColor="hsl(140, 55%, 80%)"
            channelName="launch crew"
            handle="andrei"
            messages={messages}
          />
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};
