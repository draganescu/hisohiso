// The polyfilled EventSource supports custom request headers via `fetch`,
// which the native browser EventSource does not. Required now that the
// Mercure hub rejects anonymous subscribers — every connection must carry
// `Authorization: Bearer <subscriber_jwt>`.
import { EventSource as PolyfillEventSource } from 'eventsource';

// Topic scope mirrors server/mercure.php:
//   'members' → room:<hash>       (chats, settings, knocks, approve, destroy)
//   'lobby'   → room:<hash>:lobby (token wraps, rejects, destroy)
// The JWT's subscribe claim MUST list the topic being requested or Mercure
// refuses delivery. Knockers hold a lobby JWT; participants hold a members
// JWT — each call site picks the matching topic.
export type RoomTopicScope = 'members' | 'lobby';

const buildTopic = (roomHash: string, scope: RoomTopicScope): string => {
  return scope === 'lobby' ? `room:${roomHash}:lobby` : `room:${roomHash}`;
};

// If no bytes (event OR Mercure `: heartbeat` comment) arrive for this long,
// assume the connection silently died. On mobile networks a NAT rebinding or
// signal dip can leave the underlying socket ESTABLISHED while no more data
// ever arrives — the polyfill's `await reader.read()` then hangs forever and
// the UI stays at "Live" while nothing comes through. Cancelling the reader
// pops EventSource out of its read loop and triggers its normal reconnect
// path. 75s tolerates two missed heartbeats over the server-side
// `heartbeat 30s` (see Caddyfile) before we force a reconnect. Mirrors the
// daemon's watchdog in cli/src/lib/sse-client.ts.
const STALL_TIMEOUT_MS = 75_000;

// Wrap fetch so the EventSource sees a body stream that aborts when no bytes
// arrive for STALL_TIMEOUT_MS. Transparent on the happy path — every chunk
// (including SSE comment heartbeats) resets the timer.
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
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const wrapped = new ReadableStream<Uint8Array>({
    start() {
      armStallTimer();
    },
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

export const createRoomEventSource = (
  roomHash: string,
  jwt: string,
  scope: RoomTopicScope = 'members'
): EventSource => {
  const topic = encodeURIComponent(buildTopic(roomHash, scope));
  const url = `/.well-known/mercure?topic=${topic}`;
  return new PolyfillEventSource(url, {
    fetch: (input, init) =>
      stallWatchdogFetch(input, {
        ...init,
        headers: { ...(init?.headers || {}), Authorization: `Bearer ${jwt}` },
      }),
  }) as unknown as EventSource;
};
