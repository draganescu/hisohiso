import { EventSource } from 'eventsource';

export type RoomEvent = {
  v: number;
  type: 'chat' | 'knock' | 'approve' | 'reject' | 'destroy' | 'token';
  room_hash: string;
  from: string | null;
  ts: number;
  body: Record<string, unknown>;
};

export type SSEHandlers = {
  onChat?: (event: RoomEvent) => void;
  onKnock?: (event: RoomEvent) => void;
  onApprove?: (event: RoomEvent) => void;
  onReject?: (event: RoomEvent) => void;
  onDestroy?: (event: RoomEvent) => void;
  onToken?: (event: RoomEvent) => void;
  onOpen?: () => void;
  onError?: (error: unknown) => void;
  // Fires for every successfully parsed event of any type, before the
  // type-specific handler. Used to track last-event timestamps for SSE
  // liveness — Mercure keepalive comments don't surface here, so a stale
  // timestamp is a hint, not a verdict.
  onAnyEvent?: (event: RoomEvent) => void;
};

export type SSESubscription = {
  close: () => void;
};

// If no bytes (event OR Mercure `: heartbeat` comment) arrive for this long,
// assume the connection silently died — NAT/proxy timeouts can eat the FIN so
// the local TCP socket stays ESTABLISHED forever and the underlying
// `await reader.read()` never resolves. Cancelling the reader pops EventSource
// out of its read loop and triggers its normal reconnect path. 90s = 3x the
// server-side `heartbeat 30s` in the Caddyfile, so two missed heartbeats are
// tolerated before we force a reconnect.
const STALL_TIMEOUT_MS = 90_000;

// Wrap fetch so the EventSource sees a body stream that aborts when no bytes
// arrive for STALL_TIMEOUT_MS. The wrap is transparent on the happy path —
// every chunk (including SSE comment heartbeats) resets the timer.
const stallWatchdogFetch = async (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): Promise<Response> => {
  const response = await fetch(input, init);
  if (!response.body) return response;

  const reader = response.body.getReader();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      cancelled = true;
      reader.cancel(new Error('SSE stall timeout')).catch(() => {});
    }, STALL_TIMEOUT_MS);
  };

  const clearStallTimer = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };

  const wrapped = new ReadableStream<Uint8Array>({
    async start() { armStallTimer(); },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          clearStallTimer();
          controller.close();
          return;
        }
        armStallTimer();
        controller.enqueue(value);
      } catch (err) {
        clearStallTimer();
        if (cancelled) {
          controller.close();
        } else {
          controller.error(err);
        }
      }
    },
    cancel(reason) {
      clearStallTimer();
      reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const subscribeToRoom = (server: string, roomHash: string, jwt: string, handlers: SSEHandlers): SSESubscription => {
  const topic = encodeURIComponent(`room:${roomHash}`);
  const url = `${server}/.well-known/mercure?topic=${topic}`;
  const es = new EventSource(url, {
    fetch: (input, init) => stallWatchdogFetch(input, {
      ...init,
      headers: { ...(init?.headers || {}), Authorization: `Bearer ${jwt}` },
    }),
  });

  const dispatch = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data) as RoomEvent;
      handlers.onAnyEvent?.(data);
      switch (data.type) {
        case 'chat': handlers.onChat?.(data); break;
        case 'knock': handlers.onKnock?.(data); break;
        case 'approve': handlers.onApprove?.(data); break;
        case 'reject': handlers.onReject?.(data); break;
        case 'destroy': handlers.onDestroy?.(data); break;
        case 'token': handlers.onToken?.(data); break;
        default: console.error('[sse] unknown event type:', data.type);
      }
    } catch (err) {
      console.error('[sse] failed to parse event:', err, 'raw:', event.data);
    }
  };

  // Mercure sends named SSE events (event: chat, event: knock, etc.)
  es.addEventListener('chat', dispatch);
  es.addEventListener('knock', dispatch);
  es.addEventListener('approve', dispatch);
  es.addEventListener('reject', dispatch);
  es.addEventListener('destroy', dispatch);
  es.addEventListener('token', dispatch);

  // Some Mercure configs also send unnamed events
  es.onmessage = dispatch;

  es.onopen = () => handlers.onOpen?.();
  es.onerror = () => {
    // EventSource fires error on every reconnect attempt — this is normal.
    // Only surface it if the connection is fully closed (readyState === 2).
    if (es.readyState === 2) {
      handlers.onError?.('SSE connection closed');
    }
  };

  return {
    close: () => es.close(),
  };
};
