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
  clearToken,
  getHandle,
  getToken,
  setHandle,
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

const RoomController = () => {
  const { roomSecret = '' } = useParams();
  const [roomHash, setRoomHash] = useState<string>('');
  const [roomState, setRoomState] = useState<RoomState>('INIT');
  const [error, setError] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [knockSent, setKnockSent] = useState(false);
  const [knockNotice, setKnockNotice] = useState<string>('');
  const [knocks, setKnocks] = useState<KnockRequest[]>([]);
  const [knockPassword, setKnockPassword] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showDisband, setShowDisband] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [knockKey, setKnockKey] = useState<CryptoKey | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [tokenHash, setTokenHash] = useState<string | null>(null);
  const [handle, setHandleState] = useState<string>('');
  const [connection, setConnection] = useState<'idle' | 'connected' | 'error'>('idle');
  const [autoScroll, setAutoScroll] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  const listRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(0);
  const knockKeyRef = useRef<CryptoKey | null>(null);

  const shareUrl = useMemo(() => `${window.location.origin}/${roomSecret}`, [roomSecret]);

  const wipeLocalRoom = useCallback(async (hash: string) => {
    clearToken(hash);
    clearHandle(hash);
    removeRoom(hash);
    await clearRoomMessages(hash);
    setTokenState(null);
    setTokenHash(null);
    setKnocks([]);
    setMessages([]);
    setMessage('');
    setChatInput('');
    setKnockPassword('');
  }, []);

  useEffect(() => {
    let active = true;
    const nextPassword = knockPassword.trim();
    if (!roomSecret || !nextPassword) {
      setKnockKey(null);
      return () => {
        active = false;
      };
    }

    void deriveKnockKey(roomSecret, nextPassword)
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
  }, [roomSecret, knockPassword]);

  useEffect(() => {
    knockKeyRef.current = knockKey;
  }, [knockKey]);

  useEffect(() => {
    const init = async () => {
      try {
        const hash = await deriveRoomHash(roomSecret);
        setRoomHash(hash);
        setCryptoKey(await deriveMessageKey(roomSecret));
        setMessages(await loadMessages(hash));
        const savedHandle = getHandle(hash);
        setHandleState(savedHandle ?? '');

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
          await saveMessage(messageRecord);
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
  }, [roomHash, roomState, cryptoKey, token, tokenHash, wipeLocalRoom]);

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
    if (!knockKey || !knockPassword.trim()) {
      setKnockSent(false);
      setKnockNotice('Enter the shared passphrase first.');
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
  }, [roomHash, message, knockKey, knockPassword]);

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
      await saveMessage(record);
      setMessages((prev) => [...prev, record].sort((a, b) => a.timestamp - b.timestamp));
    },
    [roomHash]
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
      await saveMessage(messageRecord);
      setMessages((prev) => {
        if (prev.find((item) => item.id === msgId)) {
          return prev;
        }
        return [...prev, messageRecord].sort((a, b) => a.timestamp - b.timestamp);
      });
      setChatInput('');
    }
  }, [roomHash, token, cryptoKey, chatInput, tokenHash, handle, addSystemMessage, roomSecret]);

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

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    setAutoScroll(atBottom);
    if (atBottom) {
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
      requestAnimationFrame(scrollToBottom);
    }
  }, [messages, autoScroll, scrollToBottom]);

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
      <main className="app-shell text-[#171613]">
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
          <div className="flex items-center justify-between border-b border-[#1716132e] bg-[#f7f2e6] px-5 py-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-[#3a362f]">Chat for All</p>
              <p className="text-sm text-[#3a362f]">
                {connection === 'connected' ? 'Live' : connection === 'error' ? 'Reconnecting…' : 'Connecting…'}
              </p>
            </div>
            <button
              className="rounded-full border-2 border-[#171613] px-4 py-2 text-xs font-semibold"
              onClick={() => setShowMenu(true)}
              type="button"
            >
              Menu
            </button>
          </div>

          <div className="border-b border-[#1716132e] px-5 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[#3a362f]">Join requests</h2>
            <input
              className="mt-3 w-full rounded-xl border border-[#17161333] bg-white/80 p-3 text-sm"
              placeholder="Shared passphrase"
              type="password"
              value={knockPassword}
              onChange={(event) => setKnockPassword(event.target.value)}
            />
            <p className="mt-2 text-xs text-[#3a362f]">Only knocks decrypted with this passphrase are shown.</p>

            {knocks.length === 0 && (
              <p className="mt-3 text-sm text-[#3a362f]">No valid join requests yet.</p>
            )}

            {knocks.length > 0 && (
              <div className="mt-3 flex flex-col gap-3">
                {knocks.map((knock) => (
                  <div key={knock.id} className="rounded-xl border border-[#1716132e] bg-white/80 p-4 text-sm">
                    <p className="text-[#3a362f]">{knock.message ? `"${knock.message}"` : 'No message provided.'}</p>
                    <div className="mt-3 flex gap-2">
                      <button
                        className="rounded-full border-2 border-[#171613] bg-[#171613] px-4 py-1 text-xs font-semibold text-[#f6f0e8]"
                        onClick={() => approveKnock(knock.id)}
                        type="button"
                      >
                        Approve
                      </button>
                      <button
                        className="rounded-full border-2 border-[#171613] px-4 py-1 text-xs font-semibold"
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

          <div className="flex flex-1 flex-col px-5 py-4 min-h-0">
            <p className="mb-3 text-xs text-[#3a362f]">
              {handle ? `You are ${handle}.` : 'Set a handle with /iam name.'}
            </p>
            <div
              ref={listRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto pr-2 chat-scroll min-h-0"
            >
              <div className="flex flex-col gap-3">
                {messages.length === 0 && <p className="text-sm text-[#3a362f]">No messages yet.</p>}
                {messages.map((msg) => {
                  const isSelected = selectedId === msg.id;
                  const isSystem = msg.type === 'system';
                  return (
                    <div key={msg.id} className={`flex flex-col ${msg.direction === 'out' ? 'items-end' : 'items-start'}`}>
                      <button
                        type="button"
                        className={`max-w-[80%] rounded-2xl border px-4 py-2 text-left text-sm ${
                          isSystem
                            ? 'border-[#1716132e] bg-[#fef6e8] text-[#3a362f]'
                            : msg.direction === 'out'
                            ? 'border-[#171613] bg-[#171613] text-[#f6f0e8]'
                            : 'border-[#1716132e] bg-white/80 text-[#171613]'
                        }`}
                        onClick={() => setSelectedId(isSelected ? null : msg.id)}
                      >
                        {msg.handle && !isSystem && <span className="mr-2 font-semibold">{msg.handle}</span>}
                        {msg.content}
                      </button>
                      {isSelected && (
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-[#3a362f]">
                          <span>{new Date(msg.timestamp * 1000).toLocaleTimeString()}</span>
                          <button type="button" className="underline" onClick={() => handleCopyMessage(msg.content)}>
                            Copy
                          </button>
                          <button type="button" className="underline" onClick={() => handleDeleteMessage(msg.id)}>
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {!autoScroll && unreadCount > 0 && (
              <button
                className="mt-4 w-full rounded-full border-2 border-[#171613] bg-white/80 px-4 py-2 text-xs font-semibold"
                onClick={() => {
                  scrollToBottom();
                  setAutoScroll(true);
                  setUnreadCount(0);
                }}
                type="button"
              >
                {unreadCount} new message{unreadCount === 1 ? '' : 's'} · Jump to latest
              </button>
            )}

            <div className="mt-4 border-t border-[#1716132e] pt-4 chat-input">
              <div className="flex items-end gap-3">
                <textarea
                  className="flex-1 resize-none rounded-2xl border border-[#17161333] bg-white/80 px-4 py-3 text-base"
                  placeholder="Type a message"
                  rows={2}
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onFocus={() => {
                    setAutoScroll(true);
                    requestAnimationFrame(scrollToBottom);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                />
                <button
                  className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-[#171613] bg-[#171613] text-[#f6f0e8]"
                  onClick={sendMessage}
                  type="button"
                  aria-label="Send message"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 2L11 13" />
                    <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
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
              placeholder="Shared passphrase"
              type="password"
              value={knockPassword}
              onChange={(event) => setKnockPassword(event.target.value)}
            />
            <p className="mt-2 text-xs text-[#3a362f]">
              The passphrase never leaves your device. It is only used to encrypt your knock.
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
