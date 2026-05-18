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
};

export type SSESubscription = {
  close: () => void;
};

export const subscribeToRoom = (server: string, roomHash: string, jwt: string, handlers: SSEHandlers): SSESubscription => {
  const topic = encodeURIComponent(`room:${roomHash}`);
  const url = `${server}/.well-known/mercure?topic=${topic}`;
  const es = new EventSource(url, {
    fetch: (input, init) => fetch(input, {
      ...init,
      headers: { ...(init?.headers || {}), Authorization: `Bearer ${jwt}` },
    }),
  });

  const dispatch = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data) as RoomEvent;
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
