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

export const createRoomEventSource = (
  roomHash: string,
  jwt: string,
  scope: RoomTopicScope = 'members'
): EventSource => {
  const topic = encodeURIComponent(buildTopic(roomHash, scope));
  const url = `/.well-known/mercure?topic=${topic}`;
  return new PolyfillEventSource(url, {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...(init?.headers || {}), Authorization: `Bearer ${jwt}` },
      }),
  }) as unknown as EventSource;
};
