import { spawnAgent, type AgentHandle } from '../lib/agent-process.js';
import { createRoomAndJoin, encryptAndSend, bridgeAgentToRoom } from '../lib/room-bridge.js';
import { deriveMessageKey } from '../lib/crypto.js';
import { loadRegistry, loadActiveRooms, saveActiveRooms, type ActiveRoom } from '../lib/config.js';
import { parseLine } from '../lib/convention-parser.js';
import type { SSESubscription } from '../lib/sse-client.js';
import type { PresenceHandle } from '../lib/presence.js';

type RunningAgent = {
  agentId: string;
  name: string;
  roomHash: string;
  roomSecret: string;
  agent: AgentHandle;
  bridge: { sse: SSESubscription; presence: PresenceHandle; close: () => void };
  messageKey: CryptoKey;
  participantToken: string;
};

export class AgentManager {
  private agents = new Map<string, RunningAgent>();
  private server: string;
  private controlRoomHash: string;
  private controlToken: string;
  private controlKey: CryptoKey | null = null;
  private controlRoomSecret: string;
  private controlPassword: string;

  constructor(
    server: string,
    controlRoomHash: string,
    controlToken: string,
    controlRoomSecret: string,
    controlPassword: string
  ) {
    this.server = server;
    this.controlRoomHash = controlRoomHash;
    this.controlToken = controlToken;
    this.controlRoomSecret = controlRoomSecret;
    this.controlPassword = controlPassword;
  }

  private async getControlKey(): Promise<CryptoKey> {
    if (!this.controlKey) {
      this.controlKey = await deriveMessageKey(this.controlRoomSecret, this.controlPassword);
    }
    return this.controlKey;
  }

  private async sendControlMessage(text: string): Promise<void> {
    const key = await this.getControlKey();
    await encryptAndSend(this.server, this.controlRoomHash, this.controlToken, key, text);
  }

  async spawn(agentName: string, initialMessage?: string): Promise<string> {
    const registry = await loadRegistry();
    const entry = registry.find((a) => a.name === agentName);
    if (!entry) {
      throw new Error(`Agent "${agentName}" is not registered`);
    }

    const password = '';
    const room = await createRoomAndJoin(this.server, password);
    const agentId = room.roomHash.slice(0, 12);

    // Notify control room
    await this.sendControlMessage(JSON.stringify({
      proto: 'hisohiso-ctl',
      v: 1,
      cmd: 'spawned',
      agentId,
      agent: agentName,
      roomSecret: room.roomSecret,
    }));

    // Spawn agent process
    const agent = await spawnAgent(entry.command, [], {
      shellCommand: true,
      preambleAgent: entry.mode !== 'default' ? entry.mode : undefined,
    });

    if (initialMessage) {
      agent.writeStdin(`[FROM USER] ${initialMessage}\n`);
    }

    // Bridge
    const bridge = await bridgeAgentToRoom(
      agent,
      this.server,
      room.roomHash,
      room.participantToken,
      room.messageKey,
    );

    const running: RunningAgent = {
      agentId,
      name: agentName,
      roomHash: room.roomHash,
      roomSecret: room.roomSecret,
      agent,
      bridge,
      messageKey: room.messageKey,
      participantToken: room.participantToken,
    };

    this.agents.set(agentId, running);
    await this.persistRooms();

    // Handle exit
    agent.onExit.then(async (exit) => {
      try {
        await encryptAndSend(
          this.server,
          room.roomHash,
          room.participantToken,
          room.messageKey,
          `[STATUS] agent exited (code ${exit.code})`
        );
        await this.sendControlMessage(JSON.stringify({
          proto: 'hisohiso-ctl',
          v: 1,
          cmd: 'exited',
          agentId,
          exitCode: exit.code,
        }));
      } catch {
        // Best effort
      }
      bridge.close();
      this.agents.delete(agentId);
      await this.persistRooms();
    });

    return agentId;
  }

  async kill(agentId: string): Promise<void> {
    const running = this.agents.get(agentId);
    if (!running) {
      throw new Error(`No running agent with ID "${agentId}"`);
    }
    running.agent.kill();
  }

  async sendInput(agentId: string, text: string): Promise<void> {
    const running = this.agents.get(agentId);
    if (!running) {
      throw new Error(`No running agent with ID "${agentId}"`);
    }
    // Determine input type
    const lower = text.toLowerCase().trim();
    if (lower === 'yes' || lower === 'no') {
      running.agent.writeStdin(`${lower}\n`);
    } else {
      running.agent.writeStdin(`[FROM USER] ${text}\n`);
    }
  }

  listRunning(): Array<{ agentId: string; name: string; status: string }> {
    return Array.from(this.agents.values()).map((a) => ({
      agentId: a.agentId,
      name: a.name,
      status: 'running',
    }));
  }

  async killAll(): Promise<void> {
    for (const [, running] of this.agents) {
      running.agent.kill();
      running.bridge.close();
    }
    this.agents.clear();
    await this.persistRooms();
  }

  private async persistRooms(): Promise<void> {
    const rooms: ActiveRoom[] = Array.from(this.agents.values()).map((a) => ({
      agentId: a.agentId,
      name: a.name,
      roomHash: a.roomHash,
      roomSecret: a.roomSecret,
      pid: a.agent.pid ?? 0,
    }));
    await saveActiveRooms(rooms);
  }
}
