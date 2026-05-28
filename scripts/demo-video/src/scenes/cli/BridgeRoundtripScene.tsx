import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { TerminalFrame, TermLine, sliceText } from '../../components/TerminalFrame';
import { PhoneFrame } from '../../components/PhoneFrame';
import { RoomShell, ChatMsg } from '../../pwa/RoomShell';
import { C, FONT_MONO } from '../../theme';

const Q1 = 'server.ts crashes on startup — any idea why?';
const A1_TEXT =
  'Yeah — line 88 calls db.connect() like it’s sync, but it returns a Promise. Move the call into an async init() or await it where it’s called.\n\n' +
  '- const conn = db.connect();\n' +
  '+ const conn = await db.connect();';
const A1_PREVIEW = 'Yeah — line 88 calls db.connect() like it’s sync, but it returns a Promise...';

const Q2 = 'yes — patch it';
const A2_TEXT =
  'Patched server.ts:88.\n\n' +
  '  async function bootstrap() {\n' +
  '-   const conn = db.connect();\n' +
  '+   const conn = await db.connect();\n' +
  '    return new Server(conn);\n' +
  '  }';

const SESSION_ID = '7c2a91e3-4d40-4b88';

export const BridgeRoundtripScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cap = interpolate(frame, [10, 30], [0, 1], { extrapolateRight: 'clamp' });

  const termIn = spring({ frame, fps, config: { damping: 22, stiffness: 110 } });
  const phoneIn = spring({ frame: frame - 12, fps, config: { damping: 22, stiffness: 110 } });

  // Turn 1
  const t1UserAt = 35;
  const t1IncomingAt = 78;
  const t1CmdAt = 95;
  const t1SessionAt = 150;
  const t1SpinnerUntil = 200;
  const t1ResponseAt = 205;
  const t1ReplyAt = 235;

  const t1CmdText = `claude --output-format json "${Q1}"`;
  const t1CmdRev = sliceText(t1CmdText, Math.floor((frame - t1CmdAt) / 1.2));
  const t1SpinnerActive = frame >= t1SessionAt && frame < t1SpinnerUntil;

  // Hand-off caption (session resume hint)
  const captionInAt = 285;
  const captionOutAt = 350;
  const captionOp = interpolate(
    frame,
    [captionInAt, captionInAt + 12, captionOutAt, captionOutAt + 12],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // Turn 2
  const t2UserAt = 305;
  const t2IncomingAt = 340;
  const t2CmdAt = 355;
  const t2SpinnerStartAt = 405;
  const t2SpinnerUntil = 425;
  const t2ResponseAt = 430;
  const t2ReplyAt = 450;

  const t2CmdText = `claude --output-format json --resume ${SESSION_ID} "${Q2}"`;
  const t2CmdRev = sliceText(t2CmdText, Math.floor((frame - t2CmdAt) / 1.2));
  const t2SpinnerActive = frame >= t2SpinnerStartAt && frame < t2SpinnerUntil;

  const messages: ChatMsg[] = [];
  if (frame >= t1UserAt) messages.push({ type: 'text', id: 'q1', who: 'me', sender: 'You', content: Q1 });
  if (frame >= t1ReplyAt) messages.push({ type: 'text', id: 'a1', who: 'them', sender: 'claude', content: A1_TEXT });
  if (frame >= t2UserAt) messages.push({ type: 'text', id: 'q2', who: 'me', sender: 'You', content: Q2 });
  if (frame >= t2ReplyAt) messages.push({ type: 'text', id: 'a2', who: 'them', sender: 'claude', content: A2_TEXT });

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: 36,
          width: '100%',
          textAlign: 'center',
          opacity: cap,
        }}
      >
        <div style={{ fontSize: 32, color: C.inkSoft, fontWeight: 500, letterSpacing: '-0.01em' }}>
          Talking to Claude from the chat
        </div>
        <div style={{ marginTop: 4, fontSize: 20, color: C.inkDim }}>
          phone message → claude turn → reply streams back · session resumes between messages
        </div>
      </div>

      {/* Terminal — top */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: 120,
          transform: `translateX(-50%) translateY(${interpolate(termIn, [0, 1], [40, 0])}px)`,
          opacity: termIn,
        }}
      >
        <TerminalFrame width={960} height={780} title="andrei@air — hisohiso wrap claude">
          <TermLine text="Listening (session). Messages from phone → claude <message>" dim />
          <div style={{ height: 8 }} />

          {frame > t1IncomingAt && <TermLine text={`← ${Q1}`} color="#7dd3fc" />}
          {frame > t1CmdAt && <TermLine text={`  $ ${t1CmdRev}`} dim />}
          {frame > t1SessionAt && <TermLine text={`  [session: ${SESSION_ID}]`} color="#c4b5fd" />}
          {t1SpinnerActive && <TermLine text={`  ${spinner(frame)} running...`} dim />}
          {frame > t1ResponseAt && <TermLine text={`→ ${A1_PREVIEW}`} color="#86efac" />}

          {frame > t2IncomingAt && <div style={{ height: 12 }} />}
          {frame > t2IncomingAt && <TermLine text={`← ${Q2}`} color="#7dd3fc" />}
          {frame > t2CmdAt && <TermLine text={`  $ ${t2CmdRev}`} dim />}
          {t2SpinnerActive && <TermLine text={`  ${spinner(frame)} running...`} dim />}
          {frame > t2ResponseAt && <TermLine text="→ Patched server.ts:88. Diff applied." color="#86efac" />}
        </TerminalFrame>
      </div>

      {/* Resume caption */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 900,
          textAlign: 'center',
          opacity: captionOp,
          color: '#7d4cdb',
          fontSize: 22,
          fontFamily: FONT_MONO,
          letterSpacing: '0.02em',
        }}
      >
        ↻ same session — Claude remembers the previous turn
      </div>

      {/* Phone — bottom */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: -200,
          opacity: phoneIn,
          transform: `translateY(${interpolate(phoneIn, [0, 1], [60, 0])}px)`,
          height: 1500,
        }}
      >
        <PhoneFrame scale={0.58} translateY={0} time="9:43">
          <RoomShell
            channelColor="hsl(20, 65%, 80%)"
            channelName="claude"
            handle="andrei"
            messages={messages}
          />
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};

const spinner = (frame: number) =>
  ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][Math.floor(frame / 3) % 10];
