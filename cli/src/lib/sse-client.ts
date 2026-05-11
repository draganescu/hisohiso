import { EventSource } from 'eventsource';

export type RoomEvent = {
  v: number;
  type: 'chat' | 'knock' | 'approve' | 'reject' | 'destroy';
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
  onOpen?: () => void;
  onError?: (error: unknown) => void;
};

export type SSESubscription = {
  close: () => void;
};

export const subscribeToRoom = (server: string, roomHash: string, handlers: SSEHandlers): SSESubscription => {
  const topic = encodeURIComponent(`room:${roomHash}`);
  const url = `${server}/.well-known/mercure?topic=${topic}`;
  const es = new EventSource(url);

  const dispatch = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data) as RoomEvent;
      switch (data.type) {
        case 'chat': handlers.onChat?.(data); break;
        case 'knock': handlers.onKnock?.(data); break;
        case 'approve': handlers.onApprove?.(data); break;
        case 'reject': handlers.onReject?.(data); break;
        case 'destroy': handlers.onDestroy?.(data); break;
      }
    } catch {
      // ignore malformed events
    }
  };

  es.addEventListener('chat', dispatch);
  es.addEventListener('knock', dispatch);
  es.addEventListener('approve', dispatch);
  es.addEventListener('reject', dispatch);
  es.addEventListener('destroy', dispatch);

  // Mercure also sends unnamed events for some configurations
  es.onmessage = dispatch;

  es.onopen = () => handlers.onOpen?.();
  es.onerror = (err: Event) => handlers.onError?.(err);

  return {
    close: () => es.close(),
  };
};
