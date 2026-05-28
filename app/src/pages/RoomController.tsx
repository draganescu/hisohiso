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
  clearHandle,
  clearRoomPassword,
  clearSubscriberJwt,
  clearToken,
  getHandle,
  getRoomPassword,
  getRoomColor,
  getRoomNickname,
  getSubscriberJwt,
  getToken,
  listRooms,
  setHandle,
  setRoomPassword,
  setSubscriberJwt,
  setToken,
  upsertRoom,
  removeRoom,
  updateRoomHandle,
  updateRoomNickname,
  type StoredRoom
} from '../lib/storage';
import { createRoomEventSource } from '../lib/mercure';
import { clearRoomMessages, deleteMessage, loadMessages, saveMessage, type ChatMessage, type MessageAction } from '../lib/db';
import type { Block, BlockResponse } from '../lib/blocks';
import { BlockRenderer } from '../components/blocks/BlockRenderer';
import { useMessageWindow } from '../hooks/useMessageWindow';
import QrModal from '../components/QrModal';

type RoomState = 'INIT' | 'LOBBY_WAITING' | 'LOBBY_EMPTY' | 'PARTICIPANT' | 'DESTROYED' | 'LEFT';

type RoomLookupResponse = {
  status: 'exists';
  has_participants: boolean;
  catch_up_enabled?: boolean;
};

type RoomEvent = {
  v: number;
  type: 'chat' | 'knock' | 'approve' | 'reject' | 'destroy' | 'settings' | 'token';
  room_hash: string;
  from?: string | null;
  ts: number;
  body: Record<string, unknown>;
};

type OutboxMessage = {
  msg_id: string;
  ts: number;
  sender_hash: string | null;
  encrypted_payload: string;
};

type KnockRequest = {
  id: string;
  msgId: string;
  pubkey: string;
  ts: number;
  message?: string | null;
};

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

const getMessagePreview = (content: string): string => {
  const normalized = content.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return 'Empty message';
  }
  const compact = normalized
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trimEnd())
    .join('\n');
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
};

const formatBlockResponse = (msg: ChatMessage): string | null => {
  const br = msg.block_response;
  if (!br) return null;
  const val = br.value;
  const label = Array.isArray(val) ? val.join(', ') : String(val);
  switch (br.type) {
    case 'buttons': return `Selected: ${label}`;
    case 'swipe': return `Chose: ${label}`;
    case 'slider': return `Set to: ${label}`;
    case 'checklist': return `Checked: ${label}`;
    case 'sortable': return `Order: ${label}`;
    case 'confirm-danger': return val ? 'Confirmed' : 'Cancelled';
    case 'commit': return label === 'commit' ? 'Committed' : label === 'edit' ? 'Editing' : 'Cancelled';
    case 'run-command': return label === 'run' ? 'Running command' : 'Skipped';
    default: return label;
  }
};

const getMessageLabel = (message: ChatMessage): string => {
  if (message.type === 'system') {
    return 'System';
  }
  if (message.direction === 'out') {
    return message.handle ? `${message.handle} (You)` : 'You';
  }
  return message.handle || 'Room member';
};

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showDisband, setShowDisband] = useState(false);
  const [showLeave, setShowLeave] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [headerCondensed, setHeaderCondensed] = useState(false);
  const [roomNickname, setRoomNickname] = useState<string>(() => initialContext?.roomNickname ?? '');
  const [roomColor, setRoomColor] = useState<string>(() => initialContext?.roomColor ?? '#ccc');
  const [allRooms, setAllRooms] = useState<StoredRoom[]>([]);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
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
  const [autoScroll, setAutoScroll] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasCompanion, setHasCompanion] = useState(false);
  const [emptyQrSrc, setEmptyQrSrc] = useState<string>('');
  const [catchUpEnabled, setCatchUpEnabled] = useState(false);
  const [catchUpBusy, setCatchUpBusy] = useState(false);
  // Reveal-on-tap for the pairing code in the room menu. Auto-hides after a few
  // seconds and on backgrounding so a phone left open on the menu doesn't sit
  // there broadcasting the code to anyone walking by. The code itself never
  // leaves the device — it's pulled from roomPassword (already in state from
  // localStorage); this just gates display.
  const [pairingCodeRevealed, setPairingCodeRevealed] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusProxyRef = useRef<HTMLTextAreaElement | null>(null);
  const prevCountRef = useRef(0);
  const knockKeyRef = useRef<CryptoKey | null>(null);
  // Ephemeral keypair used to receive the wrapped participant token after a
  // knock. Set right before /knock fires; consulted when the matching `token`
  // event arrives. Cleared once we upgrade to PARTICIPANT.
  const knockEphemeralRef = useRef<{ privateKey: CryptoKey; msgId: string } | null>(null);
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
  const showEmptyState = messages.length === 0 && !hasCompanion && roomState === 'PARTICIPANT';

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
    if (window.location.hash.replace(/^#\/?/, '') !== nextSecret) {
      window.location.hash = `#${nextSecret}`;
    }
    setRoomSecret(nextSecret);
  }, []);

  const joinActionRoom = useCallback(async (action: MessageAction) => {
    const nextSecret = action.roomSecret.replace(/^#\/?/, '');
    if (!nextSecret) return;

    const nextHash = await deriveRoomHash(nextSecret);
    upsertRoom(nextHash, nextSecret, null);

    const roomName = action.roomName?.trim();
    if (roomName) {
      updateRoomNickname(nextHash, roomName);
    }

    if (action.code) {
      setRoomPassword(nextHash, action.code);
    }

    navigateToRoom(nextSecret);
  }, [navigateToRoom]);

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
    clearToken(hash);
    clearSubscriberJwt(hash);
    clearHandle(hash);
    clearRoomPassword(hash);
    removeRoom(hash);
    await clearRoomMessages(hash);
    setTokenState(null);
    setTokenHash(null);
    setSubJwt(null);
    setLobbyJwt(null);
    setKnocks([]);
    setMessages([]);
    setMessage('');
    setChatInput('');
    setShowComposer(false);
    setReplyToId(null);
    setSelectedId(null);
    setRoomPasswordState('');
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

  const persistMessage = useCallback((record: ChatMessage) => {
    void saveMessage(record).catch(() => undefined);
  }, []);

  const ingestEncryptedChat = useCallback(async (
    msgId: string,
    ts: number,
    from: string | null,
    rawPayload: unknown
  ) => {
    if (!cryptoKey || !roomHash || !msgId || !rawPayload) return;
    const parsed: EncryptedPayload =
      typeof rawPayload === 'string' ? (JSON.parse(rawPayload) as EncryptedPayload) : (rawPayload as EncryptedPayload);
    const plaintext = await decryptText(cryptoKey, roomHash, 'chat', msgId, parsed);
    let messageText = plaintext;
    let messageHandle: string | null = null;
    let messageAction: MessageAction | null = null;
    let messageBlocks: Block[] | null = null;
    let messageBlockResponse: BlockResponse | null = null;
    if (plaintext.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(plaintext) as {
          text?: string;
          handle?: string | null;
          action?: MessageAction;
          blocks?: Block[];
          block_response?: BlockResponse;
        };
        if (typeof obj.text === 'string') messageText = obj.text;
        if (typeof obj.handle === 'string') messageHandle = obj.handle;
        if (obj.action && typeof obj.action === 'object' && obj.action.type === 'join-room' && typeof obj.action.roomSecret === 'string') {
          messageAction = obj.action;
        }
        if (Array.isArray(obj.blocks) && obj.blocks.length > 0) messageBlocks = obj.blocks;
        if (obj.block_response && typeof obj.block_response === 'object' && obj.block_response.block_id) {
          messageBlockResponse = obj.block_response;
        }
      } catch {
        messageText = plaintext;
      }
    }
    const direction = tokenHash && from === tokenHash ? 'out' : 'in';
    if (direction === 'in') setHasCompanion(true);
    const messageRecord: ChatMessage = {
      id: msgId,
      room_hash: roomHash,
      timestamp: ts,
      content: messageText,
      type: 'chat',
      direction,
      from: from ?? null,
      handle: messageHandle,
      action: messageAction,
      blocks: messageBlocks,
      block_response: messageBlockResponse
    };
    persistMessage(messageRecord);
    setMessages((prev) => {
      if (prev.find((item) => item.id === msgId)) return prev;
      return [...prev, messageRecord].sort((a, b) => a.timestamp - b.timestamp);
    });
  }, [cryptoKey, roomHash, tokenHash, persistMessage]);

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
      setKeyboardVisible(false);
      return;
    }

    // Transfer focus from proxy to real textarea (works on Safari because
    // the proxy already holds the user-gesture focus grant)
    requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });

    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouch || !window.visualViewport) {
      return;
    }

    const baseHeight = window.innerHeight;
    const checkKeyboard = () => {
      const visible = window.visualViewport!.height < baseHeight * 0.75;
      setKeyboardVisible(visible);
    };

    checkKeyboard();
    window.visualViewport.addEventListener('resize', checkKeyboard);
    return () => {
      window.visualViewport?.removeEventListener('resize', checkKeyboard);
    };
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
          setKnocks([]);
          setMessages([]);
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
          setHasCompanion(false);
          setEmptyQrSrc('');
          setCatchUpEnabled(false);
          setRoomPasswordState('');
          knockEphemeralRef.current = null;
          claimTagRef.current = null;
        }

        const hash = skipReset ? initialContext!.roomHash : await deriveRoomHash(roomSecret);
        if (!active) return;
        setRoomHash(hash);
        const localMessages = await loadMessages(hash);
        if (!active) return;
        setMessages(localMessages);
        const savedHandle = getHandle(hash);
        const savedRoomPassword = getRoomPassword(hash);
        setHandleState(savedHandle ?? '');
        setRoomPasswordState(savedRoomPassword ?? '');
        setRoomColor(getRoomColor(hash));
        setRoomNickname(getRoomNickname(hash) ?? '');

        const existingToken = getToken(hash);
        if (existingToken) {
          const presenceResponse = await fetch(`/api/rooms/${hash}/presence`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Chat-Token': existingToken
            },
            signal
          });
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
              const subRes = await fetch(`/api/rooms/${hash}/sub-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Chat-Token': existingToken },
                signal
              });
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

        const response = await fetch(`/api/rooms/${hash}`, { signal });
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
        setError(err instanceof Error ? err.message : 'Unable to load room');
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

  useEffect(() => {
    if (roomState === 'PARTICIPANT') {
      document.body.classList.add('no-scroll');
      const handleTouchMove = (event: TouchEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target) {
          return;
        }
        if (target.tagName === 'TEXTAREA') {
          return;
        }
        let el: HTMLElement | null = target;
        while (el) {
          const style = window.getComputedStyle(el);
          const overflowY = style.overflowY;
          if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
            return;
          }
          el = el.parentElement;
        }
        event.preventDefault();
      };
      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      return () => {
        document.body.classList.remove('no-scroll');
        document.removeEventListener('touchmove', handleTouchMove);
      };
    }
    document.body.classList.remove('no-scroll');
    return undefined;
  }, [roomState]);

  useEffect(() => {
    if (!roomHash) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/rooms/${roomHash}`);
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
        const payload = JSON.parse(event.data) as RoomEvent;
        if (!payload || payload.room_hash !== roomHash) {
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
          const plaintext = await decryptText(activeKnockKey, roomHash, 'knock', msgId, parsed);
          const knockMessage = plaintext.trim();
          if (!knockMessage) {
            return;
          }
          const knockId = `${payload.ts}-${msgId}`;
          setKnocks((prev) => {
            if (prev.find((item) => item.id === knockId)) {
              return prev;
            }
            return [{ id: knockId, msgId, pubkey: knockPubkey, ts: payload.ts, message: knockMessage }, ...prev];
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
          setKnockNotice('Request rejected. Try again when someone is online.');
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

    const eventTypes: RoomEvent['type'][] = ['chat', 'knock', 'approve', 'reject', 'destroy', 'settings', 'token'];
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
            const r = await fetch(`/api/rooms/${roomHash}/outbox?since_ts=${localMax}`, {
              headers: { 'X-Chat-Token': token }
            });
            if (!r.ok) return;
            const data = (await r.json()) as { messages: OutboxMessage[] };
            for (const m of data.messages) {
              await ingestEncryptedChat(m.msg_id, m.ts, m.sender_hash, m.encrypted_payload);
            }
          } catch {
            // non-fatal
          }
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
  }, [roomHash, roomState, cryptoKey, token, tokenHash, subJwt, lobbyJwt, wipeLocalRoom, ingestEncryptedChat]);

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
      setKnockNotice('Preparing encryption key…');
      return;
    }

    const msgId = base64UrlEncode(randomBytes(12));
    const knockMessage = message.trim() || 'Knock';
    try {
      const ephemeral = await generateEphemeralKeyPair();
      knockEphemeralRef.current = { privateKey: ephemeral.privateKey, msgId };
      const encrypted = await encryptText(knockKey, roomHash, 'knock', msgId, knockMessage);
      const response = await fetch(`/api/rooms/${roomHash}/knock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_id: msgId,
          encrypted_payload: JSON.stringify(encrypted),
          knock_pubkey: ephemeral.publicKey
        })
      });

      if (response.ok) {
        // Capture the lobby JWT so the SSE effect can subscribe to the room
        // topic just long enough to receive the wrapped-token event.
        const knockData = (await response.json()) as { lobby_jwt?: string };
        if (knockData.lobby_jwt) {
          setLobbyJwt(knockData.lobby_jwt);
        }
        setKnockSent(true);
        setKnockNotice('Waiting for approval…');
      } else {
        knockEphemeralRef.current = null;
        setKnockSent(false);
        setKnockNotice('Unable to send join request.');
      }
    } catch {
      knockEphemeralRef.current = null;
      setKnockSent(false);
      setKnockNotice('Unable to send join request.');
    }
  }, [roomHash, message, knockKey]);

  const approveKnock = useCallback(
    async (knockId: string) => {
      if (!roomHash || !token) {
        return;
      }
      const knock = knocks.find((item) => item.id === knockId);
      if (!knock) {
        return;
      }
      try {
        // beginApprove pre-derives the wrap material AND the claim tag from one
        // ephemeral keypair. We commit sha256(tag) on /approve so the knocker's
        // first /presence can prove it's the same client that decrypted the wrap.
        const binding = await beginApprove(knock.pubkey, knock.msgId);
        const approveRes = await fetch(`/api/rooms/${roomHash}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Chat-Token': token
          },
          body: JSON.stringify({ claim_tag_hash: binding.claimTagHash })
        });
        if (!approveRes.ok) return;
        const approveBody = (await approveRes.json()) as {
          new_participant_token?: string;
          subscriber_jwt?: string;
        };
        const newToken = approveBody.new_participant_token;
        const newSubJwt = approveBody.subscriber_jwt;
        if (!newToken || !newSubJwt) return;
        // Wrap BOTH the participant token AND the new subscriber JWT into a
        // single JSON blob — the knocker needs the JWT to subscribe to
        // Mercure once they upgrade out of the lobby.
        const bundle = JSON.stringify({ token: newToken, subscriber_jwt: newSubJwt });
        const wrapped = await binding.wrap(bundle);
        await fetch(`/api/rooms/${roomHash}/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Chat-Token': token
          },
          body: JSON.stringify({
            knock_msg_id: knock.msgId,
            approver_pubkey: wrapped.approver_pubkey,
            nonce: wrapped.nonce,
            ct: wrapped.ct
          })
        });
        setHasCompanion(true);
        setKnocks((prev) => prev.filter((item) => item.id !== knockId));
      } catch {
        // Leave the knock visible so the approver can retry.
      }
    },
    [roomHash, token, knocks]
  );

  const rejectKnock = useCallback(
    async (knockId: string) => {
      if (!roomHash || !token) {
        return;
      }
      await fetch(`/api/rooms/${roomHash}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Token': token
        }
      });
      setKnocks((prev) => prev.filter((item) => item.id !== knockId));
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
      persistMessage(record);
      setMessages((prev) => [...prev, record].sort((a, b) => a.timestamp - b.timestamp));
    },
    [roomHash, persistMessage]
  );

  const sendMessage = useCallback(async () => {
    if (!roomHash || !token || !cryptoKey || !chatInput.trim()) {
      return;
    }

    const trimmed = chatInput.trim();
    if (trimmed.startsWith('/iam')) {
      const match = trimmed.match(/^\/iam\s+(.+)/i);
      if (!match || !match[1]) {
        await addSystemMessage('Usage: /iam your_handle');
        setChatInput('');
        return;
      }
      const nextHandle = match[1].trim().slice(0, 24);
      if (!nextHandle) {
        await addSystemMessage('Handle cannot be empty.');
        setChatInput('');
        return;
      }
      setHandle(roomHash, nextHandle);
      setHandleState(nextHandle);
      updateRoomHandle(roomHash, nextHandle);
      await addSystemMessage(`Handle set to ${nextHandle}.`);
      setChatInput('');
      setShowComposer(false);
      setReplyToId(null);
      return;
    }

    upsertRoom(roomHash, roomSecret, handle || null);
    const msgId = base64UrlEncode(randomBytes(12));
    const payload = JSON.stringify({ text: trimmed, handle: handle || null });
    const encrypted = await encryptText(cryptoKey, roomHash, 'chat', msgId, payload);

    const response = await fetch(`/api/rooms/${roomHash}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Token': token
      },
      body: JSON.stringify({
        msg_id: msgId,
        encrypted_payload: JSON.stringify(encrypted)
      })
    });

    if (response.ok) {
      const messageRecord: ChatMessage = {
        id: msgId,
        room_hash: roomHash,
        timestamp: Date.now(),
        content: trimmed,
        type: 'chat',
        direction: 'out',
        from: tokenHash,
        handle: handle || null
      };
      persistMessage(messageRecord);
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
  }, [roomHash, token, cryptoKey, chatInput, tokenHash, handle, addSystemMessage, roomSecret, persistMessage]);

  const sendBlockResponse = useCallback(
    async (blockId: string, blockType: string, value: unknown) => {
      if (!roomHash || !token || !cryptoKey) return;
      const label =
        typeof value === 'string'
          ? value
          : Array.isArray(value)
          ? (value as string[]).join(', ')
          : String(value);
      const msgId = base64UrlEncode(randomBytes(12));
      const payload = JSON.stringify({
        text: `[${blockType}] ${label}`,
        handle: handle || null,
        block_response: { block_id: blockId, type: blockType, value }
      });
      const encrypted = await encryptText(cryptoKey, roomHash, 'chat', msgId, payload);
      const response = await fetch(`/api/rooms/${roomHash}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chat-Token': token },
        body: JSON.stringify({ msg_id: msgId, encrypted_payload: JSON.stringify(encrypted) })
      });
      if (response.ok) {
        const messageRecord: ChatMessage = {
          id: msgId,
          room_hash: roomHash,
          timestamp: Date.now(),
          content: `[${blockType}] ${label}`,
          type: 'chat',
          direction: 'out',
          from: tokenHash,
          handle: handle || null,
          block_response: { block_id: blockId, type: blockType, value: value as BlockResponse['value'] }
        };
        persistMessage(messageRecord);
        setMessages((prev) => {
          if (prev.find((item) => item.id === msgId)) return prev;
          return [...prev, messageRecord].sort((a, b) => a.timestamp - b.timestamp);
        });
        setSelectedId(null);
      }
    },
    [roomHash, token, cryptoKey, tokenHash, handle, persistMessage]
  );

  const disbandRoom = useCallback(async () => {
    if (!roomHash || !token) {
      return;
    }
    const response = await fetch(`/api/rooms/${roomHash}/disband`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Token': token
      }
    });
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
    const response = await fetch(`/api/rooms/${roomHash}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Token': token
      }
    });
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
      const r = await fetch(`/api/rooms/${roomHash}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chat-Token': token },
        body: JSON.stringify({ catch_up_enabled: next })
      });
      if (!r.ok) {
        setCatchUpEnabled(!next);
      }
    } catch {
      setCatchUpEnabled(!next);
    } finally {
      setCatchUpBusy(false);
    }
  }, [roomHash, token, catchUpEnabled, catchUpBusy]);

  const handleDeleteMessage = useCallback(async (id: string) => {
    await deleteMessage(id);
    setMessages((prev) => prev.filter((item) => item.id !== id));
    setSelectedId(null);
  }, []);

  const handleCopyMessage = useCallback(async (content: string) => {
    await navigator.clipboard.writeText(content);
    setSelectedId(null);
  }, []);

  const openComposer = useCallback((messageId?: string) => {
    // Focus proxy textarea synchronously to keep Safari's user-gesture trust
    focusProxyRef.current?.focus();
    setReplyToId(messageId ?? null);
    setSelectedId(null);
    setShowComposer(true);
  }, []);

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
    // Reset render window to newest BEFORE scrolling so scrollTop=0 lands on the
    // newest message rather than the visual top of whatever slice was rendered.
    jumpWindowToLatest();
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = 0;
    });
  }, [jumpWindowToLatest]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    const atTop = el.scrollTop <= 40;
    setAutoScroll(atTop);
    setHeaderCondensed(el.scrollTop > 32);
    if (atTop) {
      setUnreadCount(0);
    }
  }, []);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    if (messages.length > prevCount && !autoScroll) {
      setUnreadCount((count) => count + (messages.length - prevCount));
    }
    prevCountRef.current = messages.length;
    if (autoScroll) {
      requestAnimationFrame(scrollToLatest);
    }
  }, [messages, autoScroll, scrollToLatest]);

  // Reveal-on-tap pairing code panel for the room menu drawer. Rendered in
  // both the main and fallback menu drawers below; defining it once here keeps
  // them in sync. Only renders when a password is actually stored — peer
  // rooms with no pairing factor stay clean. The intended use is "I'm on
  // phone 1, my other phone has the room link but no code; I tap, read off
  // four digits, type them on the other phone." Auto-hide is handled by the
  // pairingCodeRevealed effect.
  const pairingCodePanel = roomPassword ? (
    <div className="mt-2 rounded-xl border border-rule bg-bg p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Pairing code</p>
          <p className="mt-1 text-xs text-ink-soft">
            Needed alongside the room link to join from another device. Read it
            off, don't share it together with the link.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPairingCodeRevealed((v) => !v)}
          className="shrink-0 rounded-full border border-ink px-3 py-1 text-xs font-semibold"
        >
          {pairingCodeRevealed ? 'Hide' : 'Show'}
        </button>
      </div>
      {pairingCodeRevealed && (
        <p className="mt-3 text-center font-mono text-2xl font-semibold tracking-[0.3em]">
          {roomPassword}
        </p>
      )}
    </div>
  ) : null;
  // ---------- Render ----------

  if (error) {
    return (
      <main className="min-h-[100dvh] bg-bg text-ink">
        <div className="mx-auto flex max-w-xl flex-col gap-5 px-6 py-16">
          <p className="text-[11px] uppercase tracking-[0.35em] text-ink-dim">hisohiso</p>
          <div className="rounded-[22px] border border-danger bg-danger-soft p-6 text-sm leading-7 text-danger">
            {error}
          </div>
          <a
            className="text-sm font-medium text-ink underline decoration-rule underline-offset-4"
            href="/rooms"
          >
            ← Your channels
          </a>
        </div>
      </main>
    );
  }

  if (roomState === 'PARTICIPANT') {
    const connectionLabel =
      connection === 'connected' ? 'Live' : connection === 'error' ? 'Reconnecting…' : 'Connecting…';
    const connectionColor =
      connection === 'connected' ? '#16a34a' : connection === 'error' ? '#b91c1c' : '#9a9a9a';

    return (
      <main className="app-shell relative text-ink">
        {/* Off-screen focus proxy. Keeps Safari's user-gesture trust when a
            click handler programmatically focuses the inline composer textarea. */}
        <textarea
          ref={focusProxyRef}
          aria-hidden="true"
          className="fixed -left-[9999px] top-0 h-0 w-0 opacity-0"
          tabIndex={-1}
        />

        {/* ---- Sticky one-row header ---- */}
        <header className="z-30 border-b border-rule bg-bg/90 backdrop-blur">
          <div className="mx-auto flex w-full max-w-[820px] items-center gap-3 px-4 py-3 sm:px-6">
            <button
              type="button"
              onClick={openSwitcher}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-rule transition hover:ring-ink"
              style={{ backgroundColor: roomColor }}
              aria-label="Switch channels"
              title="Switch channels"
            />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold tracking-[-0.015em] sm:text-lg">
                {roomNickname || 'Channel'}
              </h1>
              <p className="truncate text-xs text-ink-dim">
                {handle ? `signed as ${handle}` : 'sender not set'}
              </p>
            </div>
            <div
              className="hidden items-center gap-1.5 text-xs text-ink-dim sm:flex"
              title={connectionLabel}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: connectionColor }}
                aria-hidden="true"
              />
              <span>{connectionLabel}</span>
            </div>
            <span
              className="inline-block h-1.5 w-1.5 rounded-full sm:hidden"
              style={{ backgroundColor: connectionColor }}
              aria-label={connectionLabel}
              title={connectionLabel}
            />
            <button
              aria-label={knocks.length === 0 ? 'Open join queue' : `Open join queue, ${knocks.length} waiting`}
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-rule bg-surface text-ink transition hover:border-ink"
              onClick={() => setShowQueue(true)}
              type="button"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
                <path d="M10 17a2 2 0 0 0 4 0" />
              </svg>
              {knocks.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-[10px] font-semibold leading-tight text-on-ink">
                  {knocks.length}
                </span>
              )}
            </button>
            <button
              aria-label="Channel info"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-rule bg-surface text-ink transition hover:border-ink"
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
              className="inline-flex h-9 items-center justify-center rounded-full border border-rule bg-surface px-3.5 text-xs font-medium text-ink transition hover:border-ink"
              onClick={() => setShowMenu(true)}
              type="button"
            >
              Menu
            </button>
          </div>
        </header>

        {/* ---- Message list (newest at top — preserves windowing logic) ---- */}
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="chat-scroll relative flex-1 overflow-x-hidden overflow-y-auto"
        >
          {/* pb-28 reserves space below the last message so the floating
              Compose button doesn't cover it. */}
          <div className="mx-auto w-full max-w-[820px] px-4 pt-5 pb-28 sm:px-6 sm:pb-32">
            {showEmptyState && (
              <div className="rounded-[22px] border border-dashed border-rule bg-surface p-6 text-center sm:p-8">
                <p className="text-lg font-semibold tracking-[-0.02em] text-ink sm:text-xl">
                  Invite someone.
                </p>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-soft">
                  Share this link. Anyone with it can request to join.
                </p>

                <div className="mx-auto mt-5 flex max-w-md items-center gap-2 rounded-full border border-rule bg-bg px-3 py-1.5">
                  <p className="min-w-0 flex-1 truncate text-left text-xs text-ink-soft">{shareUrl}</p>
                  <button
                    className="shrink-0 rounded-full border border-ink bg-filled px-3 py-1 text-xs font-medium text-on-ink"
                    onClick={() => { void navigator.clipboard.writeText(shareUrl); }}
                    type="button"
                  >
                    Copy
                  </button>
                </div>

                {emptyQrSrc && (
                  <div className="mt-5 flex justify-center">
                    <img
                      src={emptyQrSrc}
                      alt="Channel QR code"
                      className="h-40 w-40 rounded-[10px] border border-rule sm:h-44 sm:w-44"
                    />
                  </div>
                )}

                <p className="mt-5 text-xs text-ink-dim">Or just start typing above.</p>
              </div>
            )}

            {!showEmptyState && visibleMessages.length === 0 && (
              <div className="rounded-[22px] border border-dashed border-rule bg-surface p-8 text-center">
                <p className="text-base font-semibold text-ink">No messages yet.</p>
                <p className="mt-2 text-sm leading-6 text-ink-soft">Start with a note.</p>
              </div>
            )}

            <div className="flex flex-col gap-3">
              {hasNewer && (
                <div ref={topSentinelRef} aria-hidden="true" className="h-px w-full shrink-0" />
              )}

              {renderedMessages.map((msg) => {
                const isSystem = msg.type === 'system';
                const isMine = msg.direction === 'out' && !isSystem;

                if (isSystem) {
                  return (
                    <div key={msg.id} className="my-1 flex justify-center">
                      <p className="rounded-full bg-bg px-3 py-1 text-[11px] text-ink-dim">
                        {getMessagePreview(msg.content)} · {formatMailStamp(msg.timestamp)}
                      </p>
                    </div>
                  );
                }

                const senderLabel = msg.handle || (isMine ? 'You' : null);
                const hasBlocks = !!(msg.blocks && msg.blocks.length > 0);

                return (
                  <div
                    key={msg.id}
                    className={`flex w-full flex-col ${isMine ? 'items-end' : 'items-start'}`}
                  >
                    {senderLabel && (
                      <p className="mb-1 px-2 text-[11px] text-ink-dim">{senderLabel}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedId(msg.id)}
                      className={`max-w-[82%] cursor-pointer rounded-[18px] px-4 py-2.5 text-left leading-6 transition-colors sm:max-w-[72%] ${
                        isMine
                          ? 'rounded-br-[6px] bg-filled text-on-ink hover:brightness-110'
                          : 'rounded-bl-[6px] border border-rule bg-surface text-ink hover:border-ink'
                      }`}
                    >
                      <p className="whitespace-pre-line break-words text-[15px]">
                        {msg.block_response ? (
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
                          className={`mt-2 inline-block rounded-full px-3 py-1 text-[11px] font-medium ${
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
                              className={`text-[11px] font-mono ${
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
                      className={`mt-1 flex items-center gap-2 px-2 text-[10px] text-ink-dim ${
                        isMine ? 'flex-row-reverse' : ''
                      }`}
                    >
                      <span>{formatMailStamp(msg.timestamp)}</span>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        className="hover:text-ink"
                        onClick={() => openComposer(msg.id)}
                      >
                        Reply
                      </button>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        className="hover:text-ink"
                        onClick={() => void handleCopyMessage(msg.content)}
                      >
                        Copy
                      </button>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        className="hover:text-danger"
                        onClick={() => void handleDeleteMessage(msg.id)}
                      >
                        Delete
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

        {/* Unread-on-scroll pill. Pinned to the viewport (above the floating
            Compose button) instead of sticky inside the scroll container — the
            list is reverse-chronological, so a sticky-bottom element would
            naturally sit far below the viewport when the user is anywhere near
            the newest messages and never get pulled into view. */}
        {!autoScroll && unreadCount > 0 && (
          <button
            className="fixed bottom-20 left-1/2 z-30 -translate-x-1/2 inline-flex items-center gap-2 rounded-full border border-ink bg-filled px-4 py-2 text-xs font-medium text-on-ink shadow-[0_8px_24px_-4px_rgba(10,10,10,0.3)]"
            onClick={() => {
              scrollToLatest();
              setAutoScroll(true);
              setUnreadCount(0);
            }}
            type="button"
          >
            ↑ {unreadCount} new
          </button>
        )}

        {/* ---- Floating Compose trigger ----
            Opens the full-screen composer below. We can't pin a normal
            inline composer to the top of the soft keyboard on iOS/Android
            PWAs (no API anchors anything to the keyboard); the modal
            sidesteps that by being the viewport while the keyboard is up. */}
        <button
          className="fixed bottom-4 left-4 right-4 z-30 rounded-full border border-ink bg-filled px-5 py-3.5 text-sm font-medium text-on-ink shadow-[0_12px_28px_-8px_rgba(10,10,10,0.4)] transition hover:bg-transparent hover:text-ink sm:bottom-6 sm:left-auto sm:right-6 sm:w-auto"
          onClick={() => openComposer()}
          type="button"
        >
          {replyTarget ? 'Continue reply' : 'Compose'}
        </button>

        {/* ---- Full-screen modal composer ---- */}
        {showComposer && (
          <div className="composer-overlay fixed inset-x-0 top-0 z-50 bg-bg text-ink md:inset-0 md:bg-overlay md:px-5 md:py-6">
            <div className="mx-auto flex h-full w-full flex-col bg-bg md:max-w-3xl md:overflow-hidden md:rounded-[22px] md:border md:border-rule md:bg-surface md:shadow-[0_28px_70px_-20px_rgba(10,10,10,0.35)]">
              {/* Header collapses while the keyboard is up so the textarea
                  gets as much vertical room as possible. */}
              <div
                className={`flex items-center justify-between px-4 transition-all duration-200 ease-out ${
                  keyboardVisible ? 'bg-transparent py-2' : 'border-b border-rule bg-surface py-3 sm:py-4'
                }`}
              >
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={closeComposer}
                  type="button"
                >
                  Cancel
                </button>
                <p
                  className={`text-sm font-semibold tracking-[-0.015em] transition-opacity duration-200 ${
                    keyboardVisible ? 'opacity-0' : 'opacity-100'
                  }`}
                >
                  {replyTarget ? 'Reply' : 'New message'}
                </p>
                <button
                  className="rounded-full border border-ink bg-filled px-4 py-1.5 text-xs font-medium text-on-ink transition hover:bg-transparent hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-filled disabled:hover:text-on-ink"
                  onClick={() => void sendMessage()}
                  type="button"
                  disabled={!chatInput.trim()}
                >
                  Send
                </button>
              </div>

              <div
                className={`composer-scroll flex min-h-0 flex-1 flex-col px-4 transition-all duration-200 ease-out sm:px-6 ${
                  keyboardVisible ? 'py-1' : 'py-4 sm:py-5'
                }`}
              >
                <div
                  className={`flex items-start justify-between gap-3 overflow-hidden transition-all duration-200 ease-out ${
                    keyboardVisible ? 'max-h-0 opacity-0' : 'max-h-16 opacity-100'
                  }`}
                >
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-ink-dim">From</p>
                    <p className="mt-1 text-base font-medium text-ink">{handle || 'You'}</p>
                  </div>
                </div>

                {replyTarget && (
                  <div
                    className={`overflow-hidden rounded-[12px] border border-rule bg-bg px-3 transition-all duration-200 ease-out ${
                      keyboardVisible ? 'mb-2 max-h-10 py-1.5' : 'mt-4 max-h-40 py-3'
                    }`}
                  >
                    <p
                      className={`transition-all duration-200 ${
                        keyboardVisible ? 'hidden' : 'text-[10px] uppercase tracking-[0.2em] text-ink-dim'
                      }`}
                    >
                      Replying to
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

                <div className={`flex min-h-0 flex-1 flex-col transition-all duration-200 ease-out ${keyboardVisible ? 'mt-0' : 'mt-4'}`}>
                  <textarea
                    ref={composerInputRef}
                    className="block min-h-[6rem] w-full flex-1 resize-none overflow-y-auto border-0 bg-transparent pr-2 text-[17px] leading-7 text-ink outline-none"
                    placeholder="Write a message…"
                    value={chatInput}
                    onChange={(event) => {
                      setChatInput(event.target.value);
                      requestAnimationFrame(() => {
                        const ta = composerInputRef.current;
                        if (ta) ta.scrollTop = ta.scrollHeight - ta.clientHeight;
                      });
                    }}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        <QrModal open={showQr} onClose={() => setShowQr(false)} value={shareUrl} />

        {/* ---- Message detail ---- */}
        {activeMessage && (
          <div className="fixed inset-x-0 top-0 z-50 flex h-[100dvh] flex-col bg-bg text-ink">
            <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
              <button
                className="text-sm font-medium text-ink-soft hover:text-ink"
                onClick={() => setSelectedId(null)}
                type="button"
              >
                Back
              </button>
              <p className="text-sm font-semibold">
                {activeMessage.direction === 'out' ? 'Sent message' : 'Message'}
              </p>
              <button
                className="text-sm font-medium text-ink-soft hover:text-ink"
                onClick={() => openComposer(activeMessage.id)}
                type="button"
              >
                Reply
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-6">
              <div className="mx-auto flex max-w-2xl flex-col gap-4">
                <div className="flex items-baseline justify-between gap-3 text-xs text-ink-dim">
                  <span>{getMessageLabel(activeMessage)}</span>
                  <span>{formatMailStamp(activeMessage.timestamp)}</span>
                </div>

                <article
                  className={`rounded-[18px] px-5 py-4 leading-7 ${
                    activeMessage.direction === 'out'
                      ? 'bg-filled text-on-ink'
                      : 'border border-rule bg-surface text-ink'
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words text-[15px]">
                    {activeMessage.block_response
                      ? formatBlockResponse(activeMessage) || activeMessage.content
                      : activeMessage.content || 'Empty message'}
                  </p>
                </article>

                {activeMessage.blocks && activeMessage.blocks.length > 0 && (
                  <div className="rounded-[14px] border border-rule bg-surface p-4">
                    <BlockRenderer
                      blocks={activeMessage.blocks}
                      onRespond={sendBlockResponse}
                      progressOverrides={progressOverrides}
                    />
                  </div>
                )}

                {activeMessage.action?.type === 'join-room' && (
                  <div className="flex flex-col items-start gap-2">
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded-full border border-ink bg-filled px-4 py-2 text-sm font-medium text-on-ink"
                      onClick={() => {
                        if (activeMessage.action?.type === 'join-room') {
                          void joinActionRoom(activeMessage.action);
                        }
                      }}
                    >
                      {activeMessage.action.label} →
                    </button>
                    {activeMessage.action.code && (
                      <div className="text-[11px] font-mono text-ink-dim">
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
                    className="rounded-full border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:border-ink"
                    onClick={() => void handleCopyMessage(activeMessage.content)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-danger bg-surface px-4 py-2 text-sm font-medium text-danger transition hover:bg-danger-soft"
                    onClick={() => void handleDeleteMessage(activeMessage.id)}
                  >
                    Delete local copy
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---- Knock queue ---- */}
        {showQueue && (
          <div className="fixed inset-x-0 top-0 z-40 h-[100dvh] bg-overlay px-4 pt-[env(safe-area-inset-top)]">
            <div className="mx-auto mt-6 flex h-[calc(100dvh-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[22px] border border-rule bg-bg shadow-[0_24px_60px_-20px_rgba(10,10,10,0.3)]">
              <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.32em] text-ink-dim">Notifications</p>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.015em]">Join queue</h2>
                </div>
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowQueue(false)}
                  type="button"
                >
                  Close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                {knocks.length === 0 && (
                  <div className="rounded-[22px] border border-dashed border-rule bg-surface p-8 text-center">
                    <p className="text-base font-semibold">No one is waiting.</p>
                    <p className="mt-2 text-sm text-ink-soft">
                      New join requests appear here. The bell badge lights up when someone knocks.
                    </p>
                  </div>
                )}
                {knocks.length > 0 && (
                  <div className="grid gap-3">
                    {knocks.map((knock) => (
                      <div
                        key={knock.id}
                        className="rounded-[18px] border border-rule bg-surface p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-ink">Join request</p>
                            <p className="mt-0.5 text-xs text-ink-dim">{formatMailStamp(knock.ts)}</p>
                          </div>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-ink">
                          {knock.message || 'No note included.'}
                        </p>
                        <div className="mt-4 flex gap-2">
                          <button
                            className="flex-1 rounded-full border border-ink bg-filled px-4 py-2 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
                            onClick={() => approveKnock(knock.id)}
                            type="button"
                          >
                            Approve
                          </button>
                          <button
                            className="flex-1 rounded-full border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:border-ink"
                            onClick={() => rejectKnock(knock.id)}
                            type="button"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---- Help / channel settings (includes Sender field, replaces /iam) ---- */}
        {showHelp && (
          <div className="fixed inset-x-0 top-0 z-40 h-[100dvh] bg-overlay px-4 pt-[env(safe-area-inset-top)]">
            <div className="mx-auto mt-6 flex h-[calc(100dvh-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[22px] border border-rule bg-bg shadow-[0_24px_60px_-20px_rgba(10,10,10,0.3)]">
              <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.32em] text-ink-dim">Channel</p>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.015em]">Settings</h2>
                </div>
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowHelp(false)}
                  type="button"
                >
                  Close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                <div className="rounded-[18px] border border-rule bg-surface p-5">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-ink-dim">Channel name</p>
                  <input
                    className="mt-2 w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-base focus:border-ink focus:outline-none"
                    placeholder="Give this channel a name"
                    value={roomNickname}
                    onChange={(e) => {
                      setRoomNickname(e.target.value);
                      if (roomHash) updateRoomNickname(roomHash, e.target.value);
                    }}
                  />
                  <p className="mt-2 text-xs leading-5 text-ink-dim">
                    Stored locally. Helps you tell channels apart.
                  </p>

                  <p className="mt-6 text-[11px] uppercase tracking-[0.2em] text-ink-dim">
                    Your sender label
                  </p>
                  <input
                    className="mt-2 w-full rounded-[10px] border border-rule bg-surface px-3 py-2 text-base focus:border-ink focus:outline-none"
                    placeholder="No sender set"
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
                    Shown above each message you send. Stored locally.
                  </p>

                  <p className="mt-6 text-[11px] uppercase tracking-[0.2em] text-ink-dim">Storage</p>
                  <p className="mt-2 text-sm leading-6 text-ink-soft">
                    Messages stay on this device. Clear your browser storage and they're gone here.
                  </p>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-dim">
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="/"
                  >
                    What is hisohiso?
                  </a>
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="/security/"
                  >
                    Protocol
                  </a>
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="https://github.com/draganescu/hisohiso"
                  >
                    Source
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---- Channel menu ---- */}
        {showMenu && (
          <div className="fixed inset-x-0 top-0 z-40 h-[100dvh] bg-overlay px-4 pt-[env(safe-area-inset-top)]">
            <div className="mx-auto mt-6 flex h-[calc(100dvh-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[22px] border border-rule bg-bg shadow-[0_24px_60px_-20px_rgba(10,10,10,0.3)]">
              <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.32em] text-ink-dim">Channel</p>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.015em]">Menu</h2>
                </div>
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowMenu(false)}
                  type="button"
                >
                  Close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                <div className="rounded-[14px] border border-rule bg-surface p-4 text-sm">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-ink-dim">Share link</p>
                  <p className="mt-2 break-all text-xs text-ink-soft">{shareUrl}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="rounded-full border border-ink bg-filled px-4 py-1.5 text-xs font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
                      onClick={handleCopy}
                      type="button"
                    >
                      Copy link
                    </button>
                    <button
                      className="rounded-full border border-rule bg-surface px-4 py-1.5 text-xs font-medium text-ink transition hover:border-ink"
                      onClick={() => {
                        setShowQr(true);
                        setShowMenu(false);
                      }}
                      type="button"
                    >
                      Show QR
                    </button>
                  </div>
                </div>

                {pairingCodePanel}

                <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] border border-rule bg-surface p-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Offline catch-up</p>
                    <p className="mt-1 text-xs leading-5 text-ink-soft">
                      Server keeps encrypted messages for 24h so devices that were closed can catch up. Turning off wipes them.
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

                <div className="mt-3 flex flex-col gap-2 rounded-[14px] border border-rule bg-surface p-4">
                  <a
                    href="/rooms"
                    className="rounded-full border border-rule bg-surface px-4 py-2 text-center text-sm font-medium text-ink no-underline transition hover:border-ink"
                  >
                    Your channels
                  </a>

                  <button
                    className="rounded-full border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:border-ink"
                    onClick={() => {
                      setShowLeave(true);
                      setShowMenu(false);
                    }}
                    type="button"
                  >
                    Leave channel
                  </button>

                  <button
                    className="rounded-full border border-danger bg-surface px-4 py-2 text-sm font-medium text-danger transition hover:bg-danger-soft"
                    onClick={() => {
                      setShowDisband(true);
                      setShowMenu(false);
                    }}
                    type="button"
                  >
                    Disband channel
                  </button>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-dim">
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="/"
                  >
                    What is hisohiso?
                  </a>
                  <a
                    className="font-medium text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
                    href="/security/"
                  >
                    Protocol
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---- Channel switcher ---- */}
        {showSwitcher && (
          <div className="fixed inset-x-0 top-0 z-40 h-[100dvh] bg-overlay px-4 pt-[env(safe-area-inset-top)]">
            <div className="mx-auto mt-6 flex h-[calc(100dvh-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[22px] border border-rule bg-bg shadow-[0_24px_60px_-20px_rgba(10,10,10,0.3)]">
              <div className="flex items-center justify-between border-b border-rule bg-surface px-5 py-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.32em] text-ink-dim">Switch</p>
                  <h2 className="mt-1 text-lg font-semibold tracking-[-0.015em]">Channels</h2>
                </div>
                <button
                  className="text-sm font-medium text-ink-soft hover:text-ink"
                  onClick={() => setShowSwitcher(false)}
                  type="button"
                >
                  Close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                {allRooms.length === 0 ? (
                  <div className="rounded-[18px] border border-dashed border-rule bg-surface p-8 text-center">
                    <p className="text-base font-semibold">No channels yet.</p>
                    <p className="mt-2 text-sm text-ink-soft">
                      Open one or paste a link from /rooms.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1 rounded-[14px] border border-rule bg-surface p-2">
                    {allRooms.map((r) => {
                      const isCurrent = r.roomHash === roomHash;
                      return (
                        <button
                          key={r.roomHash}
                          type="button"
                          onClick={() => {
                            if (isCurrent) {
                              setShowSwitcher(false);
                              return;
                            }
                            navigateToRoom(r.roomSecret);
                          }}
                          className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors ${
                            isCurrent
                              ? 'bg-filled text-on-ink'
                              : 'text-ink hover:bg-bg'
                          }`}
                        >
                          <div
                            className="h-3 w-3 shrink-0 rounded-full"
                            style={{ backgroundColor: r.color || 'var(--ink-fade)' }}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {r.nickname || 'Unnamed channel'}
                            </p>
                            {r.handle && (
                              <p
                                className={`truncate text-xs ${
                                  isCurrent ? 'text-ink-fade' : 'text-ink-dim'
                                }`}
                              >
                                {r.handle}
                              </p>
                            )}
                          </div>
                          {isCurrent && (
                            <span className="text-[10px] uppercase tracking-[0.2em] text-ink-fade">
                              current
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <a
                    href="/new"
                    className="flex-1 rounded-full border border-ink bg-filled px-4 py-2 text-center text-sm font-medium text-on-ink no-underline transition hover:bg-transparent hover:text-ink"
                  >
                    Open a channel
                  </a>
                  <a
                    href="/rooms"
                    className="flex-1 rounded-full border border-rule bg-surface px-4 py-2 text-center text-sm font-medium text-ink no-underline transition hover:border-ink"
                  >
                    All channels
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---- Disband (destructive) ---- */}
        {showDisband && (
          <div className="fixed inset-x-0 top-0 z-40 flex h-[100dvh] items-center justify-center bg-black/60 px-6">
            <div className="w-full max-w-sm rounded-[22px] border border-danger bg-surface p-6 text-ink shadow-[0_20px_50px_-10px_rgba(10,10,10,0.4)]">
              <p className="text-[11px] uppercase tracking-[0.28em] text-danger">Destructive</p>
              <h2 className="mt-2 text-xl font-semibold tracking-[-0.015em]">
                Disband this channel?
              </h2>
              <p className="mt-3 text-sm leading-6 text-ink-soft">
                Removes the channel from the server. Everyone is disconnected. Cannot be undone.
              </p>
              <div className="mt-6 flex gap-3">
                <button
                  className="flex-1 rounded-full border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:border-ink"
                  onClick={() => setShowDisband(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="flex-1 rounded-full border border-danger bg-danger px-4 py-2 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-danger"
                  onClick={() => {
                    setShowDisband(false);
                    void disbandRoom();
                  }}
                  type="button"
                >
                  Disband
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---- Leave (recoverable) ---- */}
        {showLeave && (
          <div className="fixed inset-x-0 top-0 z-40 flex h-[100dvh] items-center justify-center bg-black/60 px-6">
            <div className="w-full max-w-sm rounded-[22px] border border-rule bg-surface p-6 text-ink shadow-[0_20px_50px_-10px_rgba(10,10,10,0.4)]">
              <h2 className="text-xl font-semibold tracking-[-0.015em]">Leave this channel?</h2>
              <p className="mt-3 text-sm leading-6 text-ink-soft">
                You're removed and the messages on this device are wiped. The channel stays open for
                everyone else — open the link again to rejoin.
              </p>
              <div className="mt-6 flex gap-3">
                <button
                  className="flex-1 rounded-full border border-rule bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:border-ink"
                  onClick={() => setShowLeave(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="flex-1 rounded-full border border-ink bg-filled px-4 py-2 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
                  onClick={() => {
                    setShowLeave(false);
                    void leaveRoom();
                  }}
                  type="button"
                >
                  Leave
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
    <main className="min-h-[100dvh] bg-bg text-ink">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-16">
        <header>
          <p className="text-[11px] uppercase tracking-[0.35em] text-ink-dim">hisohiso</p>
        </header>

        {roomState === 'INIT' && (
          <div className="rounded-[22px] border border-rule bg-surface p-8">
            <p className="text-sm uppercase tracking-[0.32em] text-ink-dim">Opening channel…</p>
          </div>
        )}

        {roomState === 'LOBBY_WAITING' && (
          <div className="rounded-[22px] border border-rule bg-surface p-8">
            <h1 className="text-3xl font-semibold tracking-[-0.025em]">Join this channel.</h1>
            <p className="mt-3 text-ink-soft">Ask to be let in. Someone inside has to approve you.</p>

            <input
              className="mt-6 w-full rounded-[10px] border border-rule bg-surface px-3 py-2.5 text-base focus:border-ink focus:outline-none"
              placeholder="Channel key or pairing code"
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
              Saved on this device. Used to encrypt your knock and chat messages.
            </p>

            <textarea
              className="mt-4 w-full rounded-[10px] border border-rule bg-surface px-3 py-2.5 text-base focus:border-ink focus:outline-none"
              placeholder="Optional note (e.g. who you are)"
              rows={3}
              autoCorrect="off"
              autoCapitalize="sentences"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                className="rounded-full border border-ink bg-filled px-5 py-2.5 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
                onClick={sendKnock}
                type="button"
              >
                Request to join
              </button>
              <a
                className="rounded-full border border-rule bg-surface px-5 py-2.5 text-center text-sm font-medium text-ink transition hover:border-ink"
                href="/rooms"
              >
                Your channels
              </a>
            </div>

            {(knockSent || knockNotice) && (
              <p className="mt-5 text-xs uppercase tracking-[0.28em] text-ink-dim">
                {knockNotice || 'Waiting for approval…'}
              </p>
            )}

            <p className="mt-6 text-xs text-ink-dim">
              <a
                className="underline decoration-rule underline-offset-4 hover:text-ink"
                href="/"
              >
                What is hisohiso?
              </a>
            </p>
          </div>
        )}

        {roomState === 'LOBBY_EMPTY' && (
          <div className="rounded-[22px] border border-rule bg-surface p-8">
            <h1 className="text-3xl font-semibold tracking-[-0.025em]">Channel quiet.</h1>
            <p className="mt-3 text-ink-soft">
              No one is currently in this channel. Ask someone inside to open it so they can approve
              you.
            </p>
            <div className="mt-6 rounded-[14px] border border-rule bg-bg p-4 text-sm">
              <p className="text-[11px] uppercase tracking-[0.2em] text-ink-dim">Share link</p>
              <p className="mt-2 break-all text-ink-soft">{shareUrl}</p>
            </div>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                className="rounded-full border border-ink bg-filled px-5 py-2.5 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
                onClick={handleCopy}
                type="button"
              >
                Copy link
              </button>
              <button
                className="rounded-full border border-rule bg-surface px-5 py-2.5 text-sm font-medium text-ink transition hover:border-ink"
                onClick={() => setShowQr(true)}
                type="button"
              >
                Show QR
              </button>
            </div>
          </div>
        )}

        {roomState === 'DESTROYED' && (
          <div className="rounded-[22px] border border-rule bg-surface p-8">
            <h1 className="text-3xl font-semibold tracking-[-0.025em]">Channel closed.</h1>
            <p className="mt-3 text-ink-soft">This channel was disbanded or no longer exists.</p>
            <a
              className="mt-6 inline-flex items-center justify-center rounded-full border border-ink bg-filled px-5 py-2.5 text-sm font-medium text-on-ink"
              href="/rooms"
            >
              Your channels
            </a>
          </div>
        )}

        {roomState === 'LEFT' && (
          <div className="rounded-[22px] border border-rule bg-surface p-8">
            <h1 className="text-3xl font-semibold tracking-[-0.025em]">You left this channel.</h1>
            <p className="mt-3 text-ink-soft">
              Its messages were wiped from this device. The channel stays open for everyone else —
              open the link again to rejoin.
            </p>
            <a
              className="mt-6 inline-flex items-center justify-center rounded-full border border-ink bg-filled px-5 py-2.5 text-sm font-medium text-on-ink"
              href="/rooms"
            >
              Your channels
            </a>
          </div>
        )}

        <p className="text-xs text-ink-dim">
          <a
            className="underline decoration-rule underline-offset-4 hover:text-ink"
            href="/"
          >
            What is hisohiso?
          </a>
        </p>
      </div>

      <QrModal open={showQr} onClose={() => setShowQr(false)} value={shareUrl} />
    </main>
  );
};

export default RoomController;
