import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  decryptText,
  deriveKnockKey,
  deriveMessageKey,
  deriveRoomHash,
  encryptText,
  randomBytes,
  base64UrlEncode,
  sha256Hex,
  generateEphemeralKeyPair,
  beginApprove,
  unwrapAndDeriveClaim,
  type EncryptedPayload
} from '../lib/crypto';
import {
  clearSubscriberJwt,
  clearToken,
  getExpectedKnockMessage,
  getHandle,
  getLastKnockMessage,
  getRoomPassword,
  getRoomSetupDismissed,
  getRoomCreatedByMe,
  getRoomColor,
  getRoomKind,
  getRoomNickname,
  getSubscriberJwt,
  getToken,
  listRooms,
  setHandle,
  setExpectedKnockMessage,
  setLastKnockMessage,
  setRoomKind,
  setRoomPassword,
  setRoomSetupDismissed,
  setSubscriberJwt,
  setToken,
  upsertRoom,
  updateRoomHandle,
  updateRoomNickname,
  type RoomKind,
  type StoredRoom
} from '../lib/storage';
import { groupOpenChannels } from '../lib/room-grouping';
import { GroupedChannelList } from '../components/GroupedChannelList';
import { createRoomEventSource } from '../lib/mercure';
import { useRoomPresence } from '../lib/presence';
import { useRoomAutoApprove } from '../lib/auto-approve';
import { setPendingKnockCount } from '../lib/pending-knocks';
import { deleteMessage, loadMessages, saveMessage, type ChatMessage, type MessageAction, type ReplyEntry } from '../lib/db';
import { type Block, type BlockResponse } from '../lib/blocks';
import type { KnockRequest, RoomEvent, RoomState } from '../lib/room-contracts';
import { formatBlockResponse, formatBlockValue, formatRoomContext, getMessagePreview, mergeChatMessageEcho, parseRoomEnvelope, toChatMessageRecord, type RoomContext } from '../lib/room-message';
import { generateRoomName } from '../lib/room-names';
import {
  fetchOutbox,
  fetchRoomStatus,
  parseRoomEvent,
  postEncryptedRoomMessage,
  postPresence,
  postApprove,
  postDisband,
  postKnock,
  postLeave,
  postReject,
  postRoomSettings,
  postWrappedToken,
  refreshSubscriberToken,
  type OutboxMessage,
  type RoomLookupResponse,
} from '../lib/room-session';
import { disablePush, enablePush, getPushStatus, markPushForeground, triggerRoomPush, type PushStatus } from '../lib/push';
import { wipeLocalRoomArtifacts } from '../lib/room-local-cleanup';
import { BlockRenderer, type BlockResponseInput } from '../components/blocks/BlockRenderer';
import { useKeyboardViewport } from '../hooks/useKeyboardViewport';
import { useMessageWindow } from '../hooks/useMessageWindow';
import QrModal from '../components/QrModal';
import { ControlCommandBar } from '../components/ControlCommandBar';
import { SchedulePanel } from '../components/SchedulePanel';
import { RoomRow } from '../components/RoomRow';
import RoomsRail from '../components/RoomsRail';
import { ScrollDiag } from '../components/ScrollDiag';

const readRoomSecretFromHash = (): string => window.location.hash.replace(/^#\/?/, '');

// Synchronously derive chrome state (hash, nickname, color, token, etc.) for the
// room in the URL hash, so the first paint after a hard reload already shows the
// correct PARTICIPANT layout instead of flashing the INIT loading card. Only
// returns non-null if we have a stored participant token for this room — otherwise
// the async init flow takes over from the INIT state as before.
type OptimisticContext = {
  roomSecret: string;
  roomHash: string;
  token: string;
  handle: string;
  roomPassword: string;
  roomNickname: string;
  roomColor: string;
  subJwt: string | null;
};

const loadInitialContext = (): OptimisticContext | null => {
  const roomSecret = readRoomSecretFromHash();
  if (!roomSecret) return null;
  const stored = listRooms().find((r) => r.roomSecret === roomSecret);
  if (!stored) return null;
  const hash = stored.roomHash;
  const token = getToken(hash);
  if (!token) return null;
  return {
    roomSecret,
    roomHash: hash,
    token,
    handle: getHandle(hash) ?? '',
    roomPassword: getRoomPassword(hash) ?? '',
    roomNickname: getRoomNickname(hash) ?? '',
    roomColor: getRoomColor(hash),
    subJwt: getSubscriberJwt(hash),
  };
};

const formatMailStamp = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
};

const getMessageLabel = (message: ChatMessage): string => {
  if (message.type === 'system') {
    return 'System';
  }
  if (message.direction === 'out') {
    return message.handle ? `${message.handle} (you)` : 'you';
  }
  return message.handle || 'room member';
};

// One live work-status for an agent, derived from an ephemeral `status` event.
// `at` is the client receive time, used to expire a stale indicator if the
// daemon goes silent without sending a terminal status to clear it.
// `at` is the client receive time (drives the 30s stale backstop); `ts` is the
// status event's server timestamp (same clock domain as chat message ts), used
// to decide whether a recovered chat reply post-dates — and so supersedes — a
// stale indicator whose terminal `done` we missed while backgrounded.
type AgentStatus = { state: string; text: string; handle: string | null; at: number; ts: number };

type RoomSetupStage = 'security' | 'delivery';

const roomSetupBlocks = (stage: RoomSetupStage): Block[] => (
  stage === 'security'
    ? [
        {
          type: 'buttons',
          id: 'room-setup-security',
          prompt: 'Do you want to secure this room more?',
          options: [
            { label: 'Add password', value: 'password' },
            { label: 'Expected knock phrase', value: 'knock_phrase' },
            { label: 'No setup', value: 'skip_security' },
          ],
        },
      ]
    : [
        {
          type: 'buttons',
          id: 'room-setup-delivery',
          prompt: 'Do you want offline catch-up or notifications?',
          options: [
            { label: 'Offline catch-up', value: 'catchup' },
            { label: 'Notifications', value: 'notifications' },
            { label: 'No thanks', value: 'skip' },
          ],
        },
      ]
);

const RoomController = () => {
  const [initialContext] = useState<OptimisticContext | null>(loadInitialContext);
  const [roomSecret, setRoomSecret] = useState(() => initialContext?.roomSecret ?? readRoomSecretFromHash());
  const [roomHash, setRoomHash] = useState<string>(() => initialContext?.roomHash ?? '');
  const [roomState, setRoomState] = useState<RoomState>(() => (initialContext ? 'PARTICIPANT' : 'INIT'));
  const [error, setError] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [knockSent, setKnockSent] = useState(false);
  const [knockNotice, setKnockNotice] = useState<string>('');
  const [knocks, setKnocks] = useState<KnockRequest[]>([]);
  const [roomPassword, setRoomPasswordState] = useState(() => initialContext?.roomPassword ?? '');
  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Transient per-agent work indicator, fed by the daemon's ephemeral `status`
  // events. Keyed by sender hash. NOT persisted and NOT part of `messages` — it
  // renders as a single in-place "agent is working" bubble that updates as state
  // changes and clears on the agent's terminal status (or goes stale).
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus>>({});
  // Highest status `seq` applied per sender hash, so a status that arrives out of
  // order (e.g. a late 'tool' landing after the turn's terminal 'done') is
  // discarded instead of resurrecting a cleared indicator.
  const statusSeqRef = useRef<Record<string, number>>({});
  // Highest inbound chat server-ts seen per sender hash. An agent's terminal
  // status is ephemeral and never replays, so a missed `done` strands a
  // "working…" bubble; on (re)connect we clear any indicator a newer reply from
  // the same sender already supersedes. In-memory; reset on room switch.
  const lastInboundMsgTsRef = useRef<Record<string, number>>({});
  // Bumped on resume (visibilitychange → visible) to force the SSE effect to
  // tear down and rebuild a fresh connection — a backgrounded socket often dies
  // silently without firing `error`, so `onopen` (and its catch-up) never
  // re-fires until restart. See the resume effect below.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showDisband, setShowDisband] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  // Agent-room collector: replies the operator has queued but not yet sent.
  // Dispatched together as one message so the agent acts on them in context.
  const [replyQueue, setReplyQueue] = useState<ReplyEntry[]>([]);
  const [showCollector, setShowCollector] = useState(false);
  const [headerCondensed, setHeaderCondensed] = useState(false);
  const [roomNickname, setRoomNickname] = useState<string>(() => initialContext?.roomNickname ?? '');
  const [roomColor, setRoomColor] = useState<string>(() => initialContext?.roomColor ?? '#ccc');
  // What kind of room this is. Drives chrome: a 'control' room is a tap-only
  // command surface — no free-text message affordances. Seeded from storage,
  // then sharpened when a daemon message envelope carries `room_kind`.
  const [roomKind, setRoomKindState] = useState<RoomKind>('chat');
  const isControlRoom = roomKind === 'control';
  // Agent rooms get the batch-reply collector: replies queue and dispatch as
  // one message. Gated here so normal (chat) and control rooms never see it.
  const isAgentRoom = roomKind === 'agent';
  // Daemon-reported running-agent count. null = unknown (no daemon envelope
  // with this field has arrived yet). The command-bar badge hides while
  // null rather than render a misleading zero. Hydrated by every incoming
  // control-room message (spawn/kill/welcome/list/etc all stamp it), so it
  // stays accurate without any local guessing.
  const [agentCount, setAgentCount] = useState<number | null>(null);
  // Optional daemon-stamped working context (git branch / cwd) for agent and
  // control rooms. null = none stamped yet (peer chat, pre-update daemon, or
  // fresh reload before the next envelope) — the header context line then
  // renders nothing. Like agentCount, this is ephemeral room chrome derived
  // from the latest envelope, not persisted per message.
  const [roomContext, setRoomContext] = useState<RoomContext | null>(null);
  const [allRooms, setAllRooms] = useState<StoredRoom[]>([]);
  const keyboardVisible = useKeyboardViewport(showComposer);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [knockKey, setKnockKey] = useState<CryptoKey | null>(null);
  const [token, setTokenState] = useState<string | null>(() => initialContext?.token ?? null);
  const [tokenHash, setTokenHash] = useState<string | null>(null);
  // Subscriber JWT for Mercure subscription. Long-lived (7 days per server
  // policy) once we're a PARTICIPANT; short-lived (10 minutes) when we're a
  // knocker waiting for our wrapped token. Whichever is active is what the
  // SSE effect uses for Authorization.
  const [subJwt, setSubJwt] = useState<string | null>(() => initialContext?.subJwt ?? null);
  const [lobbyJwt, setLobbyJwt] = useState<string | null>(null);
  const [handle, setHandleState] = useState<string>(() => initialContext?.handle ?? '');
  const [connection, setConnection] = useState<'idle' | 'connected' | 'error'>('idle');
  // OPT-IN, off-by-default "live / quiet" presence. Reflects ONLY this device's
  // own connection to the room (the `connection` state above) — never anyone
  // else's presence and never a read receipt. The opt-in flag is local-only and
  // never leaves the device; see lib/presence.ts for the full privacy contract.
  const presence = useRoomPresence(roomHash, connection);
  // OPT-IN, off-by-default auto-approve. When on, a knock that decrypts cleanly
  // (proving the knocker holds link + password) is approved without a tap. The
  // flag is local-only and never leaves the device; see lib/auto-approve.ts for
  // the full privacy contract. Read inside the knock SSE handler via a ref so a
  // toggle takes effect without re-subscribing the event source.
  const autoApprove = useRoomAutoApprove(roomHash);
  const autoApproveRef = useRef(autoApprove.enabled);
  useEffect(() => {
    autoApproveRef.current = autoApprove.enabled;
  }, [autoApprove.enabled]);
  // Knock ids the auto-approve path has already handled, so an SSE replay of the
  // same knock (e.g. after a reconnect) can't fire a second approve handshake.
  const handledAutoKnockIdsRef = useRef<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasCompanion, setHasCompanion] = useState(false);
  const [emptyQrSrc, setEmptyQrSrc] = useState<string>('');
  const [catchUpEnabled, setCatchUpEnabled] = useState(false);
  const [catchUpBusy, setCatchUpBusy] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus>('off');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState('');
  const [expectedKnockMessage, setExpectedKnockMessageState] = useState('');
  const [roomSetupDismissed, setRoomSetupDismissedState] = useState(false);
  const [roomCreatedByMe, setRoomCreatedByMeState] = useState(() =>
    initialContext ? getRoomCreatedByMe(initialContext.roomHash) : false
  );
  const [roomSetupStage, setRoomSetupStage] = useState<RoomSetupStage>('security');
  const [menuFocusTarget, setMenuFocusTarget] = useState<'password' | 'knock' | null>(null);
  // Reveal-on-tap for the pairing code in the room menu. Auto-hides after a few
  // seconds and on backgrounding so a phone left open on the menu doesn't sit
  // there broadcasting the code to anyone walking by. The code itself never
  // leaves the device — it's pulled from roomPassword (already in state from
  // localStorage); this just gates display.
  const [pairingCodeRevealed, setPairingCodeRevealed] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusProxyRef = useRef<HTMLTextAreaElement | null>(null);
  const roomPasswordInputRef = useRef<HTMLInputElement | null>(null);
  const expectedKnockInputRef = useRef<HTMLInputElement | null>(null);
  // Set true on pointerdown of Cancel/Done in our custom toolbar so the
  // textarea's blur handler knows the dismissal was intentional — it then
  // skips the iOS Done = send branch. Cleared on the next blur.
  const suppressSendOnBlurRef = useRef(false);
  // Guards against double-submit: a blur (iOS native keyboard "Done") and a tap
  // on the Send button can both fire before the first send's network round-trip
  // resolves and clears the draft, minting two msgIds for one message. Held for
  // the duration of an in-flight send so concurrent triggers no-op.
  const sendInFlightRef = useRef(false);
  // Live mirror of tokenHash so ingestEncryptedChat reads the CURRENT identity
  // rather than whatever was captured when its SSE effect instance was created.
  // tokenHash hydrates asynchronously; on a flaky connection the subscription
  // effect can be (re)created while tokenHash is still null, and that effect's
  // closure — including the outbox catch-up loop on reconnect — would otherwise
  // compute every own message as direction:'in' and persist it. A ref dodges
  // the stale-closure capture entirely. See the 4G→WiFi authorship-flip bug.
  const tokenHashRef = useRef<string | null>(null);
  const prevCountRef = useRef(0);
  // Room entry / switch owes an unconditional jump to the newest message (#211).
  // Entry scroll was erratic because it relied on a single geometry measure
  // taken right after the first paint: SSE catch-up messages trickle in one by
  // one AFTER that, and late-laying-out content (message blocks, images) grows
  // the document below the fold — both leave the measure reading "not at bottom"
  // so the room opened parked in history with an unread pill instead of at the
  // foot. While this is set we follow the tail unconditionally and re-pin as the
  // document grows; it's released on the first deliberate user scroll-up or once
  // the room has settled.
  const initialScrollPendingRef = useRef(false);
  // Last observed window.scrollY, so handleScroll can tell a deliberate user
  // scroll-up (scrollY decreases) from content growth knocking us off the foot
  // (scrollY unchanged, scrollHeight increases) — only the former releases the
  // entry pin.
  const lastScrollYRef = useRef(0);
  // True once a *real* user gesture (wheel / touchmove) has happened since this
  // room entry. Only a real gesture should hand scroll control to the user and
  // release the entry pin: an installed PWA's WKWebView can fire an involuntary
  // scroll-to-top on a hash switch (browser scroll restoration), and without
  // this guard handleScroll would read that as a deliberate scroll-up and
  // permanently disarm the pin, stranding the room on its oldest message (#224).
  // Reset to false on every room entry (the entry-scroll effect / navigateToRoom).
  const userScrolledRef = useRef(false);
  // Holds the last non-zero unread tally so the always-mounted pill can keep
  // its label while it fades out (count resets to 0 the instant you hit bottom).
  const lastUnreadRef = useRef(0);
  const knockKeyRef = useRef<CryptoKey | null>(null);
  // Ephemeral keypair used to receive the wrapped participant token after a
  // knock. Set right before /knock fires; consulted when the matching `token`
  // event arrives. Cleared once we upgrade to PARTICIPANT. `publicKey` + `body`
  // are the exact wire values of the sent knock, retained so the retry effect
  // can re-POST the IDENTICAL knock (same msg_id) if the live-only token reply
  // was missed before our lobby SSE opened.
  const knockEphemeralRef = useRef<{ privateKey: CryptoKey; msgId: string; publicKey: string; body: string } | null>(null);
  // Claim tag derived alongside the unwrap. Sent as X-Chat-Claim-Tag on the
  // first /presence to prove this client is the same one that knocked — a
  // sniffer who somehow got the plaintext token cannot forge the tag without
  // the ephemeral private key. Cleared on first successful /presence; never
  // persisted (one-shot, in-memory only).
  const claimTagRef = useRef<string | null>(null);
  // Whether the init effect is running for the first time. We use this to skip
  // the destructive reset block when an optimistic context was loaded — the
  // initial useState values already reflect the room we're entering, so wiping
  // them and re-deriving asynchronously causes a visible PARTICIPANT-→INIT-→
  // PARTICIPANT flip. On any subsequent run (roomSecret changed in-place via
  // hashchange) the reset is correct.
  const isFirstInitRunRef = useRef(true);

  const shareUrl = useMemo(() => `${window.location.origin}/room#${roomSecret}`, [roomSecret]);
  const userMessageCount = messages.filter((msg) => msg.type !== 'system').length;
  const showEmptyState = userMessageCount === 0 && !hasCompanion && roomState === 'PARTICIPANT';
  const showRoomSetupNudge =
    showEmptyState &&
    roomKind === 'chat' &&
    roomCreatedByMe &&
    !roomSetupDismissed;

  useEffect(() => {
    const handleHashChange = () => {
      setRoomSecret(readRoomSecretFromHash());
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigateToRoom = useCallback((nextRoomSecret: string) => {
    const nextSecret = nextRoomSecret.replace(/^#\/?/, '');
    if (!nextSecret) return;
    // Hash-only in-app switches keep the current document/scroll state alive.
    // Arm the entry pin synchronously (before the new room's cached messages
    // hydrate) and reset the message-count heuristic so switcher/rail selection
    // behaves like entering from /rooms: land on the newest message, not the
    // previous room's scroll/window position.
    initialScrollPendingRef.current = true;
    // Fresh entry: no user gesture has happened in the destination room yet, so
    // a WKWebView scroll-restoration jump right after the hash change can't be
    // mistaken for the user scrolling up and disarming the pin (#224).
    userScrolledRef.current = false;
    prevCountRef.current = 0;
    if (window.location.hash.replace(/^#\/?/, '') !== nextSecret) {
      window.location.hash = `#${nextSecret}`;
    }
    setRoomSecret(nextSecret);
  }, []);

  const joinActionRoom = useCallback(async (action: MessageAction) => {
    const nextSecret = action.roomSecret.replace(/^#\/?/, '');
    if (!nextSecret) return;

    const nextHash = await deriveRoomHash(nextSecret);
    // Stamp the kind the daemon declared on the action (agent rooms carry
    // 'agent'); upsertRoom only ever sharpens away from the 'chat' default.
    // Record the agent's parent control room so the channels list can group it
    // under the daemon that controls it. Prefer the hash the daemon stamps on
    // the action (authoritative, works no matter where Join was tapped); fall
    // back — for daemons predating that field — to inferring it from the
    // current room when we're joining an agent from inside its control room.
    const parentControlHash =
      action.room_kind === 'agent'
        ? action.controlRoomHash ?? (roomKind === 'control' ? roomHash : undefined)
        : undefined;
    upsertRoom(nextHash, nextSecret, null, action.room_kind, parentControlHash);

    // Daemon-supplied name applies only when no nickname is set — mirrors the
    // control-room hostname stamp. So a `join:` rebroadcast (operator taps the
    // re-shown agent row) doesn't clobber a user rename of the agent room.
    const roomName = action.roomName?.trim();
    if (roomName && !getRoomNickname(nextHash)) {
      updateRoomNickname(nextHash, roomName);
    }

    if (action.code) {
      setRoomPassword(nextHash, action.code);
    }

    // Agent rooms use the daemon's session knock message as their join note. If
    // this device already entered the parent control room, carry that last
    // successful knock note forward deterministically instead of relying on
    // whatever transient textarea state survived the hash switch.
    if (action.room_kind === 'agent') {
      const parentKnock = parentControlHash ? getLastKnockMessage(parentControlHash) : null;
      if (parentKnock) {
        setLastKnockMessage(nextHash, parentKnock);
      }
    }

    navigateToRoom(nextSecret);
  }, [navigateToRoom, roomHash, roomKind]);

  useEffect(() => {
    if (!showEmptyState || !shareUrl) {
      return;
    }
    let active = true;
    QRCode.toDataURL(shareUrl, { width: 240, margin: 1 }).then((url: string) => {
      if (active) setEmptyQrSrc(url);
    });
    return () => { active = false; };
  }, [showEmptyState, shareUrl]);

  const visibleMessages = useMemo(() => [...messages].sort((a, b) => b.timestamp - a.timestamp), [messages]);
  const activeMessage = useMemo(() => messages.find((entry) => entry.id === selectedId) ?? null, [messages, selectedId]);
  // Latest progress-block snapshot keyed by progress id. When an agent emits
  // multiple messages updating the same progress (same id), every render — even
  // re-opening an older message — shows the most recent state.
  const progressOverrides = useMemo(() => {
    const map: Record<string, import('../lib/blocks').ProgressBlock> = {};
    const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
    for (const m of sorted) {
      if (!m.blocks) continue;
      for (const b of m.blocks) {
        if (b && b.type === 'progress' && typeof b.id === 'string' && b.id) {
          map[b.id] = b;
        }
      }
    }
    return map;
  }, [messages]);
  const replyTarget = useMemo(() => messages.find((entry) => entry.id === replyToId) ?? null, [messages, replyToId]);

  const {
    renderedItems: renderedMessages,
    hasOlder,
    hasNewer,
    topSentinelRef,
    bottomSentinelRef,
    jumpToLatest: jumpWindowToLatest,
  } = useMessageWindow(visibleMessages, listRef);

  const wipeLocalRoom = useCallback(async (hash: string) => {
    await wipeLocalRoomArtifacts(hash, { unregisterPush: true });
    setTokenState(null);
    setTokenHash(null);
    setSubJwt(null);
    setLobbyJwt(null);
    setKnocks([]);
    setMessages([]);
    setAgentStatuses({});
    statusSeqRef.current = {};
    lastInboundMsgTsRef.current = {};
    setMessage('');
    setChatInput('');
    setShowComposer(false);
    setReplyToId(null);
    setSelectedId(null);
    setRoomPasswordState('');
    setExpectedKnockMessageState('');
    setRoomSetupDismissedState(false);
    setRoomCreatedByMeState(false);
    setRoomSetupStage('security');
    setMenuFocusTarget(null);
    setCryptoKey(null);
    setKnockKey(null);
  }, []);

  const updateRoomPassword = useCallback(
    (nextPassword: string) => {
      setRoomPasswordState(nextPassword);
      if (roomHash) {
        setRoomPassword(roomHash, nextPassword);
      }
    },
    [roomHash]
  );

  const updateExpectedKnockMessage = useCallback(
    (nextMessage: string) => {
      setExpectedKnockMessageState(nextMessage);
      if (roomHash) {
        setExpectedKnockMessage(roomHash, nextMessage);
      }
    },
    [roomHash]
  );

  // Keep the identity mirror in lockstep with the state. Runs after every
  // tokenHash change so any later network event reads the hydrated value.
  useEffect(() => {
    tokenHashRef.current = tokenHash;
  }, [tokenHash]);

  const persistMessage = useCallback(async (record: ChatMessage): Promise<void> => {
    try {
      await saveMessage(record);
    } catch (err) {
      // A swallowed write means the message is only in memory and vanishes on
      // the next reload/reconcile. Surface it instead of dropping it silently.
      console.error('Failed to persist message', record.id, err);
    }
  }, []);

  const ingestEncryptedChat = useCallback(async (
    msgId: string,
    ts: number,
    from: string | null,
    rawPayload: unknown
  ) => {
    if (!cryptoKey || !roomHash || !msgId || !rawPayload) return;
    let plaintext: string;
    try {
      const parsed: EncryptedPayload =
        typeof rawPayload === 'string' ? (JSON.parse(rawPayload) as EncryptedPayload) : (rawPayload as EncryptedPayload);
      plaintext = await decryptText(cryptoKey, roomHash, 'chat', msgId, parsed);
    } catch (err) {
      // A decrypt/parse failure used to bubble to handleEvent's catch and get
      // dropped with no trace — the message simply never appeared. Log it so a
      // lost inbound message is diagnosable instead of silent.
      console.error('Failed to decrypt inbound message', msgId, err);
      return;
    }
    // Learn the room's kind from the daemon's envelope stamp. The control room
    // is QR-paired (no join-room action), so this is how the phone discovers it
    // is a command surface. setRoomKind only sharpens away from 'chat'.
    const envelope = parseRoomEnvelope(plaintext);
    const envKind = envelope.room_kind;
    if (envKind && envKind !== 'chat') {
      setRoomKind(roomHash, envKind);
      setRoomKindState((prev) => (prev === envKind ? prev : envKind));
    }
    // Pick up the daemon-reported agent count off any control-room envelope.
    // Gated on room_kind === 'control' so a peer chat message that happens
    // to carry an `agent_count` field can't pollute the badge. Updates the
    // command-bar in real time as spawn/kill events flow through.
    if (envKind === 'control' && typeof envelope.agent_count === 'number') {
      setAgentCount(envelope.agent_count);
    }
    // Pick up the optional working-context stamp (git branch / cwd) off any
    // agent- or control-room envelope. Gated on the envelope's own room_kind so
    // a peer chat message that happens to carry a `context` field can't surface
    // a header context line in a normal conversation. Absent → leaves the
    // previous value untouched (it degrades to nothing on first load).
    // TODO(server): daemon should populate `context` on its agent/control-room
    // replies so this line can render; until then envelope.context is null and
    // the header context line simply does not appear.
    if ((envKind === 'agent' || envKind === 'control') && envelope.context) {
      setRoomContext(envelope.context);
    }
    // Auto-name the control room from the daemon's hostname stamp, but ONLY
    // if no nickname is set yet — the user's kebab → Rename always wins,
    // and once renamed every subsequent stamp is ignored. `getRoomNickname`
    // reads localStorage, so this also no-ops after the first set per room.
    if (envKind === 'control' && envelope.room_name && !getRoomNickname(roomHash)) {
      updateRoomNickname(roomHash, envelope.room_name);
      setRoomNickname(envelope.room_name);
    }
    const messageRecord = toChatMessageRecord({
      msgId,
      roomHash,
      timestamp: ts,
      from,
      plaintext,
      ownTokenHash: tokenHashRef.current,
    });
    // Record the newest inbound (peer/agent) message ts per sender so a resume
    // reconcile (see the SSE onopen handler) can clear a stale "working…"
    // indicator that this reply already superseded.
    if (from && messageRecord.direction === 'in' && ts > (lastInboundMsgTsRef.current[from] ?? 0)) {
      lastInboundMsgTsRef.current[from] = ts;
    }
    // Live reconcile of the work indicator (#210). The daemon's terminal
    // `done`/`failed` status is ephemeral and fire-and-forget (see
    // agent-manager onStatus): if it's dropped, nothing on a live connection
    // clears the "working…" bubble and it strands above the reply that already
    // landed — only a reconnect used to reconcile it (the SSE onopen handler).
    // So apply that same reconcile on every inbound message: if this message is
    // at/after the sender's active status, the turn produced its reply, so drop
    // the indicator. A still-working agent keeps emitting status with a NEWER ts
    // (the reply is always sent after the last status), so an intermediate
    // daemon chat that clears the bubble early is immediately restored by the
    // next status; only the genuine final reply — with no status after it —
    // stays cleared.
    if (from && messageRecord.direction === 'in') {
      setAgentStatuses((prev) => {
        const st = prev[from];
        if (!st || ts < st.ts) return prev;
        const next = { ...prev };
        delete next[from];
        return next;
      });
    }
    setMessages((prev) => {
      const existing = prev.find((item) => item.id === msgId);
      if (existing) {
        // This is the echo of a message we already hold — often our own
        // optimistic send, which was stamped with the client's local Date.now().
        // The echo might arrive before ownTokenHash is hydrated; in that case
        // messageRecord.direction is wrong. Preserve the existing authorship and
        // only re-stamp onto the server clock so command/reply causal ordering is
        // stable after reload too.
        const merged = mergeChatMessageEcho(existing, messageRecord);
        if (merged === existing) return prev;
        void persistMessage(merged);
        return prev
          .map((item) => (item.id === msgId ? merged : item))
          .sort((a, b) => a.timestamp - b.timestamp);
      }
      if (messageRecord.direction === 'in') setHasCompanion(true);
      void persistMessage(messageRecord);
      return [...prev, messageRecord].sort((a, b) => a.timestamp - b.timestamp);
    });
  }, [cryptoKey, roomHash, persistMessage]);

  // The terminal 'done'/'failed' status clears an agent's indicator; this is the
  // backstop for when the daemon dies mid-turn and never sends one. Drop any status not refreshed
  // within the window so a "working…" bubble can't hang around forever.
  // Depend on the boolean "are there any statuses", not the map itself, so the
  // interval is created once when the first status arrives and torn down when the
  // last clears — not rebuilt on every status update. The functional setState
  // inside always sees the latest map, so the closure needs no fresher value.
  const hasAgentStatuses = Object.keys(agentStatuses).length > 0;
  useEffect(() => {
    if (!hasAgentStatuses) return;
    const STALE_MS = 30_000;
    const timer = setInterval(() => {
      const cutoff = Date.now() - STALE_MS;
      setAgentStatuses((prev) => {
        let changed = false;
        const next: Record<string, AgentStatus> = {};
        for (const [key, value] of Object.entries(prev)) {
          if (value.at >= cutoff) next[key] = value;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 5_000);
    return () => clearInterval(timer);
  }, [hasAgentStatuses]);

  useEffect(() => {
    let active = true;
    if (!roomSecret) {
      setKnockKey(null);
      return () => {
        active = false;
      };
    }

    void deriveKnockKey(roomSecret, roomPassword)
      .then((key) => {
        if (!active) {
          return;
        }
        setKnockKey(key);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setKnockKey(null);
      });

    return () => {
      active = false;
    };
  }, [roomSecret, roomPassword]);

  useEffect(() => {
    let active = true;
    if (!roomSecret) {
      setCryptoKey(null);
      return () => {
        active = false;
      };
    }

    void deriveMessageKey(roomSecret, roomPassword)
      .then((key) => {
        if (!active) {
          return;
        }
        setCryptoKey(key);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setCryptoKey(null);
      });

    return () => {
      active = false;
    };
  }, [roomSecret, roomPassword]);

  useEffect(() => {
    knockKeyRef.current = knockKey;
  }, [knockKey]);

  // Auto-hide the revealed pairing code: 30s timer + immediate hide when the
  // menu closes or the tab is backgrounded. The intent is "a glance, then
  // gone" — long enough to read four digits aloud, short enough that a phone
  // accidentally left on the menu screen doesn't keep displaying them.
  useEffect(() => {
    if (!pairingCodeRevealed) return;
    if (!showMenu) {
      setPairingCodeRevealed(false);
      return;
    }
    const timer = window.setTimeout(() => setPairingCodeRevealed(false), 30_000);
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') setPairingCodeRevealed(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pairingCodeRevealed, showMenu]);

  useEffect(() => {
    if (!showComposer) {
      return;
    }

    // Transfer focus from the proxy to the real textarea (the proxy already
    // holds Safari's user-gesture focus grant from openComposer). The
    // textarea's value is React-controlled via `value={chatInput}` — no
    // imperative seeding needed.
    requestAnimationFrame(() => {
      const el = composerInputRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, [showComposer]);

  useEffect(() => {
    let active = true;
    // Abort in-flight room fetches when the user switches rooms mid-load.
    // Without this, stale POST /presence and POST /sub-token requests for the
    // PREVIOUS room continue executing on the server while the new init also
    // hits chat.sqlite — under contention SQLite returns BUSY past the
    // 5s busy_timeout and the request 500s.
    const controller = new AbortController();
    const { signal } = controller;

    const init = async () => {
      try {
        const firstRun = isFirstInitRunRef.current;
        isFirstInitRunRef.current = false;
        const skipReset = firstRun && initialContext !== null && initialContext.roomSecret === roomSecret;

        if (!skipReset) {
          setRoomHash('');
          setRoomState('INIT');
          setError('');
          setKnockSent(false);
          setKnockNotice('');
          setMessage('');
          setKnocks([]);
          setMessages([]);
          setAgentStatuses({});
          // Clear ephemeral, daemon-stamped room chrome so the PREVIOUS room's
          // working context (git branch / cwd) and agent count don't bleed into
          // the next room until its own envelope re-stamps them.
          setRoomContext(null);
          setAgentCount(null);
          statusSeqRef.current = {};
          lastInboundMsgTsRef.current = {};
          setSelectedId(null);
          setShowQr(false);
          setShowDisband(false);
          setShowMenu(false);
          setShowHelp(false);
          setShowQueue(false);
          setShowComposer(false);
          setShowSwitcher(false);
          setReplyToId(null);
          setCryptoKey(null);
          setKnockKey(null);
          setTokenState(null);
          setTokenHash(null);
          setSubJwt(null);
          setLobbyJwt(null);
          setConnection('idle');
          setUnreadCount(0);
          prevCountRef.current = 0;
          initialScrollPendingRef.current = true;
          setHasCompanion(false);
          setEmptyQrSrc('');
          setCatchUpEnabled(false);
          setRoomPasswordState('');
          setExpectedKnockMessageState('');
          setRoomSetupDismissedState(false);
          setRoomCreatedByMeState(false);
          setRoomSetupStage('security');
          setMenuFocusTarget(null);
          knockEphemeralRef.current = null;
          claimTagRef.current = null;
        }

        const hash = skipReset ? initialContext!.roomHash : await deriveRoomHash(roomSecret);
        if (!active) return;
        setRoomHash(hash);
        const localMessages = await loadMessages(hash);
        if (!active) return;
        // Merge persisted history with any in-memory messages for this room
        // that arrived live but haven't been read back from IndexedDB yet.
        // A blind replace here wiped a just-rendered message whose async
        // persist hadn't landed — it appeared, then vanished on this reload.
        // Other rooms' messages are dropped (room switch) since loadMessages
        // is scoped to `hash`.
        setMessages((prev) => {
          const byId = new Map<string, ChatMessage>();
          for (const m of localMessages) byId.set(m.id, m);
          for (const m of prev) {
            if (m.room_hash === hash && !byId.has(m.id)) byId.set(m.id, m);
          }
          return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
        });
        const savedHandle = getHandle(hash);
        const savedRoomPassword = getRoomPassword(hash);
        setHandleState(savedHandle ?? '');
        setRoomPasswordState(savedRoomPassword ?? '');
        setMessage(getLastKnockMessage(hash) ?? '');
        setExpectedKnockMessageState(getExpectedKnockMessage(hash) ?? '');
        setRoomSetupDismissedState(getRoomSetupDismissed(hash));
        setRoomCreatedByMeState(getRoomCreatedByMe(hash));
        setRoomSetupStage('security');
        setRoomColor(getRoomColor(hash));
        setRoomNickname(getRoomNickname(hash) ?? '');
        setRoomKindState(getRoomKind(hash));

        const existingToken = getToken(hash);
        if (existingToken) {
          const presenceResponse = await postPresence(hash, existingToken, { signal });
          if (!active) return;

          if (presenceResponse.status === 404) {
            await wipeLocalRoom(hash);
            if (!active) return;
            setRoomState('DESTROYED');
            return;
          }

          if (presenceResponse.ok) {
            upsertRoom(hash, roomSecret, savedHandle ?? null);
            setTokenState(existingToken);
            setTokenHash(await sha256Hex(existingToken));
            // Refresh the subscriber JWT every load so an expired or missing
            // local copy never blocks Mercure subscription. Cheap; the server
            // mints a fresh one without minting a new participant.
            try {
              const subRes = await refreshSubscriberToken(hash, existingToken, { signal });
              if (!active) return;
              if (subRes.ok) {
                const subData = (await subRes.json()) as { subscriber_jwt?: string };
                if (!active) return;
                if (subData.subscriber_jwt) {
                  setSubscriberJwt(hash, subData.subscriber_jwt);
                  setSubJwt(subData.subscriber_jwt);
                }
              } else {
                const cached = getSubscriberJwt(hash);
                if (cached) setSubJwt(cached);
              }
            } catch {
              const cached = getSubscriberJwt(hash);
              if (cached) setSubJwt(cached);
            }
            setRoomState('PARTICIPANT');
            return;
          }

          if (presenceResponse.status === 401 || presenceResponse.status === 403) {
            clearToken(hash);
            clearSubscriberJwt(hash);
            setTokenState(null);
            setTokenHash(null);
            setSubJwt(null);
          } else {
            throw new Error(`Server responded ${presenceResponse.status}`);
          }
        }

        const response = await fetchRoomStatus(hash, { signal });
        if (!active) return;

        if (response.status === 404) {
          await wipeLocalRoom(hash);
          if (!active) return;
          setRoomState('DESTROYED');
          return;
        }

        if (!response.ok) {
          throw new Error(`Server responded ${response.status}`);
        }

        const data = (await response.json()) as RoomLookupResponse;
        if (!active) return;
        upsertRoom(hash, roomSecret, savedHandle ?? null);

        if (data.has_participants) {
          setRoomState('LOBBY_WAITING');
        } else {
          setRoomState('LOBBY_EMPTY');
        }
      } catch (err) {
        if (!active) return;
        // AbortError fires when the user switched rooms mid-init — that's the
        // happy path of the abort, not a user-visible failure.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'unable to load room');
      }
    };

    if (roomSecret) {
      void init();
    }

    return () => {
      active = false;
      controller.abort();
    };
  }, [roomSecret, wipeLocalRoom, initialContext]);

  // Scroll lock while any modal is open. The channel screen itself now uses
  // document scroll, so we cannot lock with body { overflow: hidden } the
  // way the inner-scroll era did — in modern browsers the document scroll
  // comes from <html>, not <body>, so a body lock is a silent no-op (which
  // is why wheel/touch were passing through modal overlays to the page
  // underneath). Toggling overflow:hidden on documentElement actually
  // locks the viewport scroll for both wheel and touch input.
  const anyModalOpen =
    showComposer ||
    showMenu ||
    showHelp ||
    showQueue ||
    showSwitcher ||
    showDisband ||
    showLeave ||
    showQr ||
    selectedId !== null;

  useEffect(() => {
    if (!anyModalOpen) return undefined;
    document.documentElement.classList.add('scroll-locked');
    return () => {
      document.documentElement.classList.remove('scroll-locked');
    };
  }, [anyModalOpen]);

  useEffect(() => {
    if (!roomHash) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchRoomStatus(roomHash);
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as RoomLookupResponse;
        if (!cancelled) setCatchUpEnabled(!!data.catch_up_enabled);
      } catch {
        // non-fatal; toggle stays at last known state
      }
    })();
    return () => { cancelled = true; };
  }, [roomHash]);

  useEffect(() => {
    if (!roomHash || roomState === 'DESTROYED') {
      return;
    }
    // Mercure rejects anonymous subscribers. Pick whichever JWT applies to the
    // current state: short-lived lobby JWT while waiting for token unwrap,
    // long-lived subscriber JWT once we're a participant. The topic scope
    // must match the JWT — lobby JWTs ONLY authorize room:<hash>:lobby, where
    // token-wrap and reject events are published; member JWTs authorize the
    // chat-traffic topic room:<hash>. Without a JWT we can't subscribe at
    // all — bail and let the effect re-run when one becomes available.
    const isParticipant = roomState === 'PARTICIPANT';
    const activeJwt = isParticipant ? subJwt : lobbyJwt;
    if (!activeJwt) {
      setConnection('idle');
      return;
    }

    const source = createRoomEventSource(roomHash, activeJwt, isParticipant ? 'members' : 'lobby');
    setConnection('idle');

    const handleEvent = async (event: MessageEvent) => {
      try {
        const payload = parseRoomEvent(event.data, roomHash);
        if (!payload) {
          return;
        }

        if (payload.type === 'knock' && roomState === 'PARTICIPANT') {
          const activeKnockKey = knockKeyRef.current;
          if (!activeKnockKey) {
            return;
          }
          const rawPayload = payload.body?.encrypted_payload;
          const msgId = (payload.body?.msg_id as string | null) ?? '';
          const knockPubkey = (payload.body?.knock_pubkey as string | null) ?? '';
          if (!rawPayload || !msgId || !knockPubkey) {
            return;
          }
          const parsed: EncryptedPayload =
            typeof rawPayload === 'string' ? (JSON.parse(rawPayload) as EncryptedPayload) : (rawPayload as EncryptedPayload);
          // A SUCCESSFUL decrypt here already proves the knocker holds BOTH the
          // room link and password (the knock is sealed under knockKey =
          // deriveKnockKey(roomSecret, roomPassword)). That cryptographic proof
          // is exactly what auto-approve gates on — never a weaker check.
          const plaintext = await decryptText(activeKnockKey, roomHash, 'knock', msgId, parsed);
          const knockMessage = plaintext.trim();
          if (!knockMessage) {
            return;
          }
          const knockId = `${payload.ts}-${msgId}`;

          // OPT-IN auto-approve: the joiner has proven link+password possession
          // above, so run the same approve handshake the manual button runs and
          // skip the queue entirely. Off by default; falls through to manual
          // enqueue when not opted in or if the handshake doesn't complete.
          if (autoApproveRef.current) {
            // Dedup against SSE replay: mark before awaiting so a redelivered
            // knock can't fire a second handshake; un-mark on failure so a real
            // retry can still flow through the manual queue below.
            if (handledAutoKnockIdsRef.current.has(knockId)) {
              return;
            }
            handledAutoKnockIdsRef.current.add(knockId);
            const approved = await runApproveRef.current({ msgId, pubkey: knockPubkey });
            if (approved) {
              return;
            }
            handledAutoKnockIdsRef.current.delete(knockId);
            // Auto-approve failed mid-handshake — fall through to enqueue so the
            // request is still visible for a manual retry rather than dropped.
          }

          setKnocks((prev) => {
            // Dedup by msg_id, not the ts-stamped knockId: a knocker whose
            // live-only token reply was missed re-sends the IDENTICAL knock
            // (same msg_id, fresh server ts) every ~1.2s. Keying on msg_id
            // collapses those retries into the one pending request instead of
            // stacking a new card each time.
            if (prev.find((item) => item.msgId === msgId)) {
              return prev;
            }
            const next = [
              { id: knockId, msgId, pubkey: knockPubkey, ts: payload.ts, message: knockMessage },
              ...prev
            ];
            // Persist a content-free pending-knock count so the /rooms card can
            // show a "someone is waiting" hint after navigating away. Only the
            // count is stored — never the note, pubkey, or any identity.
            setPendingKnockCount(roomHash, next.length);
            return next;
          });
        }

        if (payload.type === 'token') {
          // Knocker side: match the wrapped delivery to our outstanding knock,
          // unwrap with our ephemeral private key, become participant. Other
          // subscribers see the same event but cannot derive the shared secret.
          const pending = knockEphemeralRef.current;
          if (!pending || token) return;
          const knockMsgId = payload.body?.knock_msg_id;
          if (knockMsgId !== pending.msgId) return;
          const approverPubkey = payload.body?.approver_pubkey;
          const nonce = payload.body?.nonce;
          const ct = payload.body?.ct;
          if (typeof approverPubkey !== 'string' || typeof nonce !== 'string' || typeof ct !== 'string') {
            return;
          }
          try {
            const { plaintext, claimTag } = await unwrapAndDeriveClaim(
              pending.privateKey,
              approverPubkey,
              nonce,
              ct,
              pending.msgId
            );
            const bundle = JSON.parse(plaintext) as { token?: string; subscriber_jwt?: string };
            if (!bundle.token || !bundle.subscriber_jwt) return;
            knockEphemeralRef.current = null;
            // Stash the claim tag so the next /presence can prove this is the
            // session that decrypted the wrap. Cleared inside the presence ping
            // once the server confirms 200.
            claimTagRef.current = claimTag;
            setToken(roomHash, bundle.token);
            setTokenState(bundle.token);
            setTokenHash(await sha256Hex(bundle.token));
            setSubscriberJwt(roomHash, bundle.subscriber_jwt);
            setSubJwt(bundle.subscriber_jwt);
            setLobbyJwt(null);
            setRoomState('PARTICIPANT');
          } catch {
            // Wrong recipient or stale event — leave pending in place.
          }
        }

        if (payload.type === 'reject' && roomState === 'LOBBY_WAITING') {
          setKnockNotice('request rejected. try again when someone is online.');
        }

        if (payload.type === 'destroy') {
          await wipeLocalRoom(roomHash);
          setRoomState('DESTROYED');
        }

        if (payload.type === 'chat' && cryptoKey) {
          const rawPayload = payload.body?.encrypted_payload;
          const msgId = (payload.body?.msg_id as string | null) ?? '';
          if (!rawPayload || !msgId) {
            return;
          }
          await ingestEncryptedChat(msgId, payload.ts, payload.from ?? null, rawPayload);
        }

        if (payload.type === 'status' && cryptoKey) {
          const rawPayload = payload.body?.encrypted_payload;
          const msgId = (payload.body?.msg_id as string | null) ?? '';
          const from = payload.from ?? null;
          if (!rawPayload || !msgId || !from) return;
          try {
            const parsed: EncryptedPayload =
              typeof rawPayload === 'string' ? (JSON.parse(rawPayload) as EncryptedPayload) : (rawPayload as EncryptedPayload);
            const plaintext = await decryptText(cryptoKey, roomHash, 'chat', msgId, parsed);
            const env = JSON.parse(plaintext) as {
              text?: string;
              handle?: string | null;
              status?: { state?: string; seq?: number };
            };
            const st = env.status;
            if (!st || !st.state) return;
            // Discard out-of-order status: a late 'tool' must not resurrect an
            // indicator the terminal 'done' already cleared. seq is monotonic
            // per sender; ignore anything not newer than the last we applied.
            if (typeof st.seq === 'number') {
              const lastSeq = statusSeqRef.current[from];
              if (lastSeq !== undefined && st.seq <= lastSeq) return;
              statusSeqRef.current[from] = st.seq;
            }
            // 'done'/'failed' is the explicit clear at turn end.
            if (st.state === 'done' || st.state === 'failed') {
              setAgentStatuses((prev) => {
                if (!prev[from]) return prev;
                const next = { ...prev };
                delete next[from];
                return next;
              });
              return;
            }
            setAgentStatuses((prev) => ({
              ...prev,
              [from]: {
                state: st.state as string,
                text: env.text ?? '',
                handle: env.handle ?? null,
                at: Date.now(),
                ts: payload.ts,
              },
            }));
          } catch (err) {
            console.error('Failed to decrypt status', msgId, err);
          }
        }

        if (payload.type === 'settings') {
          const next = payload.body?.catch_up_enabled;
          if (typeof next === 'boolean') {
            setCatchUpEnabled(next);
          }
        }
      } catch (err) {
        return;
      }
    };

    const eventTypes: RoomEvent['type'][] = ['chat', 'knock', 'approve', 'reject', 'destroy', 'settings', 'token', 'status'];
    eventTypes.forEach((type) => source.addEventListener(type, handleEvent));

    source.onopen = () => {
      setConnection('connected');
      // Pull anything we missed while disconnected. Server returns [] when
      // catch_up_enabled is off, so this is safe to call unconditionally.
      if (token && cryptoKey && roomState === 'PARTICIPANT') {
        void (async () => {
          try {
            const localRows = await loadMessages(roomHash);
            const localMax = localRows.reduce(
              (max, m) => (m.timestamp > max ? m.timestamp : max),
              0
            );
            const r = await fetchOutbox(roomHash, token, localMax);
            if (r.ok) {
              const data = (await r.json()) as { messages: OutboxMessage[] };
              for (const m of data.messages) {
                await ingestEncryptedChat(m.msg_id, m.ts, m.sender_hash, m.encrypted_payload);
              }
            }
          } catch {
            // non-fatal
          }
          // Reconcile stale agent indicators on every (re)connect. A terminal
          // `done`/`failed` status is ephemeral and never replays, so one missed
          // while backgrounded would strand a "working…" bubble above the agent's
          // reply. If the newest inbound message we hold from a sender is at/after
          // its last status, the turn produced its reply and ended — drop the
          // indicator. An actively-working agent keeps emitting status with a
          // newer ts, so its bubble outlives any earlier reply and is preserved.
          setAgentStatuses((prev) => {
            let changed = false;
            const next: Record<string, AgentStatus> = {};
            for (const [sender, st] of Object.entries(prev)) {
              const msgTs = lastInboundMsgTsRef.current[sender];
              if (msgTs !== undefined && msgTs >= st.ts) {
                changed = true;
                continue;
              }
              next[sender] = st;
            }
            return changed ? next : prev;
          });
        })();
      }
    };

    source.onerror = () => {
      setConnection('error');
    };

    return () => {
      eventTypes.forEach((type) => source.removeEventListener(type, handleEvent));
      source.close();
    };
  }, [roomHash, roomState, cryptoKey, token, tokenHash, subJwt, lobbyJwt, wipeLocalRoom, ingestEncryptedChat, reconnectNonce]);

  // Resume reconciler. When the tab/PWA returns to the foreground (opened from a
  // push notification, app-switched back, or restored from bfcache), force the
  // SSE to reconnect. A backgrounded socket frequently dies silently without
  // firing `error`, so the polyfill never re-fires `onopen` and the missed-
  // message catch-up + status reconcile never run until a full restart — the
  // exact "restart fixes it" symptom. Bumping the nonce tears the connection
  // down and rebuilds it, so onopen → catch-up → status reconcile all run.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState === 'visible') {
        setReconnectNonce((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pageshow', onResume);
    };
  }, []);

  useEffect(() => {
    if (roomState !== 'PARTICIPANT' || !token || !roomHash) {
      return;
    }

    let active = true;
    // Abort the in-flight presence ping when the room changes. Clearing the JS
    // interval stops FUTURE ticks but does not cancel a request already on the
    // wire — that stale POST keeps writing to chat.sqlite while the new room's
    // init runs the same write, contending for the SQLite writer lock and
    // surfacing as a 500 to whichever side loses the busy_timeout race.
    const controller = new AbortController();
    const { signal } = controller;

    const ping = async () => {
      if (!active) {
        return;
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Chat-Token': token
      };
      // First /presence for a knocker-minted token carries the claim tag. Room
      // creators' tokens aren't pending so this is harmless either way; the
      // ref is only set in the unwrap path.
      const claimTag = claimTagRef.current;
      if (claimTag) {
        headers['X-Chat-Claim-Tag'] = claimTag;
      }
      let response: Response;
      try {
        response = await fetch(`/api/rooms/${roomHash}/presence`, {
          method: 'POST',
          headers,
          signal
        });
      } catch (err) {
        // Swallow the AbortError from a room switch; surface nothing else
        // either — the next tick (or the new room's effect) will retry.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        return;
      }

      if (!active) {
        return;
      }

      if (response.status === 404) {
        active = false;
        await wipeLocalRoom(roomHash);
        setRoomState('DESTROYED');
        return;
      }

      if (claimTag) {
        if (response.ok) {
          // Claim succeeded — token is now active, the tag is single-use.
          claimTagRef.current = null;
        } else if (response.status === 403) {
          // Either invalid_claim (tag mismatch, server burned the row) or
          // token_unclaimed (shouldn't happen here — we sent the tag). Either
          // way the session is unrecoverable; drop back to LOBBY so the user
          // can re-knock.
          active = false;
          claimTagRef.current = null;
          await wipeLocalRoom(roomHash);
          setRoomState('DESTROYED');
        }
      }
    };

    void ping();
    const interval = window.setInterval(ping, 20000);
    return () => {
      active = false;
      window.clearInterval(interval);
      controller.abort();
    };
  }, [roomState, token, roomHash, wipeLocalRoom]);

  const sendKnock = useCallback(async () => {
    if (!roomHash) {
      return;
    }
    if (!knockKey) {
      setKnockSent(false);
      setKnockNotice('preparing encryption key…');
      return;
    }

    const msgId = base64UrlEncode(randomBytes(12));
    const enteredKnockMessage = message.trim();
    const knockMessage = enteredKnockMessage || 'Knock';
    try {
      const ephemeral = await generateEphemeralKeyPair();
      const body = JSON.stringify(await encryptText(knockKey, roomHash, 'knock', msgId, knockMessage));
      knockEphemeralRef.current = { privateKey: ephemeral.privateKey, msgId, publicKey: ephemeral.publicKey, body };
      const response = await postKnock(roomHash, msgId, body, ephemeral.publicKey);

      if (response.ok) {
        setLastKnockMessage(roomHash, enteredKnockMessage);
        // Capture the lobby JWT so the SSE effect can subscribe to the room
        // topic just long enough to receive the wrapped-token event.
        const knockData = (await response.json()) as { lobby_jwt?: string };
        if (knockData.lobby_jwt) {
          setLobbyJwt(knockData.lobby_jwt);
        }
        setKnockSent(true);
        setKnockNotice('waiting for approval…');
      } else {
        knockEphemeralRef.current = null;
        setKnockSent(false);
        setKnockNotice('unable to send join request.');
      }
    } catch {
      knockEphemeralRef.current = null;
      setKnockSent(false);
      setKnockNotice('unable to send join request.');
    }
  }, [roomHash, message, knockKey]);

  // Re-knock safety net for the live-only join pass. The approver's wrapped
  // token is delivered over a lobby event the server does NOT store or replay
  // (server/index.php /token → publish_lobby_event). If our lobby SSE wasn't
  // open yet when the approver replied — e.g. the daemon auto-approves before
  // this tab finishes rendering + connecting — we miss the pass and would wait
  // forever. While waiting, re-POST the IDENTICAL knock (same ephemeral key +
  // msg_id) a few times: an auto-approver (daemon's same-device fast path, or a
  // PWA auto-approve) re-sends the pass, and a human approver sees the retries
  // collapse into the one pending request (the knock queue dedups by msg_id).
  // Stops the instant we become a participant or leave the lobby.
  useEffect(() => {
    if (roomState !== 'LOBBY_WAITING' || !knockSent || token || !roomHash) {
      return;
    }
    const KNOCK_RETRY_INTERVAL_MS = 1200;
    const KNOCK_RETRY_MAX = 6; // ~7s of coverage past the first knock
    let attempts = 0;
    const timer = window.setInterval(() => {
      const pending = knockEphemeralRef.current;
      if (!pending) {
        return;
      }
      attempts += 1;
      if (attempts > KNOCK_RETRY_MAX) {
        window.clearInterval(timer);
        return;
      }
      void postKnock(roomHash, pending.msgId, pending.body, pending.publicKey).catch(() => {});
    }, KNOCK_RETRY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [roomState, knockSent, token, roomHash]);

  // The approve crypto handshake, factored out so BOTH the manual "approve"
  // button and the opt-in auto-approve branch run the exact same verification:
  // beginApprove (ECDH wrap + claim tag) → /approve → wrap token+JWT →
  // /wrapped-token. Takes only the knock's ephemeral pubkey + msgId (per-pairing
  // values), so it has no dependency on `knocks` state and stays stable enough to
  // call from the SSE handler via a ref. Returns true on a completed handshake.
  const runApprove = useCallback(
    async (knock: { msgId: string; pubkey: string }): Promise<boolean> => {
      if (!roomHash || !token) {
        return false;
      }
      try {
        // beginApprove pre-derives the wrap material AND the claim tag from one
        // ephemeral keypair. We commit sha256(tag) on /approve so the knocker's
        // first /presence can prove it's the same client that decrypted the wrap.
        const binding = await beginApprove(knock.pubkey, knock.msgId);
        const approveRes = await postApprove(roomHash, token, binding.claimTagHash);
        if (!approveRes.ok) return false;
        const approveBody = (await approveRes.json()) as {
          new_participant_token?: string;
          subscriber_jwt?: string;
        };
        const newToken = approveBody.new_participant_token;
        const newSubJwt = approveBody.subscriber_jwt;
        if (!newToken || !newSubJwt) return false;
        // Wrap BOTH the participant token AND the new subscriber JWT into a
        // single JSON blob — the knocker needs the JWT to subscribe to
        // Mercure once they upgrade out of the lobby.
        const bundle = JSON.stringify({ token: newToken, subscriber_jwt: newSubJwt });
        const wrapped = await binding.wrap(bundle);
        await postWrappedToken(roomHash, token, {
          knock_msg_id: knock.msgId,
          approver_pubkey: wrapped.approver_pubkey,
          nonce: wrapped.nonce,
          ct: wrapped.ct
        });
        setHasCompanion(true);
        return true;
      } catch {
        return false;
      }
    },
    [roomHash, token]
  );
  // Live ref so the knock SSE handler can auto-approve without listing runApprove
  // in its effect deps (which would re-subscribe the event source on every token
  // change). The crypto itself still verifies link+password possession per knock.
  const runApproveRef = useRef(runApprove);
  useEffect(() => {
    runApproveRef.current = runApprove;
  }, [runApprove]);

  const approveKnock = useCallback(
    async (knockId: string) => {
      const knock = knocks.find((item) => item.id === knockId);
      if (!knock) {
        return;
      }
      const ok = await runApprove({ msgId: knock.msgId, pubkey: knock.pubkey });
      if (ok) {
        // Drop the handled knock and decrement the local /rooms hint.
        setKnocks((prev) => {
          const next = prev.filter((item) => item.id !== knockId);
          setPendingKnockCount(roomHash, next.length);
          return next;
        });
      }
      // On failure, leave the knock visible so the approver can retry.
    },
    [roomHash, knocks, runApprove]
  );

  const rejectKnock = useCallback(
    async (knockId: string) => {
      if (!roomHash || !token) {
        return;
      }
      await postReject(roomHash, token);
      setKnocks((prev) => {
        const next = prev.filter((item) => item.id !== knockId);
        setPendingKnockCount(roomHash, next.length);
        return next;
      });
    },
    [roomHash, token]
  );

  const addSystemMessage = useCallback(
    async (text: string) => {
      if (!roomHash) {
        return;
      }
      const sysId = `sys-${base64UrlEncode(randomBytes(9))}`;
      const record: ChatMessage = {
        id: sysId,
        room_hash: roomHash,
        timestamp: Date.now(),
        content: text,
        type: 'system',
        direction: 'in'
      };
      void persistMessage(record);
      setMessages((prev) => [...prev, record].sort((a, b) => a.timestamp - b.timestamp));
    },
    [roomHash, persistMessage]
  );

  // The single normal-send path, parameterized by the text to send. The
  // composer calls this with the live draft (`chatInput`). The wire format,
  // encryption, optimistic record, and reply-pointer handling all live here.
  const sendText = useCallback(async (rawText: string) => {
    if (!roomHash || !token || !cryptoKey || !rawText.trim()) {
      return;
    }
    // One send at a time. The draft is only cleared after the await below, so
    // without this a second trigger would read the same draft and send again.
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {

    const trimmed = rawText.trim();
    if (trimmed.startsWith('/iam')) {
      const match = trimmed.match(/^\/iam\s+(.+)/i);
      if (!match || !match[1]) {
        await addSystemMessage('usage: /iam your_handle');
        setChatInput('');
        return;
      }
      const nextHandle = match[1].trim().slice(0, 24);
      if (!nextHandle) {
        await addSystemMessage('handle cannot be empty.');
        setChatInput('');
        return;
      }
      setHandle(roomHash, nextHandle);
      setHandleState(nextHandle);
      updateRoomHandle(roomHash, nextHandle);
      await addSystemMessage(`handle set to ${nextHandle}.`);
      setChatInput('');
      setShowComposer(false);
      setReplyToId(null);
      return;
    }

    upsertRoom(roomHash, roomSecret, handle || null);
    const msgId = base64UrlEncode(randomBytes(12));
    // Reply pointer rides inside the encrypted payload, never as a cleartext
    // field — the relay must not learn which message answers which.
    const replyRef = replyToId && replyTarget
      ? { msg_id: replyToId, quote: getMessagePreview(replyTarget.content) }
      : null;
    const payload = JSON.stringify({
      text: trimmed,
      handle: handle || null,
      ...(replyRef ? { reply_to: replyRef } : {}),
    });
    const encrypted = await encryptText(cryptoKey, roomHash, 'chat', msgId, payload);

    const response = await postEncryptedRoomMessage(roomHash, token, msgId, JSON.stringify(encrypted));

    if (response.ok) {
      // Notify the room's OTHER devices — never the sender's own (triggerRoomPush
      // excludes this device's endpoint server-side). Best-effort; never blocks
      // or fails the send over a push hiccup.
      void triggerRoomPush(roomHash, token);
      const messageRecord: ChatMessage = {
        id: msgId,
        room_hash: roomHash,
        timestamp: Date.now(),
        content: trimmed,
        type: 'chat',
        direction: 'out',
        from: tokenHash,
        handle: handle || null,
        reply_to: replyRef
      };
      void persistMessage(messageRecord);
      setMessages((prev) => {
        if (prev.find((item) => item.id === msgId)) {
          return prev;
        }
        return [...prev, messageRecord].sort((a, b) => a.timestamp - b.timestamp);
      });
      setChatInput('');
      setShowComposer(false);
      setReplyToId(null);
      setSelectedId(null);
    }
    } finally {
      sendInFlightRef.current = false;
    }
  }, [roomHash, token, cryptoKey, tokenHash, handle, addSystemMessage, roomSecret, persistMessage, replyToId, replyTarget]);

  // The composer's normal send: fire the live draft through the shared path.
  const sendMessage = useCallback(() => sendText(chatInput), [sendText, chatInput]);

  // Agent rooms: a reply doesn't send — it joins the batch. We reopen the
  // message we replied to so the operator stays in context (spec: remain in
  // the detail view after the composer closes) and can keep answering.
  const queueReply = useCallback((rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || !replyToId || !replyTarget) return;
    const entry: ReplyEntry = {
      text: trimmed,
      reply_to: { msg_id: replyToId, quote: getMessagePreview(replyTarget.content) },
    };
    setReplyQueue((prev) => [...prev, entry]);
    setChatInput('');
    setShowComposer(false);
    setReplyToId(null);
    setSelectedId(entry.reply_to.msg_id);
  }, [replyToId, replyTarget]);

  const addReplyToBatch = useCallback(() => queueReply(chatInput), [queueReply, chatInput]);

  // The composer's submit (Done button, ⌘↵, iOS keyboard Done) routes here:
  // batch the reply in an agent room, otherwise send a normal message.
  const submitComposer = useCallback(() => {
    if (isAgentRoom && replyToId) {
      addReplyToBatch();
    } else {
      void sendMessage();
    }
  }, [isAgentRoom, replyToId, addReplyToBatch, sendMessage]);

  const removeQueuedReply = useCallback((index: number) => {
    setReplyQueue((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Dispatch the whole batch as ONE encrypted message: one request, one
  // ciphertext, one event. The agent receives every reply together, each
  // tagged with the message it answers. Then we leave the detail view.
  const dispatchBatch = useCallback(async () => {
    if (!roomHash || !token || !cryptoKey || replyQueue.length === 0) return;
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      const replies = replyQueue;
      const summary = `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`;
      upsertRoom(roomHash, roomSecret, handle || null);
      const msgId = base64UrlEncode(randomBytes(12));
      const payload = JSON.stringify({ text: summary, handle: handle || null, replies });
      const encrypted = await encryptText(cryptoKey, roomHash, 'chat', msgId, payload);
      const response = await postEncryptedRoomMessage(roomHash, token, msgId, JSON.stringify(encrypted));
      if (response.ok) {
        const record: ChatMessage = {
          id: msgId,
          room_hash: roomHash,
          timestamp: Date.now(),
          content: summary,
          type: 'chat',
          direction: 'out',
          from: tokenHash,
          handle: handle || null,
          replies,
        };
        void persistMessage(record);
        setMessages((prev) =>
          prev.find((item) => item.id === msgId)
            ? prev
            : [...prev, record].sort((a, b) => a.timestamp - b.timestamp)
        );
        setReplyQueue([]);
        setShowCollector(false);
        setSelectedId(null);
      }
    } finally {
      sendInFlightRef.current = false;
    }
  }, [roomHash, token, cryptoKey, replyQueue, roomSecret, handle, tokenHash, persistMessage]);

  // All selections from one agent message are sent together as a single
  // encrypted message. Sending them one-at-a-time used to make the first reply
  // win while the rest queued behind it, starving the agent of context.
  const sendBlockResponses = useCallback(
    async (responses: BlockResponseInput[]) => {
      if (!roomHash || !token || !cryptoKey || responses.length === 0) return;
      const block_responses: BlockResponse[] = responses.map((r) => ({
        block_id: r.blockId,
        type: r.type,
        value: r.value as BlockResponse['value']
      }));
      // One label line per selection so the agent reads them all at once.
      // formatBlockValue renders object values (e.g. the swipe verdict map)
      // instead of letting them stringify to "[object Object]".
      const text = block_responses.map((br) => `[${br.type}] ${formatBlockValue(br.value)}`).join('\n');
      // Mirror the single case into block_response so the daemon control room
      // and single-block rendering keep working unchanged.
      const single = block_responses.length === 1 ? block_responses[0] : null;
      const msgId = base64UrlEncode(randomBytes(12));
      const payload = JSON.stringify({
        text,
        handle: handle || null,
        block_responses,
        ...(single ? { block_response: single } : {})
      });
      const encrypted = await encryptText(cryptoKey, roomHash, 'chat', msgId, payload);
      const response = await postEncryptedRoomMessage(roomHash, token, msgId, JSON.stringify(encrypted));
      if (response.ok) {
        const messageRecord: ChatMessage = {
          id: msgId,
          room_hash: roomHash,
          timestamp: Date.now(),
          content: text,
          type: 'chat',
          direction: 'out',
          from: tokenHash,
          handle: handle || null,
          block_response: single,
          block_responses
        };
        void persistMessage(messageRecord);
        setMessages((prev) => {
          if (prev.find((item) => item.id === msgId)) return prev;
          return [...prev, messageRecord].sort((a, b) => a.timestamp - b.timestamp);
        });
        setSelectedId(null);
      }
    },
    [roomHash, token, cryptoKey, tokenHash, handle, persistMessage]
  );

  // Disband destroys the room for EVERYONE and is offered to ANY member — there
  // is no creator-only gating on the client (the button and this handler are
  // unconditional). If the relay still rejects a non-creator's disband, the
  // client has done its part; the affordance stays visible to every participant.
  // TODO(server): allow any participant to disband.
  const disbandRoom = useCallback(async () => {
    if (!roomHash || !token) {
      return;
    }
    const response = await postDisband(roomHash, token);
    if (response.ok || response.status === 404) {
      await wipeLocalRoom(roomHash);
      setRoomState('DESTROYED');
    }
  }, [roomHash, token, wipeLocalRoom]);

  // Leave drops just this participant server-side; the room lives on for
  // everyone else. We still wipe local state (the token is now revoked) and
  // land on the LEFT screen rather than the disbanded DESTROYED one.
  const leaveRoom = useCallback(async () => {
    if (!roomHash || !token) {
      return;
    }
    const response = await postLeave(roomHash, token);
    if (response.ok || response.status === 404) {
      await wipeLocalRoom(roomHash);
      setRoomState('LEFT');
    }
  }, [roomHash, token, wipeLocalRoom]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(shareUrl);
  }, [shareUrl]);

  const handleToggleCatchUp = useCallback(async () => {
    if (!roomHash || !token || catchUpBusy) return;
    const next = !catchUpEnabled;
    setCatchUpBusy(true);
    setCatchUpEnabled(next); // optimistic; settings Mercure event will reconfirm
    try {
      const r = await postRoomSettings(roomHash, token, next);
      if (!r.ok) {
        setCatchUpEnabled(!next);
      }
    } catch {
      setCatchUpEnabled(!next);
    } finally {
      setCatchUpBusy(false);
    }
  }, [roomHash, token, catchUpEnabled, catchUpBusy]);

  // Reflect this room's push opt-in once we know which room this is. The OS
  // permission is app-wide (granted once), but the registration is per-room:
  // each channel is enabled independently and stored room→device server-side.
  useEffect(() => {
    if (!roomHash) return;
    setPushStatus(getPushStatus(roomHash));
  }, [roomHash]);

  // While this subscribed channel is open in the foreground, keep a short-lived
  // room+endpoint marker on the server. Push fan-out skips that exact endpoint
  // so an agent/peer update appears live in-app without a duplicate OS banner.
  useEffect(() => {
    if (roomState !== 'PARTICIPANT' || !roomHash || !token || pushStatus !== 'on') return;

    let stopped = false;
    const isVisible = () => document.visibilityState === 'visible';
    const send = (foreground: boolean, keepalive = false) => {
      if (stopped && foreground) return;
      void markPushForeground(roomHash, token, foreground, { keepalive, force: true });
    };
    const refresh = () => {
      if (isVisible()) send(true);
      else send(false, true);
    };
    const clear = () => send(false, true);

    refresh();
    const interval = window.setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('pagehide', clear);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('pagehide', clear);
      clear();
    };
  }, [roomState, roomHash, token, pushStatus]);

  useEffect(() => {
    if (!showMenu || !menuFocusTarget) return;
    const input =
      menuFocusTarget === 'password'
        ? roomPasswordInputRef.current
        : expectedKnockInputRef.current;
    if (!input) return;
    const timer = window.setTimeout(() => {
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input.focus({ preventScroll: true });
      setMenuFocusTarget(null);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [showMenu, menuFocusTarget]);

  const handleTogglePush = useCallback(async () => {
    if (!roomHash || !token || pushBusy) return;
    if (pushStatus === 'unsupported' || pushStatus === 'denied') return;
    setPushBusy(true);
    setPushError('');
    try {
      if (pushStatus === 'on') {
        await disablePush(roomHash, token);
        setPushStatus('off');
      } else {
        await enablePush(roomHash, token);
        setPushStatus('on');
      }
    } catch (err) {
      // Surface the reason rather than silently leaving the toggle off — the
      // common case is the browser refusing pushManager.subscribe().
      setPushError(err instanceof Error ? err.message : 'could not change notifications.');
      setPushStatus(getPushStatus(roomHash));
    } finally {
      setPushBusy(false);
    }
  }, [roomHash, token, pushStatus, pushBusy]);

  const dismissRoomSetup = useCallback(() => {
    if (roomHash) setRoomSetupDismissed(roomHash, true);
    setRoomSetupDismissedState(true);
  }, [roomHash]);

  const openMenuForSetup = useCallback((target: 'password' | 'knock') => {
    setSelectedId(null);
    setMenuFocusTarget(target);
    setShowMenu(true);
  }, []);

  const handleSetupResponses = useCallback(
    async (responses: BlockResponseInput[]) => {
      if (!roomHash || responses.length === 0) return;
      const response = responses[0];
      if (response.blockId === 'room-setup-security') {
        if (response.value === 'password') {
          openMenuForSetup('password');
        } else if (response.value === 'knock_phrase') {
          openMenuForSetup('knock');
        }
        // 'skip_security' declines security but still offers the delivery
        // options — only the delivery card's "No thanks" ends the flow.
        setRoomSetupStage('delivery');
        return;
      }

      if (response.blockId === 'room-setup-delivery') {
        if (response.value === 'catchup' && !catchUpEnabled) {
          await handleToggleCatchUp();
        }
        if (response.value === 'notifications' && pushStatus !== 'on') {
          await handleTogglePush();
        }
        dismissRoomSetup();
      }
    },
    [roomHash, catchUpEnabled, dismissRoomSetup, handleToggleCatchUp, handleTogglePush, openMenuForSetup, pushStatus]
  );

  const handleDeleteMessage = useCallback(async (id: string) => {
    await deleteMessage(id);
    setMessages((prev) => prev.filter((item) => item.id !== id));
    setSelectedId(null);
  }, []);

  const handleCopyMessage = useCallback(async (content: string) => {
    await navigator.clipboard.writeText(content);
    setSelectedId(null);
  }, []);

  // What "Copy" should put on the clipboard for a message. For a batch reply
  // message, the rendered content is just the "N replies" summary — copy the
  // actual reply texts (with the quote each answers) instead of that label.
  const messageCopyText = useCallback((msg: ChatMessage): string => {
    if (msg.replies && msg.replies.length > 0) {
      return msg.replies
        .map((r) => (r.reply_to?.quote ? `↳ ${r.reply_to.quote}\n${r.text}` : r.text))
        .join('\n\n');
    }
    return msg.content;
  }, []);

  const openComposer = useCallback((messageId?: string) => {
    // Control rooms have no free-text affordance — every verb the daemon
    // accepts is reachable via the command bar's Spawn/Agents buttons and
    // their downstream blocks. The FAB and per-message Reply are hidden
    // (see render below), and there's no other caller of this function in
    // a control room. The early-return is defense-in-depth so a future code
    // path (a new block type, a new keyboard shortcut, etc.) can't silently
    // re-open the composer here.
    if (isControlRoom) return;
    // Focus a hidden proxy textarea synchronously so Safari counts the
    // subsequent focus jump (to the real composer textarea, after React
    // commits showComposer=true) as user-gesture-trusted and opens the
    // keyboard. Without this, the composer would mount but the keyboard
    // wouldn't appear until the user taps the field manually.
    focusProxyRef.current?.focus();
    setReplyToId(messageId ?? null);
    setSelectedId(null);
    setShowComposer(true);
  }, [isControlRoom]);

  const closeComposer = useCallback(() => {
    setShowComposer(false);
    setReplyToId(null);
  }, []);

  const openSwitcher = useCallback(() => {
    setAllRooms(listRooms());
    setShowSwitcher(true);
  }, []);

  useEffect(() => {
    if (roomState !== 'PARTICIPANT') {
      return;
    }
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (isTouch) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        if (showComposer || showMenu || showHelp || showQueue || showDisband || showLeave || showQr || selectedId) {
          return;
        }
        event.preventDefault();
        openComposer();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [roomState, showComposer, showMenu, showHelp, showQueue, showDisband, showLeave, showQr, selectedId, openComposer]);

  const scrollToLatest = useCallback(() => {
    // Reset render window to newest BEFORE scrolling so the destination is
    // actually the newest message rather than the visual edge of whatever
    // slice was rendered. Classic order keeps newest at the BOTTOM, so the
    // latest message lives at the foot of the document.
    jumpWindowToLatest();
    // Double rAF: the first frame commits the window reset + any just-added
    // message, the second reads the settled scrollHeight. A single frame can
    // measure a stale (shorter) height mid-keyboard-close and land short of
    // the foot — which read as "jumped to the top" in classic order.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight });
      });
    });
  }, [jumpWindowToLatest]);

  const handleScroll = useCallback(() => {
    const top = window.scrollY;
    const prevTop = lastScrollYRef.current;
    lastScrollYRef.current = top;
    // A deliberate scroll-up (the viewport moves up by more than a jitter
    // threshold) means the user has taken control — stop force-following the
    // tail for this room entry. Content growth pushes the floor down without
    // moving scrollY up, so it never trips this. Gate on userScrolledRef so an
    // *involuntary* upward jump — e.g. an installed-PWA WKWebView restoring
    // scroll to the top on the hash switch — can't be mistaken for the user
    // taking control and permanently disarm the pin (#224).
    if (initialScrollPendingRef.current && userScrolledRef.current && top < prevTop - 8) {
      initialScrollPendingRef.current = false;
    }
    const distanceFromBottom =
      document.documentElement.scrollHeight - (window.innerHeight + top);
    const atBottom = distanceFromBottom <= 40;
    setAutoScroll(atBottom);
    setHeaderCondensed(top > 32);
    if (atBottom) {
      setUnreadCount(0);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Mark that the user has actually driven a scroll. Only these real gestures
  // (mouse wheel / touch drag) flip userScrolledRef; programmatic or browser-
  // driven scrolls (scroll restoration, visualViewport settle, our own
  // scrollTo) never fire them. handleScroll consults this before releasing the
  // entry pin so an involuntary jump can't disarm it (#224).
  useEffect(() => {
    const markUserScroll = () => {
      userScrolledRef.current = true;
    };
    window.addEventListener('wheel', markUserScroll, { passive: true });
    window.addEventListener('touchmove', markUserScroll, { passive: true });
    return () => {
      window.removeEventListener('wheel', markUserScroll);
      window.removeEventListener('touchmove', markUserScroll);
    };
  }, []);

  // Entry/switch scroll pin (#211). On a room change, owe an unconditional jump
  // to the foot and keep re-pinning as the document grows (catch-up messages,
  // late block/image layout) until the user scrolls up or the room settles.
  // A ResizeObserver is what makes this robust where the old single measure
  // raced: it re-asserts the foot every time height changes during the window.
  useEffect(() => {
    if (!roomHash) return;
    initialScrollPendingRef.current = true;
    // Fresh entry: control hasn't been handed to the user yet (#224).
    userScrolledRef.current = false;
    lastScrollYRef.current = window.scrollY;
    const ro = new ResizeObserver(() => {
      if (!initialScrollPendingRef.current) return;
      window.scrollTo({ top: document.documentElement.scrollHeight });
    });
    ro.observe(document.documentElement);
    // Backstop: release the pin once the room has had time to settle so a later
    // organic arrival is handled history-aware (counted, not force-scrolled)
    // rather than yanking a reader who paused exactly at the foot.
    const settle = setTimeout(() => {
      initialScrollPendingRef.current = false;
    }, 1500);
    return () => {
      ro.disconnect();
      clearTimeout(settle);
    };
  }, [roomHash]);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    const grew = messages.length > prevCount;
    prevCountRef.current = messages.length;
    if (!grew) return;
    // First hydration / room entry starts at the document top in classic order.
    // Treat that as following the live tail so existing rooms open on the
    // newest message instead of showing the oldest history.
    const firstPopulation = prevCount === 0;
    // While the room is still entering/settling, follow the tail unconditionally
    // (#211): catch-up messages arrive after the first scroll, and a geometry
    // read here can transiently see "not at bottom" mid-settle and wrongly park
    // the room in history with an unread pill. The pin is released on a user
    // scroll-up or the settle timeout (see the entry-scroll effect).
    const entering = initialScrollPendingRef.current;
    // `messages` is ascending (oldest→newest), so the tail is the newest.
    const newest = messages[messages.length - 1];
    const newestIsMine = newest?.direction === 'out';
    // Measure the live scroll position instead of trusting the `autoScroll`
    // state: a layout/scroll event around the insert can leave that flag
    // stale, and a stale `true` here fires scrollToLatest — which resets the
    // render window (a visible reflow "flash") and clears the unread pill even
    // though the user is parked up in history. Reading geometry now is exact.
    const distanceFromBottom =
      document.documentElement.scrollHeight - (window.innerHeight + window.scrollY);
    const atBottom = distanceFromBottom <= 40;
    if (firstPopulation || entering || newestIsMine || atBottom) {
      // Initial room entry, sending, or following the live tail: jump to the foot.
      setAutoScroll(true);
      setUnreadCount(0);
      requestAnimationFrame(scrollToLatest);
    } else {
      // Parked in history: never move the viewport — just count the arrival so
      // the pill shows and persists until tapped or the user reaches bottom.
      // Force autoScroll false here too: the scroll-state flag can still be
      // stale true (for example after window expansion / browser scroll
      // restoration), and the pill visibility is gated on that state.
      setAutoScroll(false);
      setUnreadCount((count) => count + (messages.length - prevCount));
    }
  }, [messages, scrollToLatest]);

  // Reveal-on-tap pairing code panel for the room menu drawer. Rendered in
  // both the main and fallback menu drawers below; defining it once here keeps
  // them in sync. Only renders when a password is actually stored — peer
  // rooms with no pairing factor stay clean. The intended use is "I'm on
  // phone 1, my other phone has the room link but no code; I tap, read off
  // four digits, type them on the other phone." Auto-hide is handled by the
  // pairingCodeRevealed effect. Agent rooms already surface the daemon-minted
  // code as their room password, so don't duplicate it with a second reveal UI.
  const pairingCodePanel = roomPassword && !isAgentRoom ? (
    <div className="mt-2 rounded-xl border border-rule bg-bg p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">pairing code</p>
          <p className="mt-1 text-xs text-ink-soft">
            needed alongside the room link to join from another device. read it
            off, don't share it together with the link.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPairingCodeRevealed((v) => !v)}
          className="shrink-0 rounded-full border border-ink px-3 py-1 text-xs font-semibold"
        >
          {pairingCodeRevealed ? 'hide' : 'show'}
        </button>
      </div>
      {pairingCodeRevealed && (
        <p className="mt-3 text-center font-mono text-2xl font-bold tracking-[0.3em]">
          {roomPassword}
        </p>
      )}
    </div>
  ) : null;
  // ---------- Render ----------

  if (error) {
    return (
      <main className="app-page app-chrome text-ink">
        <div className="mx-auto flex max-w-xl flex-col gap-5 px-6 py-16">
          <p className="text-[0.6875rem] uppercase tracking-[0.35em] text-ink-dim">hisohiso</p>
          <div className="rounded-[22px] border border-danger bg-danger-soft p-6 text-sm leading-7 text-danger">
            {error}
          </div>
          <a
            className="text-sm font-medium text-ink underline decoration-rule underline-offset-4"
            href="/rooms"
          >
            ← your rooms
          </a>
        </div>
      </main>
    );
  }

  if (roomState === 'PARTICIPANT') {
    const connectionLabel =
      connection === 'connected' ? 'live' : connection === 'error' ? 'reconnecting…' : 'connecting…';
    const connectionColor =
      connection === 'connected' ? '#16a34a' : connection === 'error' ? '#b91c1c' : '#9a9a9a';
    // Optional agent/control-room context strip below the header pills. The
    // git/cwd line may appear in agent or control rooms.
    const contextLine = (isAgentRoom || isControlRoom) ? formatRoomContext(roomContext) : null;
    const showContextStrip = !!contextLine;

    return (
      <main className="app-shell app-chrome room-with-rail relative text-ink">
        {/* ---- Desktop rooms rail (lg+ only) ----
            A persistent local-channel list pinned to the left at large widths so
            the operator can hop rooms without leaving /room. Hidden below lg
            (display:none on .rooms-rail), so the mobile single-pane is unchanged.
            Tapping a card swaps the room via hash (navigateToRoom — no reload),
            since the rail always lives on /room. The .room-with-rail class shifts
            this screen's fixed chrome (header pills, compose FAB, command bar,
            modals, message column) right by the rail width at lg+. */}
        <RoomsRail activeRoomHash={roomHash} onSelectRoom={navigateToRoom} />

        {/* Off-screen focus proxy. Keeps Safari's user-gesture trust when a
            click handler programmatically focuses the inline composer textarea. */}
        <textarea
          ref={focusProxyRef}
          aria-hidden="true"
          className="fixed -left-[9999px] top-0 h-0 w-0 opacity-0"
          tabIndex={-1}
        />

        {/* ---- Floating header pills ----
            Each control sits in its own glass pill, fixed-positioned over
            the messages with safe-area-aware top padding. The wrapper rows
            are pointer-events:none so gaps between pills click through to
            the message list underneath; each pill re-enables pointer events
            on itself. Messages scroll under the pills (and the notch / Safari
            URL bar / PWA edge), which is the explicit design goal. */}
        <div
          className="room-header-bar pointer-events-none fixed left-0 right-0 top-0 z-30 flex items-center justify-between gap-2 px-3"
          style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={openSwitcher}
              className="pointer-events-auto pill-control flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              aria-label="switch channels"
              title="switch channels"
            >
              <span
                className="block h-3.5 w-3.5 rounded-full ring-1 ring-inset ring-rule"
                style={{ backgroundColor: roomColor }}
              />
            </button>
            <div className="pointer-events-auto pill-control flex h-9 min-w-0 items-center gap-2 rounded-full px-3.5">
              <h1 className="truncate text-sm font-semibold tracking-[-0.015em]">
                {roomNickname || (roomKind === 'chat' && roomHash ? generateRoomName(roomHash) : 'channel')}
              </h1>
            </div>
            <div
              className="pointer-events-auto pill-control flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5"
              title={connectionLabel}
              aria-label={connectionLabel}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: connectionColor }}
                aria-hidden="true"
              />
              <span className="hidden text-[0.6875rem] text-ink-dim sm:inline">{connectionLabel}</span>
            </div>
            {/* ---- Opt-in own-presence dot (off by default) ----
                Reflects ONLY this device's own connection to the room — never
                anyone else's presence and never a read receipt. Renders only
                when the local opt-in is on (toggled in the menu). Lime when our
                own socket is live, muted otherwise. The label says "you:" so it
                is honest about whose presence this is. */}
            {presence.enabled && (
              <div
                className="pointer-events-auto pill-control flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5"
                title={presence.isLive ? 'you: live (your own connection)' : 'you: quiet (your own connection)'}
                aria-label={presence.isLive ? 'you are live' : 'you are quiet'}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    presence.isLive ? 'bg-lime' : 'bg-ink-fade'
                  }`}
                  aria-hidden="true"
                />
                <span className="hidden text-[0.6875rem] text-ink-dim sm:inline">
                  {presence.isLive ? 'you: live' : 'you: quiet'}
                </span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              aria-label={knocks.length === 0 ? 'open join queue' : `open join queue, ${knocks.length} waiting`}
              className="pointer-events-auto pill-control relative inline-flex h-9 w-9 items-center justify-center rounded-full text-ink"
              onClick={() => setShowQueue(true)}
              type="button"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
                <path d="M10 17a2 2 0 0 0 4 0" />
              </svg>
              {knocks.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-[0.625rem] font-semibold leading-tight text-on-ink">
                  {knocks.length}
                </span>
              )}
            </button>
            {isControlRoom && (
              <button
                aria-label="schedules"
                title="schedules"
                className="pointer-events-auto pill-control inline-flex h-9 w-9 items-center justify-center rounded-full text-ink"
                onClick={() => setShowSchedules(true)}
                type="button"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </button>
            )}
            <button
              aria-label="channel info"
              className="pointer-events-auto pill-control inline-flex h-9 w-9 items-center justify-center rounded-full text-ink"
              onClick={() => setShowHelp(true)}
              type="button"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M9.6 9.2a2.6 2.6 0 1 1 4.1 2.1c-.9.6-1.7 1.1-1.7 2.2" />
                <path d="M12 17h.01" />
              </svg>
            </button>
            <button
              className="pointer-events-auto pill-control inline-flex h-9 items-center justify-center rounded-full px-3.5 text-xs font-medium text-ink"
              onClick={() => setShowMenu(true)}
              type="button"
            >
              menu
            </button>
          </div>
        </div>

        {/* ---- Agent/control context strip (optional) ----
            A thin glass pill under the header showing the daemon's working
            context (git branch / cwd) in agent and control rooms only. It is
            optional and the whole strip is omitted when absent, so chat rooms
            and un-stamped agent rooms keep the original chrome. Fixed below the
            header pills (which sit at safe-area-inset-top + a 9-unit pill);
            pointer-events:none on the wrapper lets gaps click through to the
            messages, the pill itself stays inert (no interaction needed). */}
        <ScrollDiag
          roomHash={roomHash}
          roomKind={roomKind}
          roomState={roomState}
          messageCount={messages.length}
        />

        {showContextStrip && (
          <div
            className="room-header-bar pointer-events-none fixed left-0 right-0 z-30 flex justify-start px-3"
            style={{ top: 'calc(max(0.5rem, env(safe-area-inset-top)) + 2.75rem)' }}
          >
            <div className="pill-control flex min-w-0 max-w-full flex-col gap-0.5 rounded-2xl px-3 py-1.5">
              {contextLine && (
                <p className="truncate font-mono text-[0.6875rem] leading-tight text-ink-soft" title={contextLine}>
                  {contextLine}
                </p>
              )}
            </div>
          </div>
        )}

        {/* ---- Message list (newest at top, document-scrolled) ----
            No inner scroll: the document itself scrolls so messages can pass
            under the notch, the Safari URL bar, and the phone's home-bar in
            PWA mode. The windowing hook (useMessageWindow) falls back to
            window/documentElement when listRef.current is null, which is the
            case here — the ref is intentionally not attached. We avoid
            `overflow-x: hidden` on any element in the scroll path so we
            don't accidentally create a non-overflowing scroll container
            that swallows touch gestures (horizontal clipping lives on
            html/body instead). */}
        <div className="relative">
          {/* Top padding clears the floating header pills at rest. Bottom
              padding clears the floating Compose button. Messages can still
              scroll under both — the padding only positions the at-rest
              first/last messages so they're not permanently obscured.
              The pills are pushed down by env(safe-area-inset-top) (see
              paddingTop above), so this padding must carry the same inset —
              otherwise on notch / Dynamic Island devices the flat 4rem lands
              behind the lowered pills. Matching the inset keeps a constant
              gap below the pills on every device.
              In CLASSIC order the newest message lives at this foot, so the
              bottom clearance must guarantee it never hides under the FAB.
              The FAB is fixed at bottom:max(1rem,inset) with min-height 3.25rem,
              so it reaches inset+3.25rem; we pad inset + ~6rem to leave a real
              gap above it on every device (the flat pb-28/32 ignored the
              bottom inset and only cleared the FAB by luck). */}
          <div className="room-message-column mx-auto w-full max-w-[820px] px-4 pt-[calc(env(safe-area-inset-top)+4rem)] pb-[calc(env(safe-area-inset-bottom)+6rem)] sm:px-6 sm:pb-[calc(env(safe-area-inset-bottom)+7rem)]">
	            {showEmptyState && (
	              <div className="glass-panel rounded-[28px] border-dashed p-6 text-center sm:p-8">
                <p className="text-lg font-bold tracking-[-0.02em] text-ink sm:text-xl">
                  invite someone.
                </p>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-soft">
                  share this link. anyone with it can request to join.
                </p>

                <div className="mx-auto mt-5 flex max-w-md items-center gap-2 rounded-full border border-rule bg-bg px-3 py-1.5">
                  <p className="min-w-0 flex-1 truncate text-left text-xs text-ink-soft">{shareUrl}</p>
                  <button
                    className="shrink-0 btn-primary btn-sm"
                    onClick={() => { void navigator.clipboard.writeText(shareUrl); }}
                    type="button"
                  >
                    copy
                  </button>
                </div>

                {emptyQrSrc && (
                  <div className="mt-5 flex justify-center">
                    <img
                      src={emptyQrSrc}
                      alt="channel qr code"
                      className="h-40 w-40 rounded-[10px] border border-rule sm:h-44 sm:w-44"
                    />
                  </div>
                )}

	                <p className="mt-5 text-xs text-ink-dim">or just start typing above.</p>
	              </div>
	            )}

	            {showRoomSetupNudge && (
	              <div className="my-3 flex w-full flex-col items-start">
	                <p className="mb-1 px-2 text-[0.6875rem] text-ink-dim">hisohiso</p>
	                <div className="message-card message-card-in max-w-[84%] rounded-[22px] rounded-bl-[7px] px-4 py-3 text-left leading-6 text-ink sm:max-w-[72%]">
	                  <p className="mb-2 whitespace-pre-line break-words text-[0.9375rem]">
	                    {roomSetupStage === 'security' ? 'room setup' : 'delivery setup'}
	                  </p>
	                  <BlockRenderer
	                    blocks={roomSetupBlocks(roomSetupStage)}
	                    onRespond={handleSetupResponses}
	                    progressOverrides={progressOverrides}
	                  />
	                </div>
	              </div>
	            )}

	            {/* Inline knock cards — pending join requests surfaced in the
                conversation itself (not only the header bell + queue modal), so
                you can let someone in without leaving the thread. Privacy: a
                knocker has NO identity here — we show only their own voluntary
                note (never a handle, pubkey, or "who sent you"). The knock having
                decrypted already proves they hold the link (+ password if set);
                approve/reject reuse the exact same handshake as the queue modal. */}
            {knocks.length > 0 && (
              <div className="mb-3 flex flex-col gap-2">
                {knocks.map((knock) => {
                  const expected = expectedKnockMessage.trim();
                  const matchesExpected = expected !== '' && knock.message.trim() === expected;
                  return (
                    <div
                      key={`inline-knock-${knock.id}`}
                      className="rounded-[20px] border border-accent bg-accent-soft p-4"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-ink"
                          aria-hidden="true"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 20V9l8-5 8 5v11" />
                            <path d="M9 20v-6h6v6" />
                          </svg>
                        </span>
                        <p className="text-sm font-semibold text-ink">someone's knocking</p>
                        {expected && (
                          <span
                            className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-[0.625rem] font-semibold uppercase tracking-[0.16em] ${
                              matchesExpected
                                ? 'border border-ink bg-filled text-on-ink'
                                : 'border border-danger bg-danger-soft text-danger'
                            }`}
                          >
                            {matchesExpected ? 'matches' : 'mismatch'}
                          </span>
                        )}
                        <span className={`${expected ? '' : 'ml-auto'} shrink-0 text-xs text-ink-dim`}>{formatMailStamp(knock.ts)}</span>
                      </div>
                      <p className="mt-2 break-words text-sm leading-6 text-ink">{knock.message || 'no note included.'}</p>
                      <p className="mt-1 text-[0.6875rem] leading-4 text-ink-dim">
                        their knock decrypts with the link — let them in only if you're expecting someone.
                      </p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => approveKnock(knock.id)}
                          className="flex-1 btn-primary"
                        >
                          let in
                        </button>
                        <button
                          type="button"
                          onClick={() => rejectKnock(knock.id)}
                          className="flex-1 btn-ghost"
                        >
                          decline
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!showEmptyState && visibleMessages.length === 0 && (
              <div className="glass-panel rounded-[28px] border-dashed p-8 text-center">
                <p className="text-base font-semibold text-ink">all quiet.</p>
                <p className="mt-2 text-sm leading-6 text-ink-soft">whisper something to start.</p>
              </div>
            )}

            {/* Classic order: flex-col-reverse renders children bottom-to-top, so
                the newest-first arrays land newest-at-the-BOTTOM. It also flips the
                two sentinels to the right visual edges (older→top, newer→bottom) and
                keeps the live work indicators next to the freshest message — all
                without touching the windowing hook's index math. */}
            <div className="flex flex-col-reverse gap-3">
              {hasNewer && (
                <div ref={topSentinelRef} aria-hidden="true" className="h-px w-full shrink-0" />
              )}

              {/* Live work indicator: one in-place bubble per active agent, sitting
                  where its reply will land (newest is at the bottom). It updates as
                  the agent's state changes and is removed the instant the reply
                  arrives. Only shown on the latest window, never over history. */}
              {!hasNewer && Object.entries(agentStatuses).map(([key, st]) => (
                <div key={`status-${key}`} className="flex w-full flex-col items-start">
                  {st.handle && (
                    <p className="mb-1 px-2 text-[0.6875rem] text-ink-dim">{st.handle}</p>
                  )}
                  <div className="message-card message-card-in inline-flex max-w-[84%] items-center gap-2.5 rounded-[22px] rounded-bl-[7px] px-4 py-3 text-[0.9375rem] text-ink-soft sm:max-w-[72%]">
                    {st.state === 'stuck' ? (
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-danger" aria-hidden="true" />
                    ) : (
                      <span className="flex shrink-0 items-end gap-1" aria-hidden="true">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft [animation-delay:-0.3s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft [animation-delay:-0.15s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft" />
                      </span>
                    )}
                    <span className="break-words">{st.text || 'working…'}</span>
                  </div>
                </div>
              ))}

              {renderedMessages.map((msg) => {
                const isSystem = msg.type === 'system';
                const isMine = msg.direction === 'out' && !isSystem;

                if (isSystem) {
                  return (
                    <div key={msg.id} className="my-1 flex justify-center">
                      <p className="rounded-full bg-bg px-3 py-1 text-[0.6875rem] text-ink-dim">
                        {getMessagePreview(msg.content)} · {formatMailStamp(msg.timestamp)}
                      </p>
                    </div>
                  );
                }

                const senderLabel = msg.handle || (isMine ? 'you' : null);
                const hasBlocks = !!(msg.blocks && msg.blocks.length > 0);

                return (
                  <div
                    key={msg.id}
                    className={`flex w-full flex-col ${isMine ? 'items-end' : 'items-start'}`}
                  >
                    {senderLabel && (
                      <p className="mb-1 px-2 text-[0.6875rem] text-ink-dim">{senderLabel}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedId(msg.id)}
                      data-testid="message-card"
                      data-message-direction={isMine ? 'out' : 'in'}
                      className={`message-card max-w-[84%] cursor-pointer rounded-[22px] px-4 py-3 text-left leading-6 transition-colors sm:max-w-[72%] ${
                        isMine
                          ? 'message-card-out rounded-br-[7px] hover:brightness-110'
                          : 'message-card-in rounded-bl-[7px] text-ink hover:border-ink'
                      }`}
                    >
                      {msg.reply_to && (
                        <p
                          className={`mb-1.5 line-clamp-2 border-l-2 pl-2 text-xs ${
                            isMine ? 'border-on-ink/40 text-on-ink/70' : 'border-accent text-ink-dim'
                          }`}
                        >
                          ↳ {msg.reply_to.quote || 'message'}
                        </p>
                      )}
                      <p className="whitespace-pre-line break-words text-[0.9375rem]">
                        {msg.replies && msg.replies.length > 0 ? (
                          <span className="flex items-center gap-2">
                            <span
                              className={`inline-block h-1.5 w-1.5 rounded-full ${
                                isMine ? 'bg-surface/60' : 'bg-ink'
                              }`}
                            />
                            {msg.replies.length} {msg.replies.length === 1 ? 'reply' : 'replies'} — tap to view
                          </span>
                        ) : msg.block_response || (msg.block_responses && msg.block_responses.length > 0) ? (
                          <span className="flex items-center gap-2">
                            <span
                              className={`inline-block h-1.5 w-1.5 rounded-full ${
                                isMine ? 'bg-surface/60' : 'bg-ink'
                              }`}
                            />
                            {formatBlockResponse(msg) || getMessagePreview(msg.content)}
                          </span>
                        ) : (
                          getMessagePreview(msg.content)
                        )}
                      </p>

                      {hasBlocks && msg.blocks && (
                        <span
                          className={`mt-2 inline-block rounded-full px-3 py-1 text-[0.6875rem] font-medium ${
                            isMine
                              ? 'bg-surface/15 text-on-ink'
                              : 'border border-rule bg-bg text-ink-soft'
                          }`}
                        >
                          {msg.blocks.length} interactive{' '}
                          {msg.blocks.length === 1 ? 'block' : 'blocks'} — tap to view
                        </span>
                      )}

                      {msg.action?.type === 'join-room' && (
                        <div className="mt-3 flex flex-col items-start gap-2">
                          <span
                            role="button"
                            tabIndex={0}
                            className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium ${
                              isMine
                                ? 'bg-surface text-ink'
                                : 'border border-ink bg-filled text-on-ink'
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (msg.action?.type === 'join-room') void joinActionRoom(msg.action);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                if (msg.action?.type === 'join-room') void joinActionRoom(msg.action);
                              }
                            }}
                          >
                            {msg.action.label} →
                          </span>
                          {msg.action.code && (
                            <div
                              className={`text-[0.6875rem] font-mono ${
                                isMine ? 'text-on-ink/70' : 'text-ink-dim'
                              }`}
                            >
                              code:{' '}
                              <span className="font-semibold tracking-[0.25em]">
                                {msg.action.code}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </button>
                    <div
                      className={`mt-1 flex items-center gap-2 px-2 text-[0.625rem] text-ink-dim ${
                        isMine ? 'flex-row-reverse' : ''
                      }`}
                    >
                      <span>{formatMailStamp(msg.timestamp)}</span>
                      {!isControlRoom && (
                        <>
                          <span aria-hidden="true">·</span>
                          <button
                            type="button"
                            className="hover:text-ink"
                            onClick={() => openComposer(msg.id)}
                          >
                            reply
                          </button>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        className="hover:text-ink"
                        onClick={() => void handleCopyMessage(messageCopyText(msg))}
                      >
                        copy
                      </button>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        className="hover:text-danger"
                        onClick={() => void handleDeleteMessage(msg.id)}
                      >
                        delete
                      </button>
                    </div>
                  </div>
                );
              })}

              {hasOlder && (
                <div ref={bottomSentinelRef} aria-hidden="true" className="h-px w-full shrink-0" />
              )}
            </div>
          </div>
        </div>

        {/* Unread-on-scroll pill. Viewport-fixed and floated just ABOVE the
            compose FAB (same env(safe-area-inset-bottom) the FAB carries, so the
            notch-taller FAB can't swallow it; z-40 keeps it over the FAB). Newest
            lives at the BOTTOM, so the arrow points down and tapping jumps there.

            It is ALWAYS mounted and merely faded in/out — never conditionally
            inserted. iOS Safari paints a freshly-inserted position:fixed node at
            its document-flow position for one frame before the compositor pins
            it, which made the pill flash "as the last element" mid-scroll. A
            stable, always-present layer sidesteps that entirely. */}
        {(() => {
          const pillActive = !autoScroll && unreadCount > 0;
          if (unreadCount > 0) lastUnreadRef.current = unreadCount;
          return (
            <button
              aria-hidden={!pillActive}
              tabIndex={pillActive ? 0 : -1}
              className={`unread-pill btn-primary btn-sm shadow-[0_8px_24px_-4px_rgba(10,10,10,0.3)] transition-opacity duration-150 ${
                pillActive ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
              onClick={() => {
                scrollToLatest();
                setAutoScroll(true);
                setUnreadCount(0);
              }}
              type="button"
            >
              ↓ {lastUnreadRef.current} new
            </button>
          );
        })()}

        {/* ---- Bottom-anchored chrome ----
            Non-control rooms get the floating Compose trigger (FAB). Control
            rooms swap in the command bar — Spawn + Agents (N) — and that's
            the whole control surface: no free-text affordance because the
            daemon takes no arbitrary instructions there. Every verb it
            accepts is reachable through these two buttons and their
            downstream blocks (launcher / list with per-row Join/Kill). */}
        {!isControlRoom && !(isAgentRoom && replyQueue.length > 0) && (
          <button
            className="floating-action px-5 py-3.5 text-sm font-semibold"
            onClick={() => openComposer()}
            type="button"
          >
            {replyTarget ? 'continue reply' : 'compose'}
          </button>
        )}
        {isControlRoom && (
          <ControlCommandBar
            agentCount={agentCount}
            onSpawn={() => void sendBlockResponses([{ blockId: 'control-cmd-spawn', type: 'buttons', value: 'show-launcher' }])}
            onAgents={() => void sendBlockResponses([{ blockId: 'control-cmd-list', type: 'buttons', value: 'show-list' }])}
          />
        )}

        {/* ---- Dispatch trigger (agent rooms only) ----
            Replaces the Compose FAB in the same spot/style while a batch is
            pending: tap to review and dispatch the queued replies as one
            message. Clearing/dispatching the batch brings Compose back. */}
        {isAgentRoom && replyQueue.length > 0 && (
          <button
            type="button"
            onClick={() => setShowCollector(true)}
            className="floating-action px-5 py-3.5 text-sm font-semibold"
          >
            dispatch ({replyQueue.length})
          </button>
        )}

        {/* ---- Collector tray ---- */}
        {showCollector && (
          <div
            className="room-overlay fixed inset-0 z-[60] flex items-end bg-overlay"
            onClick={() => setShowCollector(false)}
          >
            <div
              className="mx-auto flex max-h-[85dvh] w-full flex-col rounded-t-[24px] bg-bg md:max-w-lg"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-rule px-5 py-4">
                <p className="text-sm font-semibold">
                  batch · {replyQueue.length} {replyQueue.length === 1 ? 'reply' : 'replies'}
                </p>
                <button
                  type="button"
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowCollector(false)}
                >
                  close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-3">
                {replyQueue.length === 0 ? (
                  <p className="py-8 text-center text-sm text-ink-dim">no replies queued.</p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {replyQueue.map((entry, index) => (
                      <li key={index} className="flex items-start gap-3 border-b border-rule-soft pb-3">
                        <div className="min-w-0 flex-1">
                          <p className="mb-1 border-l-2 border-accent pl-2 text-xs text-ink-dim line-clamp-2">
                            ↳ {entry.reply_to.quote || 'message'}
                          </p>
                          <p className="whitespace-pre-line break-words text-sm text-ink">{entry.text}</p>
                        </div>
                        <button
                          type="button"
                          aria-label="remove reply"
                          className="shrink-0 text-danger hover:opacity-70"
                          onClick={() => removeQueuedReply(index)}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex gap-3 border-t border-rule px-5 py-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
                <button
                  type="button"
                  className="rounded-full border border-rule bg-surface px-4 py-2.5 text-sm font-medium text-ink"
                  onClick={() => {
                    setReplyQueue([]);
                    setShowCollector(false);
                  }}
                >
                  clear
                </button>
                <button
                  type="button"
                  className="flex-1 btn-primary disabled:cursor-not-allowed disabled:opacity-30"
                  disabled={replyQueue.length === 0}
                  onClick={() => void dispatchBatch()}
                >
                  dispatch all ({replyQueue.length})
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---- Full-screen modal composer ----
            Layout is a vertical flex column: optional reply preview, then a
            flex-1 textarea, then an edge-to-edge bottom toolbar with
            Cancel/Done. The textarea sits flush above the toolbar (no gap)
            so the toolbar reads as the keyboard's nearest chrome. The iOS
            accessory bar appears naturally above the keyboard since we use
            a real <textarea>; its Done button blurs the field, which our
            blur handler treats as "send if there's content". */}
        {showComposer && (
          <div className="composer-overlay fixed inset-x-0 top-0 z-50 bg-bg text-ink md:inset-0 md:bg-overlay md:px-5 md:py-6">
            <div className="modal-shell mx-auto flex h-full w-full flex-col bg-bg md:max-w-3xl md:overflow-hidden md:rounded-[28px]">
              {replyTarget && (
                <div
                  className={`shrink-0 overflow-hidden border-b border-rule bg-surface px-4 transition-all duration-200 ease-out sm:px-6 ${
                    keyboardVisible ? 'max-h-10 py-1.5' : 'max-h-40 py-3'
                  }`}
                >
                  <p
                    className={`text-[0.625rem] uppercase tracking-[0.2em] text-ink-dim transition-all duration-200 ${
                      keyboardVisible ? 'hidden' : ''
                    }`}
                  >
                    {isAgentRoom ? 'replying to · adds to batch' : 'replying to'}
                  </p>
                  <p
                    className={`font-medium text-ink transition-all duration-200 ${
                      keyboardVisible ? 'truncate text-xs' : 'mt-1 text-sm'
                    }`}
                  >
                    {getMessageLabel(replyTarget)}
                  </p>
                  <p
                    className={`whitespace-pre-line text-sm leading-6 text-ink-soft transition-all duration-200 ${
                      keyboardVisible ? 'hidden' : 'mt-1'
                    }`}
                  >
                    {getMessagePreview(replyTarget.content)}
                  </p>
                </div>
              )}

              <textarea
                ref={composerInputRef}
                aria-label={replyTarget ? 'reply' : 'new message'}
                placeholder="whisper something…"
                value={chatInput}
                enterKeyHint="send"
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    submitComposer();
                  }
                }}
                onBlur={() => {
                  // iOS Done = send: on a TOUCH device, a blur with no suppress
                  // flag (i.e. not triggered by our own Cancel/Done buttons) and
                  // a non-empty draft is the user dismissing the soft keyboard
                  // via the accessory bar's Done button — treat it as send. The
                  // composer is still open at this point (the modal isn't
                  // unmounted on blur), so submitComposer will close it.
                  //
                  // DESKTOP has no soft keyboard, so a blur is just focus moving
                  // away — clicking the rooms rail to switch channels, tabbing
                  // out, clicking any other control. Sending on those fires the
                  // open draft unintentionally (the rail-switch-submits bug).
                  // On desktop the ONLY send paths are the Done button and
                  // ⌘/Ctrl↵; blur never submits. Match the (pointer: coarse)
                  // gate already used by useKeyboardViewport and line ~1993.
                  if (suppressSendOnBlurRef.current) {
                    suppressSendOnBlurRef.current = false;
                    return;
                  }
                  const isTouch = window.matchMedia('(pointer: coarse)').matches;
                  if (isTouch && chatInput.trim()) {
                    submitComposer();
                  }
                }}
                className="composer-textarea block w-full flex-1 resize-none border-0 bg-transparent px-4 py-4 leading-7 text-ink outline-none sm:px-6"
              />

              {/* Edge-to-edge toolbar pinned to the bottom of the composer.
                  No rounded corners (on the modal-shell wrapper, the parent
                  overflow-hidden + rounded-[28px] clips the corners on
                  desktop; on mobile the modal is full-bleed so the bar
                  reads as a true full-width strip). Sits flush against the
                  textarea above. pointerdown on either button sets the
                  suppress flag so the textarea's blur handler doesn't
                  double-fire send. */}
              <div
                className="composer-toolbar flex shrink-0 items-center justify-between gap-3 border-t border-rule bg-surface-strong px-4 py-3"
                style={{
                  paddingBottom: keyboardVisible
                    ? undefined
                    : 'max(env(safe-area-inset-bottom), 0.75rem)',
                }}
              >
                <button
                  className="rounded-full px-4 py-2 text-sm font-medium text-ink-soft transition hover:text-ink"
                  onPointerDown={() => {
                    suppressSendOnBlurRef.current = true;
                  }}
                  onClick={closeComposer}
                  type="button"
                >
                  cancel
                </button>
                <button
                  className="btn-primary disabled:cursor-not-allowed disabled:opacity-30"
                  onPointerDown={() => {
                    suppressSendOnBlurRef.current = true;
                  }}
                  onClick={submitComposer}
                  type="button"
                  disabled={!chatInput.trim()}
                >
                  {isAgentRoom && replyToId ? 'add to batch' : 'done'}
                </button>
              </div>
            </div>
          </div>
        )}

        <QrModal open={showQr} onClose={() => setShowQr(false)} value={shareUrl} />

        {/* ---- Message detail ---- */}
        {activeMessage && (
          <div className="room-overlay fixed inset-x-0 top-0 z-50 flex h-[100dvh] flex-col bg-bg text-ink">
            <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
              <button
                className="text-sm font-medium text-ink-soft hover:text-ink"
                onClick={() => setSelectedId(null)}
                type="button"
              >
                back
              </button>
              <p className="text-sm font-semibold">
                {activeMessage.direction === 'out' ? 'sent message' : 'message'}
              </p>
              {!isControlRoom ? (
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => openComposer(activeMessage.id)}
                  type="button"
                >
                  reply
                </button>
              ) : (
                <span className="w-10" aria-hidden="true" />
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-6">
              <div className="mx-auto flex max-w-2xl flex-col gap-4">
                <div className="flex items-baseline justify-between gap-3 text-xs text-ink-dim">
                  <span>{getMessageLabel(activeMessage)}</span>
                  <span>{formatMailStamp(activeMessage.timestamp)}</span>
                </div>

                <article
                  className={`message-card rounded-[22px] px-5 py-4 leading-7 ${
                    activeMessage.direction === 'out'
                      ? 'message-card-out'
                      : 'message-card-in text-ink'
                  }`}
                >
                  {activeMessage.reply_to && (
                    <p
                      className={`mb-2 border-l-2 pl-2.5 text-xs ${
                        activeMessage.direction === 'out'
                          ? 'border-on-ink/40 text-on-ink/70'
                          : 'border-accent text-ink-dim'
                      }`}
                    >
                      ↳ {activeMessage.reply_to.quote || 'message'}
                    </p>
                  )}
                  {activeMessage.replies && activeMessage.replies.length > 0 ? (
                    <ul className="flex flex-col gap-3">
                      {activeMessage.replies.map((entry, index) => (
                        <li key={index} className={index > 0 ? 'border-t border-rule-soft pt-3' : ''}>
                          <p
                            className={`mb-1 border-l-2 pl-2 text-xs ${
                              activeMessage.direction === 'out'
                                ? 'border-on-ink/40 text-on-ink/70'
                                : 'border-accent text-ink-dim'
                            }`}
                          >
                            ↳ {entry.reply_to.quote || 'message'}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-[0.9375rem]">{entry.text}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-[0.9375rem]">
                      {activeMessage.block_response || (activeMessage.block_responses && activeMessage.block_responses.length > 0)
                        ? formatBlockResponse(activeMessage) || activeMessage.content
                        : activeMessage.content || 'empty message'}
                    </p>
                  )}
                </article>

                {activeMessage.blocks && activeMessage.blocks.length > 0 && (
                  <div className="rounded-[14px] border border-rule bg-surface p-4">
                    <BlockRenderer
                      blocks={activeMessage.blocks}
                      onRespond={sendBlockResponses}
                      progressOverrides={progressOverrides}
                    />
                  </div>
                )}

                {activeMessage.action?.type === 'join-room' && (
                  <div className="flex flex-col items-start gap-2">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => {
                        if (activeMessage.action?.type === 'join-room') {
                          void joinActionRoom(activeMessage.action);
                        }
                      }}
                    >
                      {activeMessage.action.label} →
                    </button>
                    {activeMessage.action.code && (
                      <div className="text-[0.6875rem] font-mono text-ink-dim">
                        code:{' '}
                        <span className="font-semibold tracking-[0.25em]">
                          {activeMessage.action.code}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-2 flex flex-wrap gap-2 pb-[env(safe-area-inset-bottom)]">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void handleCopyMessage(messageCopyText(activeMessage))}
                  >
                    copy
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => void handleDeleteMessage(activeMessage.id)}
                  >
                    delete local copy
                  </button>
                </div>
              </div>
            </div>

            {/* Dispatch trigger — the Compose FAB is hidden behind this z-50
                detail overlay, but a pending batch must stay reachable here too.
                Tap to review and send the queued replies as one message. */}
            {isAgentRoom && replyQueue.length > 0 && (
              <div className="border-t border-rule bg-surface px-5 py-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
                <button
                  type="button"
                  onClick={() => setShowCollector(true)}
                  className="flex w-full items-center justify-center rounded-full border border-accent bg-accent px-5 py-3.5 text-sm font-semibold text-on-ink"
                >
                  Dispatch ({replyQueue.length})
                </button>
              </div>
            )}
          </div>
        )}

        {/* ---- Schedules (#232): create-schedule sheet, control rooms only ---- */}
        {isControlRoom && (
          <SchedulePanel
            open={showSchedules}
            onClose={() => setShowSchedules(false)}
            onSend={(command) => {
              void sendText(command);
            }}
          />
        )}

        {/* ---- Knock queue ---- */}
        {showQueue && (
          <div className="modal-frame">
            <div className="modal-shell flex w-full max-w-2xl max-h-full flex-col overflow-hidden rounded-[28px]">
              <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4">
                <div>
                  <p className="text-[0.6875rem] uppercase tracking-[0.32em] text-ink-dim">notifications</p>
                  <h2 className="mt-1 text-lg font-bold tracking-[-0.015em]">join queue</h2>
                </div>
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowQueue(false)}
                  type="button"
                >
                  close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                {knocks.length === 0 && (
                  <div className="glass-panel rounded-[28px] border-dashed p-8 text-center">
                    <p className="text-base font-semibold">no one is waiting.</p>
                    <p className="mt-2 text-sm text-ink-soft">
                      new join requests appear here. the bell badge lights up when someone knocks.
                    </p>
                  </div>
                )}
                {knocks.length > 0 && (
                  <div className="grid gap-3">
                    {knocks.map((knock) => {
                      const expected = expectedKnockMessage.trim();
                      const matchesExpected = expected !== '' && knock.message.trim() === expected;
                      return (
                        <div
                          key={knock.id}
                          className="rounded-[18px] border border-rule bg-surface p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-ink">join request</p>
                              <p className="mt-0.5 text-xs text-ink-dim">{formatMailStamp(knock.ts)}</p>
                            </div>
                            {expected && (
                              <span
                                className={`shrink-0 rounded-full px-2.5 py-1 text-[0.625rem] font-semibold uppercase tracking-[0.16em] ${
                                  matchesExpected
                                    ? 'border border-ink bg-filled text-on-ink'
                                    : 'border border-danger bg-danger-soft text-danger'
                                }`}
                              >
                                {matchesExpected ? 'matches' : 'mismatch'}
                              </span>
                            )}
                          </div>
                          <p className="mt-3 text-sm leading-6 text-ink">
                            {knock.message || 'no note included.'}
                          </p>
                          <div className="mt-4 flex gap-2">
                            <button
                              className="flex-1 btn-primary"
                              onClick={() => approveKnock(knock.id)}
                              type="button"
                            >
                              approve
                            </button>
                            <button
                              className="flex-1 btn-ghost"
                              onClick={() => rejectKnock(knock.id)}
                              type="button"
                            >
                              reject
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---- Help / channel settings (includes Sender field, replaces /iam) ---- */}
        {showHelp && (
          <div className="modal-frame">
            <div className="modal-shell flex w-full max-w-2xl max-h-full flex-col overflow-hidden rounded-[28px]">
              <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4">
                <div>
                  <p className="text-[0.6875rem] uppercase tracking-[0.32em] text-ink-dim">channel</p>
                  <h2 className="mt-1 text-lg font-bold tracking-[-0.015em]">settings</h2>
                </div>
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowHelp(false)}
                  type="button"
                >
                  close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                <div className="rounded-[18px] border border-rule bg-surface p-5">
                  <p className="text-[0.6875rem] uppercase tracking-[0.2em] text-ink-dim">channel name</p>
                  <input
                    className="mt-2 w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-base focus:border-ink focus:outline-none"
                    placeholder={roomKind === 'chat' && roomHash ? generateRoomName(roomHash) : 'give this channel a name'}
                    value={roomNickname}
                    onChange={(e) => {
                      setRoomNickname(e.target.value);
                      if (roomHash) updateRoomNickname(roomHash, e.target.value);
                    }}
                  />
                  <p className="mt-2 text-xs leading-5 text-ink-dim">
                    stored locally. helps you tell channels apart.
                  </p>

                  <p className="mt-6 text-[0.6875rem] uppercase tracking-[0.2em] text-ink-dim">
                    your sender label
                  </p>
                  <input
                    className="mt-2 w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-base focus:border-ink focus:outline-none"
                    placeholder="no sender set"
                    value={handle}
                    maxLength={24}
                    onChange={(e) => {
                      const next = e.target.value.slice(0, 24);
                      setHandleState(next);
                      if (roomHash) {
                        setHandle(roomHash, next);
                        updateRoomHandle(roomHash, next);
                      }
                    }}
                  />
                  <p className="mt-2 text-xs leading-5 text-ink-dim">
                    shown above each message you send. stored locally.
                  </p>

                  <p className="mt-6 text-[0.6875rem] uppercase tracking-[0.2em] text-ink-dim">storage</p>
                  <p className="mt-2 text-sm leading-6 text-ink-soft">
                    messages stay on this device. clear your browser storage and they're gone here.
                  </p>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-dim">
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="https://www.hisohiso.org/"
                  >
                    what is hisohiso?
                  </a>
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="https://www.hisohiso.org/security/"
                  >
                    protocol
                  </a>
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="https://github.com/draganescu/hisohiso"
                  >
                    source
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---- Channel menu ---- */}
        {showMenu && (
          <div className="modal-frame">
            <div className="modal-shell flex w-full max-w-2xl max-h-full flex-col overflow-hidden rounded-[28px]">
              <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4">
                <div>
                  <p className="text-[0.6875rem] uppercase tracking-[0.32em] text-ink-dim">channel</p>
                  <h2 className="mt-1 text-lg font-bold tracking-[-0.015em]">menu</h2>
                </div>
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowMenu(false)}
                  type="button"
                >
                  close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                <div className="rounded-[14px] border border-rule bg-surface p-4 text-sm">
                  <p className="text-[0.6875rem] uppercase tracking-[0.2em] text-ink-dim">share link</p>
                  <p className="mt-2 break-all text-xs text-ink-soft">{shareUrl}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="btn-primary btn-sm"
                      onClick={handleCopy}
                      type="button"
                    >
                      copy link
                    </button>
                    <button
                      className="rounded-full border border-rule bg-surface px-4 py-1.5 text-xs font-medium text-ink transition hover:border-ink"
                      onClick={() => {
                        setShowQr(true);
                        setShowMenu(false);
                      }}
                      type="button"
                    >
                      show qr
                    </button>
                  </div>
                </div>

                <div className="mt-3 rounded-[14px] border border-rule bg-surface p-4">
	                  <p className="text-sm font-medium">room password</p>
	                  <p className="mt-1 text-xs leading-5 text-ink-soft">
	                    optional. people need this alongside the link to decrypt knocks and messages.
	                  </p>
	                  {userMessageCount > 0 && (
	                    <p className="mt-1 text-xs leading-5 text-danger">
	                      changing this after the room is active changes the key for future messages and joins.
	                    </p>
	                  )}
	                  <input
	                    ref={roomPasswordInputRef}
	                    className="mt-3 w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-base focus:border-ink focus:outline-none"
                    placeholder="no password"
                    type="text"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-1p-ignore=""
                    data-lpignore="true"
                    value={roomPassword}
                    onChange={(event) => updateRoomPassword(event.target.value)}
                  />
                </div>

                {pairingCodePanel}

	                <div className="mt-3 rounded-[14px] border border-rule bg-surface p-4">
	                  <p className="text-sm font-medium">expected knock phrase</p>
	                  <p className="mt-1 text-xs leading-5 text-ink-soft">
	                    optional admission phrase. incoming join requests are marked when they match.
	                  </p>
	                  <input
	                    ref={expectedKnockInputRef}
	                    className="mt-3 w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-base focus:border-ink focus:outline-none"
                    placeholder="no phrase"
                    type="text"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="sentences"
                    value={expectedKnockMessage}
                    onChange={(event) => updateExpectedKnockMessage(event.target.value)}
                  />
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] border border-rule bg-surface p-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">offline catch-up</p>
                    <p className="mt-1 text-xs leading-5 text-ink-soft">
                      server keeps encrypted messages for 24h so devices that were closed can catch up. turning off wipes them.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={catchUpEnabled}
                    disabled={catchUpBusy || !token}
                    onClick={() => void handleToggleCatchUp()}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                      catchUpEnabled ? 'bg-ink' : 'bg-overlay-soft'
                    } ${catchUpBusy || !token ? 'opacity-50' : ''}`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow transition-transform ${
                        catchUpEnabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] border border-rule bg-surface p-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">notifications</p>
                    <p className="mt-1 text-xs leading-5 text-ink-soft">
                      {pushStatus === 'unsupported'
                        ? 'not available on this browser.'
                        : pushStatus === 'denied'
                          ? 'blocked — allow notifications for this site in your browser settings.'
                          : 'get notified when this channel has new activity, even with the app closed. the alert carries no message content.'}
                    </p>
                    {pushError && <p className="mt-1.5 text-xs leading-5 text-danger">{pushError}</p>}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={pushStatus === 'on'}
                    disabled={pushBusy || !token || pushStatus === 'unsupported' || pushStatus === 'denied'}
                    onClick={() => void handleTogglePush()}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                      pushStatus === 'on' ? 'bg-ink' : 'bg-overlay-soft'
                    } ${pushBusy || !token || pushStatus === 'unsupported' || pushStatus === 'denied' ? 'opacity-50' : ''}`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow transition-transform ${
                        pushStatus === 'on' ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] border border-rule bg-surface p-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">show my live dot</p>
                    <p className="mt-1 text-xs leading-5 text-ink-soft">
                      shows a small dot in the header reflecting <span className="font-medium">your own</span> connection to this channel — lime when you're live, muted when not. it's not a presence or read-receipt signal: nothing is sent to anyone and it tells you nothing about who else is here. off by default, stored on this device only.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={presence.enabled}
                    onClick={() => presence.toggle()}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                      presence.enabled ? 'bg-ink' : 'bg-overlay-soft'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow transition-transform ${
                        presence.enabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] border border-rule bg-surface p-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">auto-approve joins</p>
                    <p className="mt-1 text-xs leading-5 text-ink-soft">
                      on this device, accepts a join the moment the requester has <span className="font-medium">proven</span> they hold this channel's link{roomPassword.trim() ? <> <span className="font-medium">and</span> key</> : ''} — no tap needed. it never adds an identity check; it only skips the manual approve for people who already hold the joining secret. a per-device convenience, not a channel rule — only this device auto-approves, and only while it's online. off by default.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoApprove.enabled}
                    disabled={!token}
                    onClick={() => autoApprove.toggle()}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                      autoApprove.enabled ? 'bg-ink' : 'bg-overlay-soft'
                    } ${!token ? 'opacity-50' : ''}`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow transition-transform ${
                        autoApprove.enabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-3 flex flex-col gap-2 rounded-[14px] border border-rule bg-surface p-4">
                  <a
                    href="/rooms"
                    className="btn-ghost"
                  >
                    your rooms
                  </a>

                  <button
                    className="btn-ghost"
                    onClick={() => {
                      setShowLeave(true);
                      setShowMenu(false);
                    }}
                    type="button"
                  >
                    leave channel
                  </button>

                  <button
                    className="btn-danger"
                    onClick={() => {
                      setShowDisband(true);
                      setShowMenu(false);
                    }}
                    type="button"
                  >
                    disband channel
                  </button>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-dim">
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="https://www.hisohiso.org/"
                  >
                    what is hisohiso?
                  </a>
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="https://www.hisohiso.org/security/"
                  >
                    protocol
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---- Channel switcher ---- */}
        {showSwitcher && (
          <div className="modal-frame">
            <div className="modal-shell flex w-full max-w-2xl max-h-full flex-col overflow-hidden rounded-[28px]">
              <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4">
                <div>
                  <p className="text-[0.6875rem] uppercase tracking-[0.32em] text-ink-dim">switch</p>
                  <h2 className="mt-1 text-lg font-bold tracking-[-0.015em]">channels</h2>
                </div>
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowSwitcher(false)}
                  type="button"
                >
                  close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                {allRooms.length === 0 ? (
                  <div className="rounded-[18px] border border-dashed border-rule bg-surface p-8 text-center">
                    <p className="text-base font-semibold">no rooms yet.</p>
                    <p className="mt-2 text-sm text-ink-soft">
                      open one or paste a link from /rooms.
                    </p>
                  </div>
                ) : (
                  (() => {
                    const { groups, orphanAgents, hasAny } = groupOpenChannels(allRooms);
                    const chats = allRooms.filter((r) => r.kind === 'chat');
                    const switcherRow = (r: StoredRoom) => {
                      const isCurrent = r.roomHash === roomHash;
                      return (
                        <RoomRow
                          key={r.roomHash}
                          room={r}
                          isCurrent={isCurrent}
                          onSelect={() => {
                            // Close the switcher synchronously, in the same
                            // event batch as the navigation. Leaving it open and
                            // relying on the async room-init effect to clear it
                            // (RoomController init) keeps `scroll-locked` on for
                            // a render while the new room hydrates, so main.tsx's
                            // scrollTo(0,0) fights the room-switch foot-pin and
                            // wins — landing on the oldest message (#221). The
                            // gap is widest on human<->agent switches whose late
                            // header/context layout fires extra viewport events.
                            setShowSwitcher(false);
                            if (isCurrent) return;
                            navigateToRoom(r.roomSecret);
                          }}
                        />
                      );
                    };
                    return (
                      <div className="flex flex-col gap-4">
                        {hasAny && (
                          <div className="flex flex-col gap-3 rounded-[14px] border border-rule bg-surface p-2">
                            <GroupedChannelList
                              groups={groups}
                              orphanAgents={orphanAgents}
                              renderRow={switcherRow}
                            />
                          </div>
                        )}
                        {chats.length > 0 && (
                          <div className="flex flex-col gap-1.5 rounded-[14px] border border-rule bg-surface p-2">
                            {hasAny && (
                              <p className="px-1 text-[0.625rem] font-semibold uppercase tracking-[0.32em] text-ink-dim">
                                conversations
                              </p>
                            )}
                            {chats.map(switcherRow)}
                          </div>
                        )}
                      </div>
                    );
                  })()
                )}

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <a
                    href="/new"
                    className="flex-1 text-center no-underline btn-primary"
                  >
                    open a channel
                  </a>
                  <a
                    href="/rooms"
                    className="flex-1 btn-ghost"
                  >
                    all channels
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---- Disband (destructive) ---- */}
        {showDisband && (
          <div className="room-overlay fixed inset-x-0 top-0 z-40 flex h-[100dvh] items-center justify-center bg-black/60 px-6">
            <div className="w-full max-w-sm rounded-[22px] border border-danger bg-surface p-6 text-ink shadow-[0_20px_50px_-10px_rgba(10,10,10,0.4)]">
              <p className="text-[0.6875rem] uppercase tracking-[0.28em] text-danger">destructive</p>
              <h2 className="mt-2 text-xl font-bold tracking-[-0.015em]">
                disband this channel?
              </h2>
              <p className="mt-3 text-sm leading-6 text-ink-soft">
                this deletes the channel everywhere, for everyone — not just on this device. all
                members are disconnected and the room is gone from the server. cannot be undone.
              </p>
              <div className="mt-6 flex gap-3">
                <button
                  className="flex-1 btn-ghost"
                  onClick={() => setShowDisband(false)}
                  type="button"
                >
                  cancel
                </button>
                <button
                  className="flex-1 rounded-full border border-danger bg-danger px-4 py-2 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-danger"
                  onClick={() => {
                    setShowDisband(false);
                    void disbandRoom();
                  }}
                  type="button"
                >
                  disband
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---- Leave (recoverable) ---- */}
        {showLeave && (
          <div className="room-overlay fixed inset-x-0 top-0 z-40 flex h-[100dvh] items-center justify-center bg-black/60 px-6">
            <div className="w-full max-w-sm rounded-[22px] border border-rule bg-surface p-6 text-ink shadow-[0_20px_50px_-10px_rgba(10,10,10,0.4)]">
              <h2 className="text-xl font-bold tracking-[-0.015em]">leave this channel?</h2>
              <p className="mt-3 text-sm leading-6 text-ink-soft">
                you're removed and this channel is wiped from this device only. the channel stays
                open for everyone else — open the link again to rejoin.
              </p>
              <div className="mt-6 flex gap-3">
                <button
                  className="flex-1 btn-ghost"
                  onClick={() => setShowLeave(false)}
                  type="button"
                >
                  cancel
                </button>
                <button
                  className="flex-1 btn-primary"
                  onClick={() => {
                    setShowLeave(false);
                    void leaveRoom();
                  }}
                  type="button"
                >
                  leave
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    );
  }

  // Pre / post participant states
  return (
    <main className="app-page app-chrome text-ink">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-16">
        <header>
          <p className="text-[0.6875rem] uppercase tracking-[0.35em] text-ink-dim">hisohiso</p>
        </header>

        {roomState === 'INIT' && (
          <div className="glass-panel rounded-[28px] p-8">
            <p className="text-sm uppercase tracking-[0.32em] text-ink-dim">opening channel…</p>
          </div>
        )}

        {roomState === 'LOBBY_WAITING' && (
          <div className="glass-panel rounded-[28px] p-8">
            <h1 className="text-3xl font-bold tracking-[-0.025em]">join this channel.</h1>
            <p className="mt-3 text-ink-soft">ask to be let in. someone inside has to approve you.</p>

            <input
              className="input-field mt-6 w-full rounded-[14px] px-3 py-2.5 text-base"
              placeholder="channel key or pairing code"
              type="text"
              name="room-key"
              autoComplete="one-time-code"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              value={roomPassword}
              onChange={(event) => updateRoomPassword(event.target.value)}
            />
            <p className="mt-2 text-xs text-ink-dim">
              saved on this device. used to encrypt your knock and chat messages.
            </p>

            <textarea
              className="input-field mt-4 w-full rounded-[14px] px-3 py-2.5 text-base"
              placeholder="optional note (e.g. who you are)"
              rows={3}
              autoCorrect="off"
              autoCapitalize="sentences"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                className="btn-primary"
                onClick={sendKnock}
                type="button"
              >
                request to join
              </button>
              <a
                className="rounded-full border border-rule bg-surface px-5 py-2.5 text-center text-sm font-medium text-ink transition hover:border-ink"
                href="/rooms"
              >
                your rooms
              </a>
            </div>

            {(knockSent || knockNotice) && (
              <p className="mt-5 text-xs uppercase tracking-[0.28em] text-ink-dim">
                {knockNotice || 'waiting for approval…'}
              </p>
            )}

            <p className="mt-6 text-xs text-ink-dim">
              <a
                className="underline decoration-rule underline-offset-4 hover:text-ink"
                href="https://www.hisohiso.org/"
              >
                what is hisohiso?
              </a>
            </p>
          </div>
        )}

        {roomState === 'LOBBY_EMPTY' && (
          <div className="glass-panel rounded-[28px] p-8">
            <h1 className="text-3xl font-bold tracking-[-0.025em]">all quiet.</h1>
            <p className="mt-3 text-ink-soft">
              no one is currently in this channel. ask someone inside to open it so they can approve
              you.
            </p>
            <div className="mt-6 rounded-[14px] border border-rule bg-bg p-4 text-sm">
              <p className="text-[0.6875rem] uppercase tracking-[0.2em] text-ink-dim">share link</p>
              <p className="mt-2 break-all text-ink-soft">{shareUrl}</p>
            </div>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                className="btn-primary"
                onClick={handleCopy}
                type="button"
              >
                copy link
              </button>
              <button
                className="rounded-full border border-rule bg-surface px-5 py-2.5 text-sm font-medium text-ink transition hover:border-ink"
                onClick={() => setShowQr(true)}
                type="button"
              >
                show qr
              </button>
            </div>
          </div>
        )}

        {roomState === 'DESTROYED' && (
          <div className="glass-panel rounded-[28px] p-8">
            <h1 className="text-3xl font-bold tracking-[-0.025em]">channel closed.</h1>
            <p className="mt-3 text-ink-soft">this channel was disbanded or no longer exists.</p>
            <a
              className="mt-6 inline-flex items-center justify-center btn-primary"
              href="/rooms"
            >
              your rooms
            </a>
          </div>
        )}

        {roomState === 'LEFT' && (
          <div className="glass-panel rounded-[28px] p-8">
            <h1 className="text-3xl font-bold tracking-[-0.025em]">you left this channel.</h1>
            <p className="mt-3 text-ink-soft">
              its messages were wiped from this device. the channel stays open for everyone else —
              open the link again to rejoin.
            </p>
            <a
              className="mt-6 inline-flex items-center justify-center btn-primary"
              href="/rooms"
            >
              your rooms
            </a>
          </div>
        )}

        <p className="text-xs text-ink-dim">
          <a
            className="underline decoration-rule underline-offset-4 hover:text-ink"
            href="https://www.hisohiso.org/"
          >
            what is hisohiso?
          </a>
        </p>
      </div>

      <QrModal open={showQr} onClose={() => setShowQr(false)} value={shareUrl} />
    </main>
  );
};

export default RoomController;
