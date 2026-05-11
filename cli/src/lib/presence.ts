import { sendPresence } from './api-client.js';

const PRESENCE_INTERVAL_MS = 20_000;

export type PresenceHandle = {
  stop: () => void;
};

export const startPresence = (server: string, roomHash: string, token: string): PresenceHandle => {
  const interval = setInterval(async () => {
    try {
      await sendPresence(server, roomHash, token);
    } catch {
      // Presence failures are non-fatal; retry on next tick
    }
  }, PRESENCE_INTERVAL_MS);

  // Fire immediately
  sendPresence(server, roomHash, token).catch(() => {});

  return {
    stop: () => clearInterval(interval),
  };
};
