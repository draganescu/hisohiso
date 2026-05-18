// The polyfilled EventSource supports custom request headers via `fetch`,
// which the native browser EventSource does not. Required now that the
// Mercure hub rejects anonymous subscribers — every connection must carry
// `Authorization: Bearer <subscriber_jwt>`.
import { EventSource as PolyfillEventSource } from 'eventsource';

export const createRoomEventSource = (roomHash: string, jwt: string): EventSource => {
  const topic = encodeURIComponent(`room:${roomHash}`);
  const url = `/.well-known/mercure?topic=${topic}`;
  return new PolyfillEventSource(url, {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...(init?.headers || {}), Authorization: `Bearer ${jwt}` },
      }),
  }) as unknown as EventSource;
};
