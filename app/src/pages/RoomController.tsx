import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  decryptText,
  deriveKnockKey,
  deriveMessageKey,
  deriveRoomHash,
  encryptText,
  randomBytes,
  base64UrlEncode,
  sha256Hex,
  type EncryptedPayload
} from '../lib/crypto';
import {
  clearHandle,
  clearRoomPassword,
  clearToken,
  getHandle,
  getRoomPassword,
  getToken,
  setHandle,
  setRoomPassword,
  setToken,
  upsertRoom,
  removeRoom,
  updateRoomHandle
} from '../lib/storage';
import { createRoomEventSource } from '../lib/mercure';
import { clearRoomMessages, deleteMessage, loadMessages, saveMessage, type ChatMessage } from '../lib/db';
import QrModal from '../components/QrModal';

type RoomState = 'INIT' | 'LOBBY_WAITING' | 'LOBBY_EMPTY' | 'PARTICIPANT' | 'DESTROYED';

type RoomLookupResponse = {
  status: 'exists';
  has_participants: boolean;
};

type RoomEvent = {
  v: number;
  type: 'chat' | 'knock' | 'approve' | 'reject' | 'destroy';
  room_hash: string;
  from?: string | null;
  ts: number;
  body: Record<string, unknown>;
};

type KnockRequest = {
  id: string;
  ts: number;
  message?: string | null;
};

const formatMailStamp = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleString([], {
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
  const { roomSecret = '' } = useParams();
  const [roomHash, setRoomHash] = useState<string>('');
  const [roomState, setRoomState] = useState<RoomState>('INIT');
  const [error, setError] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [knockSent, setKnockSent] = useState(false);
  const [knockNotice, setKnockNotice] = useState<string>('');
  const [knocks, setKnocks] = useState<KnockRequest[]>([]);
  const [roomPassword, setRoomPasswordState] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showDisband, setShowDisband] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [headerCondensed, setHeaderCondensed] = useState(false);
  const [composerViewport, setComposerViewport] = useState<{ height: number; offsetTop: number } | null>(null);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [knockKey, setKnockKey] = useState<CryptoKey | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [tokenHash, setTokenHash] = useState<string | null>(null);
  const [handle, setHandleState] = useState<string>('');
  const [connection, setConnection] = useState<'idle' | 'connected' | 'error'>('idle');
  const [autoScroll, setAutoScroll] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  const listRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const prevCountRef = useRef(0);
  const knockKeyRef = useRef<CryptoKey | null>(null);

  const shareUrl = useMemo(() => `${window.location.origin}/${roomSecret}`, [roomSecret]);
  const visibleMessages = useMemo(() => [...messages].sort((a, b) => b.timestamp - a.timestamp), [messages]);
  const activeMessage = useMemo(() => messages.find((entry) => entry.id === selectedId) ?? null, [messages, selectedId]);
  const replyTarget = useMemo(() => messages.find((entry) => entry.id === replyToId) ?? null, [messages, replyToId]);

  const wipeLocalRoom = useCallback(async (hash: string) => {
    clearToken(hash);
    clearHandle(hash);
    clearRoomPassword(hash);
    removeRoom(hash);
    await clearRoomMessages(hash);
    setTokenState(null);
    setTokenHash(null);
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

  useEffect(() => {
    if (!showComposer) {
      setComposerViewport(null);
      return;
    }

    const updateComposerViewport = () => {
      const viewport = window.visualViewport;
      if (!viewport) {
        setComposerViewport({
          height: window.innerHeight,
          offsetTop: 0
        });
        return;
      }
      setComposerViewport({
        height: viewport.height,
        offsetTop: 0
      });
    };

    updateComposerViewport();

    window.visualViewport?.addEventListener('resize', updateComposerViewport);
    window.addEventListener('orientationchange', updateComposerViewport);

    return () => {
      window.visualViewport?.removeEventListener('resize', updateComposerViewport);
      window.removeEventListener('orientationchange', updateComposerViewport);
    };
  }, [showComposer]);

  useEffect(() => {
    if (!showComposer) {
      return;
    }

    const textarea = composerInputRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [showComposer, chatInput, composerViewport]);

  useEffect(() => {
    const init = async () => {
      try {
        const hash = await deriveRoomHash(roomSecret);
        setRoomHash(hash);
        setMessages(await loadMessages(hash));
        const savedHandle = getHandle(hash);
        const savedRoomPassword = getRoomPassword(hash);
        setHandleState(savedHandle ?? '');
        setRoomPasswordState(savedRoomPassword ?? '');

        const existingToken = getToken(hash);
        if (existingToken) {
          const presenceResponse = await fetch(`/api/rooms/${hash}/presence`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Chat-Token': existingToken
            }
          });

          if (presenceResponse.status === 404) {
            await wipeLocalRoom(hash);
            setRoomState('DESTROYED');
            return;
          }

          if (presenceResponse.ok) {
            upsertRoom(hash, roomSecret, savedHandle ?? null);
            setTokenState(existingToken);
            setTokenHash(await sha256Hex(existingToken));
            setRoomState('PARTICIPANT');
            return;
          }

          if (presenceResponse.status === 401 || presenceResponse.status === 403) {
            clearToken(hash);
            setTokenState(null);
            setTokenHash(null);
          } else {
            throw new Error(`Server responded ${presenceResponse.status}`);
          }
        }

        const response = await fetch(`/api/rooms/${hash}`);

        if (response.status === 404) {
          await wipeLocalRoom(hash);
          setRoomState('DESTROYED');
          return;
        }

        if (!response.ok) {
          throw new Error(`Server responded ${response.status}`);
        }

        const data = (await response.json()) as RoomLookupResponse;
        upsertRoom(hash, roomSecret, savedHandle ?? null);

        if (data.has_participants) {
          setRoomState('LOBBY_WAITING');
        } else {
          setRoomState('LOBBY_EMPTY');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load room');
      }
    };

    if (roomSecret) {
      void init();
    }
  }, [roomSecret, wipeLocalRoom]);

  useEffect(() => {
    if (roomState === 'PARTICIPANT') {
      document.body.classList.add('no-scroll');
      const handleTouchMove = (event: TouchEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target) {
          return;
        }
        if (target.closest('.chat-scroll')) {
          return;
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
    if (!roomHash || roomState === 'DESTROYED') {
      return;
    }

    const source = createRoomEventSource(roomHash);
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
          if (!rawPayload || !msgId) {
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
            return [{ id: knockId, ts: payload.ts, message: knockMessage }, ...prev];
          });
        }

        if (payload.type === 'approve' && payload.body?.new_participant_token) {
          if (!token) {
            const newToken = String(payload.body.new_participant_token);
            setToken(roomHash, newToken);
            setTokenState(newToken);
            setTokenHash(await sha256Hex(newToken));
            setRoomState('PARTICIPANT');
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
          const parsed: EncryptedPayload =
            typeof rawPayload === 'string' ? (JSON.parse(rawPayload) as EncryptedPayload) : (rawPayload as EncryptedPayload);
          const plaintext = await decryptText(cryptoKey, roomHash, 'chat', msgId, parsed);
          let messageText = plaintext;
          let messageHandle: string | null = null;
          if (plaintext.trim().startsWith('{')) {
            try {
              const obj = JSON.parse(plaintext) as { text?: string; handle?: string | null };
              if (typeof obj.text === 'string') {
                messageText = obj.text;
              }
              if (typeof obj.handle === 'string') {
                messageHandle = obj.handle;
              }
            } catch {
              messageText = plaintext;
            }
          }
          const direction = tokenHash && payload.from === tokenHash ? 'out' : 'in';
          const messageRecord: ChatMessage = {
            id: msgId,
            room_hash: roomHash,
            timestamp: payload.ts,
            content: messageText,
            type: 'chat',
            direction,
            from: payload.from ?? null,
            handle: messageHandle
          };
          persistMessage(messageRecord);
          setMessages((prev) => {
            if (prev.find((item) => item.id === msgId)) {
              return prev;
            }
            return [...prev, messageRecord].sort((a, b) => a.timestamp - b.timestamp);
          });
        }
      } catch (err) {
        return;
      }
    };

    const eventTypes: RoomEvent['type'][] = ['chat', 'knock', 'approve', 'reject', 'destroy'];
    eventTypes.forEach((type) => source.addEventListener(type, handleEvent));

    source.onopen = () => {
      setConnection('connected');
    };

    source.onerror = () => {
      setConnection('error');
    };

    return () => {
      eventTypes.forEach((type) => source.removeEventListener(type, handleEvent));
      source.close();
    };
  }, [roomHash, roomState, cryptoKey, token, tokenHash, wipeLocalRoom, persistMessage]);

  useEffect(() => {
    if (roomState !== 'PARTICIPANT' || !token || !roomHash) {
      return;
    }

    let active = true;

    const ping = async () => {
      if (!active) {
        return;
      }
      const response = await fetch(`/api/rooms/${roomHash}/presence`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chat-Token': token
        }
      });

      if (!active) {
        return;
      }

      if (response.status === 404) {
        active = false;
        await wipeLocalRoom(roomHash);
        setRoomState('DESTROYED');
      }
    };

    void ping();
    const interval = window.setInterval(ping, 20000);
    return () => {
      active = false;
      window.clearInterval(interval);
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
      const encrypted = await encryptText(knockKey, roomHash, 'knock', msgId, knockMessage);
      const response = await fetch(`/api/rooms/${roomHash}/knock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_id: msgId,
          encrypted_payload: JSON.stringify(encrypted)
        })
      });

      if (response.ok) {
        setKnockSent(true);
        setKnockNotice('Waiting for approval…');
      } else {
        setKnockSent(false);
        setKnockNotice('Unable to send join request.');
      }
    } catch {
      setKnockSent(false);
      setKnockNotice('Unable to send join request.');
    }
  }, [roomHash, message, knockKey]);

  const approveKnock = useCallback(
    async (knockId: string) => {
      if (!roomHash || !token) {
        return;
      }
      await fetch(`/api/rooms/${roomHash}/approve`, {
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
        timestamp: Math.floor(Date.now() / 1000),
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
        timestamp: Math.floor(Date.now() / 1000),
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

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(shareUrl);
  }, [shareUrl]);

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
    setReplyToId(messageId ?? null);
    setSelectedId(null);
    setShowComposer(true);
  }, []);

  const closeComposer = useCallback(() => {
    setShowComposer(false);
    setReplyToId(null);
  }, []);

  const scrollToLatest = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = 0;
  }, []);

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

  if (error) {
    return (
      <main className="min-h-screen bg-[#efe7d5] text-[#171613]">
        <div className="mx-auto flex max-w-xl flex-col px-6 py-16">
          <div className="rounded-2xl border border-[#b43d1f] bg-[#f7e7e1] p-6 text-sm text-[#6b2411]">
            {error}
          </div>
        </div>
      </main>
    );
  }

  if (roomState === 'PARTICIPANT') {
    return (
      <main className="app-shell relative text-[#171613] md:px-4 md:py-4 lg:px-6">
        <div className="relative mx-auto flex h-full w-full max-w-[1320px] flex-col overflow-hidden bg-[#f4efe4] md:rounded-[36px] md:border md:border-[#1716131f] md:shadow-[0_28px_90px_rgba(23,22,19,0.16)]">
          <div className="relative">
            <div
              className={`overflow-hidden px-4 transition-[max-height,padding,opacity,border-color,background-color] duration-300 ease-out sm:px-6 lg:px-8 ${
                headerCondensed
                  ? 'max-h-0 border-b border-transparent bg-transparent py-0 opacity-0'
                  : 'max-h-48 border-b border-[#1716131f] bg-gradient-to-b from-[#f9f6ee] to-[#ebe4d7] py-4 opacity-100 sm:py-5'
              }`}
            >
              <div
                className={`min-w-0 max-w-3xl pr-36 transition-[transform,opacity] duration-300 ease-out sm:pr-40 ${
                  headerCondensed ? '-translate-y-4 opacity-0' : 'translate-y-0 opacity-100'
                }`}
              >
                <p className="text-[11px] uppercase tracking-[0.35em] text-[#6a6358]">Hisohiso Mail</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Inbox</h1>
                <p className="mt-1 text-sm text-[#5a5349] sm:text-base">
                  {connection === 'connected' ? 'Live room' : connection === 'error' ? 'Reconnecting…' : 'Connecting…'}
                </p>
                <div className="mt-2 overflow-hidden">
                  <p className="text-xs uppercase tracking-[0.18em] text-[#8c7f6a]">
                    {handle ? `Signed as ${handle}` : 'Set sender with /iam name'}
                  </p>
                </div>
              </div>
            </div>

            <div
              className={`absolute right-4 z-20 flex flex-wrap items-center justify-end gap-2 transition-[top,transform] duration-300 ease-out sm:right-6 sm:gap-3 lg:right-8 ${
                headerCondensed ? 'top-2.5 sm:top-3' : 'top-4 sm:top-5'
              }`}
            >
              <button
                aria-label={knocks.length === 0 ? 'Open join queue' : `Open join queue, ${knocks.length} waiting`}
                className={`relative inline-flex items-center justify-center rounded-full border border-[#17161326] bg-white/85 text-[#332f2a] shadow-sm transition-all duration-300 hover:-translate-y-[1px] ${
                  headerCondensed ? 'h-10 w-10' : 'h-12 w-12'
                }`}
                onClick={() => setShowQueue(true)}
                type="button"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 17h5l-1.4-1.4a2 2 0 0 1-.6-1.4V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
                  <path d="M10 17a2 2 0 0 0 4 0" />
                </svg>
                {knocks.length > 0 && (
                  <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-[#d9592f] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
                    {knocks.length}
                  </span>
                )}
              </button>

              <button
                aria-label="Open help"
                className={`inline-flex items-center justify-center rounded-full border border-[#17161326] bg-white/85 text-[#332f2a] shadow-sm transition-all duration-300 hover:-translate-y-[1px] ${
                  headerCondensed ? 'h-10 w-10' : 'h-12 w-12'
                }`}
                onClick={() => setShowHelp(true)}
                type="button"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M9.6 9.2a2.6 2.6 0 1 1 4.1 2.1c-.9.6-1.7 1.1-1.7 2.2" />
                  <path d="M12 17h.01" />
                </svg>
              </button>

              <button
                className={`rounded-full border border-[#17161326] bg-white/80 font-semibold text-[#332f2a] shadow-sm transition-all duration-300 ${
                  headerCondensed ? 'px-4 py-2 text-xs sm:text-sm' : 'px-4 py-2 text-xs sm:px-5 sm:text-sm'
                }`}
                onClick={() => setShowMenu(true)}
                type="button"
              >
                Menu
              </button>
            </div>
          </div>

          <div
            ref={listRef}
            onScroll={handleScroll}
            className={`flex-1 overflow-y-auto px-4 pb-32 transition-[padding] duration-300 ease-out chat-scroll sm:px-6 lg:px-8 lg:pb-36 ${
              headerCondensed ? 'pt-16 sm:pt-[4.5rem] lg:pt-20' : 'pt-5 sm:pt-6 lg:pt-7'
            }`}
          >
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-[0.24em] text-[#8d816c]">Messages</h2>
                <span className="text-xs text-[#7a7266]">{visibleMessages.length} card{visibleMessages.length === 1 ? '' : 's'}</span>
              </div>

              {visibleMessages.length === 0 && (
                <div className="rounded-[30px] border border-dashed border-[#cdbfa8] bg-[#faf5eb] px-5 py-10 text-center shadow-[0_14px_30px_rgba(23,22,19,0.04)] sm:px-8 lg:px-10 lg:py-14">
                  <p className="text-base font-semibold text-[#171613] sm:text-xl">Inbox empty</p>
                  <p className="mt-2 text-sm leading-7 text-[#5d564d] sm:text-base">
                    Start with a note. Incoming messages and your own sent mail will collect here as separate cards.
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-3 lg:gap-4">
                {visibleMessages.map((msg) => {
                  const isSystem = msg.type === 'system';
                  const isMine = msg.direction === 'out' && !isSystem;

                  return (
                    <button
                      key={msg.id}
                      type="button"
                      onClick={() => setSelectedId(msg.id)}
                      className={`w-full rounded-[30px] border p-5 text-left shadow-[0_18px_36px_rgba(23,22,19,0.08)] transition hover:-translate-y-[1px] sm:p-6 lg:max-w-[min(100%,58rem)] ${
                        isSystem
                          ? 'border-[#e0d2bc] bg-[#fff7ea] text-[#3f3529]'
                          : isMine
                          ? 'ml-3 border-[#16233c] bg-[#1b2a46] text-[#f8f4ec] sm:ml-8 lg:ml-auto'
                          : 'mr-3 border-[#d5c8b2] bg-[#fdf9f2] text-[#171613] sm:mr-8'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className={`text-sm font-semibold ${isMine ? 'text-white' : 'text-[#171613]'}`}>{getMessageLabel(msg)}</p>
                          <p className={`mt-1 text-[11px] uppercase tracking-[0.22em] ${isMine ? 'text-[#d2ddf5]' : 'text-[#8d816c]'}`}>
                            {isSystem ? 'Room event' : isMine ? 'Sent from this device' : 'Incoming message'}
                          </p>
                        </div>
                        <div
                          className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
                            isMine
                              ? 'border-white/20 bg-white/10 text-white'
                              : 'border-[#d7ccb8] bg-[#f4ede1] text-[#6a5e4e]'
                          }`}
                        >
                          {isMine ? 'Mine' : isSystem ? 'Notice' : 'Room'}
                        </div>
                      </div>
                      <p
                        className={`mt-4 whitespace-pre-line text-base leading-7 sm:text-lg ${
                          isMine ? 'text-[#f8f4ec]' : 'text-[#2f2a24]'
                        }`}
                      >
                        {getMessagePreview(msg.content)}
                      </p>
                      <div className={`mt-4 text-xs sm:text-sm ${isMine ? 'text-[#d2ddf5]' : 'text-[#766f63]'}`}>{formatMailStamp(msg.timestamp)}</div>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          {!autoScroll && unreadCount > 0 && (
            <button
              className="absolute bottom-24 left-4 right-4 z-20 rounded-full border border-[#1716131f] bg-[#fffaf1] px-4 py-2 text-xs font-semibold text-[#171613] shadow-[0_12px_24px_rgba(23,22,19,0.12)] sm:left-auto sm:right-6 sm:w-auto"
              onClick={() => {
                scrollToLatest();
                setAutoScroll(true);
                setUnreadCount(0);
              }}
              type="button"
            >
              {unreadCount} new message{unreadCount === 1 ? '' : 's'} · Jump to latest
            </button>
          )}
        </div>

        <button
          className="fixed bottom-4 left-4 right-4 z-30 rounded-full border border-[#171613] bg-[#d9592f] px-5 py-4 text-base font-semibold text-[#fff7ee] shadow-[0_18px_40px_rgba(98,40,20,0.35)] sm:bottom-6 sm:left-auto sm:right-6 sm:w-auto sm:text-sm"
          onClick={() => openComposer()}
          type="button"
        >
          Compose
        </button>

        <QrModal open={showQr} onClose={() => setShowQr(false)} value={shareUrl} />

        {showQueue && (
          <div className="fixed inset-0 z-40 bg-[rgba(20,17,14,0.45)] px-4 py-6 text-[#171613] md:px-5">
            <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-[34px] border border-[#1716131f] bg-[#f4efe4] shadow-[0_28px_70px_rgba(23,22,19,0.18)]">
              <div className="flex items-center justify-between border-b border-[#1716131f] bg-[#f8f4eb] px-4 py-4 sm:px-6">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-[#8d816c]">Notifications</p>
                  <h2 className="mt-1 text-lg font-semibold">Join queue</h2>
                </div>
                <button className="text-sm font-semibold text-[#4f473e]" onClick={() => setShowQueue(false)} type="button">
                  Close
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
                {knocks.length === 0 && (
                  <div className="rounded-[28px] border border-dashed border-[#cdbfa8] bg-[#faf5eb] px-5 py-10 text-center shadow-[0_14px_30px_rgba(23,22,19,0.04)]">
                    <p className="text-base font-semibold">No one is waiting</p>
                    <p className="mt-2 text-sm leading-7 text-[#5d564d]">
                      New join requests will appear here. The bell badge will light up when someone knocks.
                    </p>
                  </div>
                )}

                {knocks.length > 0 && (
                  <div className="grid gap-3 lg:grid-cols-2">
                    {knocks.map((knock) => (
                      <div
                        key={knock.id}
                        className="rounded-[28px] border border-[#d2c5ae] bg-[#fffaf1] p-4 shadow-[0_16px_34px_rgba(23,22,19,0.06)] sm:p-5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-[#171613]">Join request</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.2em] text-[#8d816c]">{formatMailStamp(knock.ts)}</p>
                          </div>
                          <div className="rounded-full border border-[#d7ccb8] bg-[#f7efe3] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#6a5e4e]">
                            Knock
                          </div>
                        </div>
                        <p className="mt-4 text-sm leading-7 text-[#40382f]">{knock.message ? knock.message : 'No note included.'}</p>
                        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                          <button
                            className="flex-1 rounded-full border border-[#171613] bg-[#171613] px-4 py-2 text-sm font-semibold text-[#f6f0e8]"
                            onClick={() => approveKnock(knock.id)}
                            type="button"
                          >
                            Approve
                          </button>
                          <button
                            className="flex-1 rounded-full border border-[#17161333] bg-white px-4 py-2 text-sm font-semibold text-[#171613]"
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

        {showHelp && (
          <div className="fixed inset-0 z-40 bg-[rgba(20,17,14,0.45)] px-4 py-6 text-[#171613] md:px-5">
            <div className="mx-auto flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-[34px] border border-[#1716131f] bg-[#f4efe4] shadow-[0_28px_70px_rgba(23,22,19,0.18)]">
              <div className="flex items-center justify-between border-b border-[#1716131f] bg-[#f8f4eb] px-4 py-4 sm:px-6">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-[#8d816c]">Help</p>
                  <h2 className="mt-1 text-lg font-semibold">Room notes</h2>
                </div>
                <button className="text-sm font-semibold text-[#4f473e]" onClick={() => setShowHelp(false)} type="button">
                  Close
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
                  <div className="rounded-[28px] border border-[#d5c8b2] bg-[#fdf9f2] p-5 shadow-[0_16px_34px_rgba(23,22,19,0.06)]">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-[#8d816c]">Sender</p>
                    <p className="mt-2 text-lg font-semibold">{handle || 'No sender set yet'}</p>
                    <p className="mt-3 text-sm leading-7 text-[#5d564d]">
                      Use <span className="font-semibold">/iam name</span> in the composer to change the sender label shown on your cards.
                    </p>

                    <p className="mt-6 text-[11px] uppercase tracking-[0.22em] text-[#8d816c]">Storage</p>
                    <p className="mt-3 text-sm leading-7 text-[#5d564d]">
                      Messages stay on this device. If you clear local browser storage, this inbox disappears here.
                    </p>
                  </div>

                  <div className="rounded-[28px] border border-[#d5c8b2] bg-[#fdf9f2] p-5 shadow-[0_16px_34px_rgba(23,22,19,0.06)]">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-[#8d816c]">Room key</p>
                    <p className="mt-2 text-sm leading-7 text-[#5d564d]">
                      Optional password used to encrypt knocks and message cards for this room.
                    </p>
                    <input
                      className="mt-4 w-full rounded-2xl border border-[#1716131f] bg-white px-4 py-3 text-base shadow-inner"
                      placeholder="Room password (optional)"
                      type="password"
                      value={roomPassword}
                      onChange={(event) => updateRoomPassword(event.target.value)}
                    />
                    <p className="mt-3 text-xs leading-5 text-[#6a6358]">
                      Saved only on this device. Everyone who should read the room needs the same password.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeMessage && (
          <div className="fixed inset-0 z-40 bg-[#f4efe4] text-[#171613] md:bg-[rgba(20,17,14,0.35)] md:px-5 md:py-6">
            <div className="mx-auto flex h-full w-full flex-col bg-[#f4efe4] md:h-auto md:max-h-[calc(100vh-3rem)] md:max-w-3xl md:overflow-hidden md:rounded-[36px] md:border md:border-[#1716131f] md:shadow-[0_28px_70px_rgba(23,22,19,0.18)]">
              <div className="flex items-center justify-between border-b border-[#1716131f] bg-[#f8f4eb] px-4 py-4">
                <button className="text-sm font-semibold text-[#4f473e]" onClick={() => setSelectedId(null)} type="button">
                  Inbox
                </button>
                <p className="text-sm font-semibold">{activeMessage.direction === 'out' ? 'Sent message' : 'Message'}</p>
                <button
                  className="text-sm font-semibold text-[#c44f2d]"
                  onClick={() => openComposer(activeMessage.id)}
                  type="button"
                >
                  Reply
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
                <article
                  className={`rounded-[32px] border p-6 shadow-[0_20px_40px_rgba(23,22,19,0.1)] sm:p-7 lg:p-8 ${
                    activeMessage.direction === 'out' && activeMessage.type !== 'system'
                      ? 'border-[#16233c] bg-[#1b2a46] text-[#f8f4ec]'
                      : activeMessage.type === 'system'
                      ? 'border-[#e0d2bc] bg-[#fff7ea] text-[#3f3529]'
                      : 'border-[#d5c8b2] bg-[#fdf9f2] text-[#171613]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{getMessageLabel(activeMessage)}</p>
                      <p
                        className={`mt-1 text-[11px] uppercase tracking-[0.22em] ${
                          activeMessage.direction === 'out' && activeMessage.type !== 'system' ? 'text-[#d2ddf5]' : 'text-[#8d816c]'
                        }`}
                      >
                        {activeMessage.type === 'system'
                          ? 'Room event'
                          : activeMessage.direction === 'out'
                          ? 'Sent from this device'
                          : 'Incoming message'}
                      </p>
                    </div>
                    <div className="text-right text-xs">
                      <p>{formatMailStamp(activeMessage.timestamp)}</p>
                    </div>
                  </div>

                  <div className="mt-6 whitespace-pre-wrap text-[15px] leading-7 sm:text-[17px] sm:leading-8">{activeMessage.content}</div>
                </article>

                <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                  <button
                    className="flex-1 rounded-full border border-[#17161333] bg-white px-4 py-3 text-sm font-semibold"
                    onClick={() => void handleCopyMessage(activeMessage.content)}
                    type="button"
                  >
                    Copy
                  </button>
                  <button
                    className="flex-1 rounded-full border border-[#171613] bg-[#171613] px-4 py-3 text-sm font-semibold text-[#f6f0e8]"
                    onClick={() => void handleDeleteMessage(activeMessage.id)}
                    type="button"
                  >
                    Delete local copy
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showComposer && (
          <div
            className="fixed inset-x-0 top-0 z-50 bg-[#f4efe4] text-[#171613] md:inset-0 md:bg-[rgba(20,17,14,0.35)] md:px-5 md:py-6"
            style={{
              height: composerViewport ? `${composerViewport.height}px` : '100dvh',
              top: composerViewport ? `${composerViewport.offsetTop}px` : undefined,
              WebkitUserSelect: 'none',
              userSelect: 'none'
            }}
          >
            <div className="mx-auto flex h-full w-full flex-col bg-[#f4efe4] md:h-auto md:max-h-[calc(100vh-3rem)] md:max-w-4xl md:overflow-hidden md:rounded-[36px] md:border md:border-[#1716131f] md:shadow-[0_28px_70px_rgba(23,22,19,0.2)]">
              <div className="flex items-center justify-between border-b border-[#1716131f] bg-[#f8f4eb] px-4 py-4">
                <button className="text-sm font-semibold text-[#4f473e]" onClick={closeComposer} type="button">
                  Cancel
                </button>
                <p className="text-sm font-semibold">{replyTarget ? 'Reply' : 'New message'}</p>
                <button className="text-sm font-semibold text-[#c44f2d]" onClick={sendMessage} type="button">
                  Send
                </button>
              </div>

              <div
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 sm:py-6 lg:px-8"
                style={{ WebkitOverflowScrolling: 'touch' }}
              >
                <div className="flex min-h-full flex-col rounded-[32px] border border-[#d5c8b2] bg-[#fdf9f2] p-5 shadow-[0_18px_36px_rgba(23,22,19,0.08)] sm:p-6 lg:p-8">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.24em] text-[#8d816c]">From</p>
                      <p className="mt-2 text-lg font-semibold text-[#171613]">{handle || 'You'}</p>
                    </div>
                    <div className="rounded-full border border-[#d7ccb8] bg-[#f4ede1] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6a5e4e]">
                      Draft
                    </div>
                  </div>

                  {replyTarget && (
                    <div className="mt-5 rounded-[24px] border border-[#eadcc6] bg-[#f7efe3] p-4">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-[#8d816c]">Replying to</p>
                      <p className="mt-2 text-sm font-semibold text-[#171613]">{getMessageLabel(replyTarget)}</p>
                      <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[#4d463d]">
                        {getMessagePreview(replyTarget.content)}
                      </p>
                    </div>
                  )}

                  <div className="mt-5">
                    <textarea
                      ref={composerInputRef}
                      className="block min-h-[12rem] w-full resize-none overflow-hidden border-0 bg-transparent pb-2 text-[17px] leading-8 text-[#171613] outline-none"
                      placeholder="Write like an email, send like a chat."
                      rows={8}
                      style={{
                        WebkitOverflowScrolling: 'touch',
                        WebkitUserSelect: 'text',
                        userSelect: 'text'
                      }}
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void sendMessage();
                        }
                      }}
                    />
                  </div>

                  <p className="mt-4 text-xs leading-5 text-[#6a6358]">
                    Replies are just new messages for now. Use <span className="font-semibold">/iam name</span> to change the sender label.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {showDisband && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-6">
            <div className="w-full max-w-sm rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-6 text-[#171613] shadow-[0_20px_40px_rgba(0,0,0,0.25)]">
              <h2 className="text-xl font-semibold">Disband this room?</h2>
              <p className="mt-2 text-sm text-[#3a362f]">
                This removes the room from the server. Everyone will be disconnected. It cannot be undone.
              </p>
              <div className="mt-6 flex gap-3">
                <button
                  className="flex-1 rounded-full border-2 border-[#171613] px-4 py-2 text-sm font-semibold"
                  onClick={() => setShowDisband(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="flex-1 rounded-full border-2 border-[#171613] bg-[#171613] px-4 py-2 text-sm font-semibold text-[#f6f0e8]"
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

        {showMenu && (
          <div className="fixed inset-0 z-40 bg-black/40">
            <div
              className="absolute inset-0"
              onClick={() => setShowMenu(false)}
              onKeyDown={() => setShowMenu(false)}
              role="button"
              tabIndex={0}
            />
            <aside className="absolute right-0 top-0 h-full w-80 max-w-full border-l border-[#1716132e] bg-[#f7f2e6] p-6 shadow-[0_20px_40px_rgba(0,0,0,0.25)]">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Room menu</h2>
                <button className="text-sm underline" onClick={() => setShowMenu(false)} type="button">
                  Close
                </button>
              </div>
              <p className="mt-2 text-xs text-[#3a362f]">Messages stay on this device only.</p>

              <a className="mt-4 inline-block text-sm underline" href="/rooms">
                Your rooms
              </a>

              <div className="mt-6 rounded-xl border border-dashed border-[#17161360] bg-[#fefaf2] p-4 text-sm">
                <p className="font-semibold">Share link</p>
                <p className="mt-2 break-all text-[#3a362f]">{shareUrl}</p>
              </div>

              <div className="mt-4 flex flex-col gap-3">
                <button
                  className="rounded-full border-2 border-[#171613] bg-[#171613] px-5 py-2 text-sm font-semibold text-[#f6f0e8]"
                  onClick={handleCopy}
                  type="button"
                >
                  Copy link
                </button>
                <button
                  className="rounded-full border-2 border-[#171613] px-5 py-2 text-sm font-semibold"
                  onClick={() => {
                    setShowQr(true);
                    setShowMenu(false);
                  }}
                  type="button"
                >
                  Show QR
                </button>
                <button
                  className="rounded-full border-2 border-[#171613] px-5 py-2 text-sm font-semibold"
                  onClick={() => {
                    setShowDisband(true);
                    setShowMenu(false);
                  }}
                  type="button"
                >
                  Disband room
                </button>
              </div>
            </aside>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#efe7d5] text-[#171613]">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
        {roomState === 'INIT' && (
          <div className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8">
            <p className="text-sm uppercase tracking-[0.3em] text-[#3a362f]">Loading room…</p>
          </div>
        )}

        {roomState === 'LOBBY_WAITING' && (
          <div className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_12px_30px_rgba(23,22,19,0.12)]">
            <h1 className="text-3xl font-semibold">Join room</h1>
            <p className="mt-3 text-[#3a362f]">Ask to be let in. Someone inside has to approve you.</p>

            <input
              className="mt-6 w-full rounded-xl border border-[#17161333] bg-white/80 p-3 text-sm"
              placeholder="Room password (optional)"
              type="password"
              value={roomPassword}
              onChange={(event) => updateRoomPassword(event.target.value)}
            />
            <p className="mt-2 text-xs text-[#3a362f]">
              Saved on this device. Used to encrypt your knock and chat messages.
            </p>

            <textarea
              className="mt-4 w-full rounded-xl border border-[#17161333] bg-white/80 p-3 text-sm"
              placeholder="Optional message"
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />

            <button
              className="mt-4 rounded-full border-2 border-[#171613] bg-[#171613] px-5 py-2 text-sm font-semibold text-[#f6f0e8]"
              onClick={sendKnock}
              type="button"
            >
              Request to join
            </button>

            {(knockSent || knockNotice) && (
              <p className="mt-4 text-sm uppercase tracking-[0.3em] text-[#3a362f]">{knockNotice || 'Waiting for approval…'}</p>
            )}
          </div>
        )}

        {roomState === 'LOBBY_EMPTY' && (
          <div className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_12px_30px_rgba(23,22,19,0.12)]">
            <h1 className="text-3xl font-semibold">Room inactive</h1>
            <p className="mt-3 text-[#3a362f]">
              No one is currently in this room. Ask someone inside to open it so they can approve you.
            </p>
            <div className="mt-6 rounded-xl border border-dashed border-[#17161360] bg-[#fefaf2] p-4 text-sm">
              <p className="font-semibold">Copy link</p>
              <p className="mt-2 break-all text-[#3a362f]">{shareUrl}</p>
            </div>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                className="rounded-full border-2 border-[#171613] bg-[#171613] px-5 py-2 text-sm font-semibold text-[#f6f0e8]"
                onClick={handleCopy}
                type="button"
              >
                Copy link
              </button>
              <button
                className="rounded-full border-2 border-[#171613] px-5 py-2 text-sm font-semibold"
                onClick={() => setShowQr(true)}
                type="button"
              >
                Show QR
              </button>
            </div>
          </div>
        )}

        {roomState === 'DESTROYED' && (
          <div className="rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-8 shadow-[0_12px_30px_rgba(23,22,19,0.12)]">
            <h1 className="text-3xl font-semibold">Room unavailable</h1>
            <p className="mt-3 text-[#3a362f]">This room was disbanded or no longer exists.</p>
          </div>
        )}
      </div>

      <QrModal open={showQr} onClose={() => setShowQr(false)} value={shareUrl} />

      {showDisband && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-6">
          <div className="w-full max-w-sm rounded-2xl border border-[#1716132e] bg-[#f7f2e6] p-6 text-[#171613] shadow-[0_20px_40px_rgba(0,0,0,0.25)]">
            <h2 className="text-xl font-semibold">Disband this room?</h2>
            <p className="mt-2 text-sm text-[#3a362f]">
              This removes the room from the server. Everyone will be disconnected. It cannot be undone.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                className="flex-1 rounded-full border-2 border-[#171613] px-4 py-2 text-sm font-semibold"
                onClick={() => setShowDisband(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="flex-1 rounded-full border-2 border-[#171613] bg-[#171613] px-4 py-2 text-sm font-semibold text-[#f6f0e8]"
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

      {showMenu && (
        <div className="fixed inset-0 z-40 bg-black/40">
          <div
            className="absolute inset-0"
            onClick={() => setShowMenu(false)}
            onKeyDown={() => setShowMenu(false)}
            role="button"
            tabIndex={0}
          />
          <aside className="absolute right-0 top-0 h-full w-80 max-w-full border-l border-[#1716132e] bg-[#f7f2e6] p-6 shadow-[0_20px_40px_rgba(0,0,0,0.25)]">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Room menu</h2>
              <button
                className="text-sm underline"
                onClick={() => setShowMenu(false)}
                type="button"
              >
                Close
              </button>
            </div>
            <p className="mt-2 text-xs text-[#3a362f]">Messages stay on this device only.</p>

            <a className="mt-4 inline-block text-sm underline" href="/rooms">
              Your rooms
            </a>

            <div className="mt-6 rounded-xl border border-dashed border-[#17161360] bg-[#fefaf2] p-4 text-sm">
              <p className="font-semibold">Share link</p>
              <p className="mt-2 break-all text-[#3a362f]">{shareUrl}</p>
            </div>

            <div className="mt-4 flex flex-col gap-3">
              <button
                className="rounded-full border-2 border-[#171613] bg-[#171613] px-5 py-2 text-sm font-semibold text-[#f6f0e8]"
                onClick={handleCopy}
                type="button"
              >
                Copy link
              </button>
              <button
                className="rounded-full border-2 border-[#171613] px-5 py-2 text-sm font-semibold"
                onClick={() => {
                  setShowQr(true);
                  setShowMenu(false);
                }}
                type="button"
              >
                Show QR
              </button>
              <button
                className="rounded-full border-2 border-[#171613] px-5 py-2 text-sm font-semibold"
                onClick={() => {
                  setShowDisband(true);
                  setShowMenu(false);
                }}
                type="button"
              >
                Disband room
              </button>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
};

export default RoomController;
