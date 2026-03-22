import Dexie, { type Table } from 'dexie';

export type ChatMessage = {
  id: string;
  room_hash: string;
  timestamp: number;
  content: string;
  type: 'chat' | 'system';
  direction: 'in' | 'out';
  from?: string | null;
  handle?: string | null;
};

class ChatDatabase extends Dexie {
  messages!: Table<ChatMessage, string>;

  constructor() {
    super('hisohiso');
    this.version(1).stores({
      messages: 'id, room_hash, timestamp, [room_hash+timestamp]'
    });
  }
}

export const db = new ChatDatabase();

export const loadMessages = async (roomHash: string): Promise<ChatMessage[]> => {
  return db.messages
    .where('[room_hash+timestamp]')
    .between([roomHash, Dexie.minKey], [roomHash, Dexie.maxKey])
    .sortBy('timestamp');
};

export const saveMessage = async (message: ChatMessage): Promise<void> => {
  await db.messages.put(message);
};

export const deleteMessage = async (id: string): Promise<void> => {
  await db.messages.delete(id);
};

export const clearRoomMessages = async (roomHash: string): Promise<void> => {
  await db.messages.where('room_hash').equals(roomHash).delete();
};
