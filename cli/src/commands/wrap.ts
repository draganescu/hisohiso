import { getServer, ensureConfigDir } from '../lib/config.js';
import { createRoomAndJoin, encryptAndSend } from '../lib/room-bridge.js';
import { startPresence } from '../lib/presence.js';
import { subscribeToRoom, type RoomEvent } from '../lib/sse-client.js';
import * as api from '../lib/api-client.js';
import { sha256Hex, decryptText, type EncryptedPayload } from '../lib/crypto.js';
import { getAgent, listAgents, type AgentProfile } from '../lib/agents.js';
import { runCommand, parseJsonOutput, parseCodexNdjson, parseBlockOutput } from '../lib/agent-process.js';
import qrTerminal from 'qrcode-terminal';

export const wrap = async (agentName: string, customCommand?: string[]): Promise<void> => {
  await ensureConfigDir();
  const server = await getServer();

  // Resolve agent profile
  let profile: AgentProfile;

  if (customCommand && customCommand.length > 0) {
    // Custom command: hisohiso wrap -- mycmd --flag
    // Message gets appended as last arg
    const [cmd, ...args] = customCommand;
    profile = { command: cmd!, args, description: 'custom command', mode: 'oneshot' };
  } else {
    const builtin = getAgent(agentName);
    if (!builtin) {
      console.error(`Unknown agent: "${agentName}"\n`);
      console.log('Built-in agents:');
      for (const [name, a] of Object.entries(listAgents())) {
        console.log(`  ${name.padEnd(14)} ${a.description}`);
      }
      console.log(`\nOr use a custom command: hisohiso wrap -- <command> [args...]`);
      process.exit(1);
    }
    profile = builtin;
  }

  // Create room — catch-up on so the phone sees agent output even after closing the app.
  const password = '';
  const room = await createRoomAndJoin(server, password, { catchUp: true });

  const joinUrl = `${server}/room#${room.roomSecret}`;
  console.log(`\nScan to connect (${agentName}):\n`);
  qrTerminal.generate(joinUrl, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log(`\nOr open: ${joinUrl}\n`);
  console.log('Waiting for phone to join...');

  const presence = startPresence(server, room.roomHash, room.participantToken);

  // Wait for phone to knock and auto-approve
  await new Promise<void>((resolve, reject) => {
    const sse = subscribeToRoom(server, room.roomHash, {
      onKnock: async () => {
        try {
          await api.approveKnock(server, room.roomHash, room.participantToken);
          console.log('Phone connected.\n');
          sse.close();
          resolve();
        } catch (err) {
          sse.close();
          reject(err);
        }
      },
    });

    process.on('SIGINT', async () => {
      sse.close();
      presence.stop();
      try { await api.disbandRoom(server, room.roomHash, room.participantToken); } catch { /* */ }
      process.exit(0);
    });
  });

  const ownTokenHash = await sha256Hex(room.participantToken);
  let running = false;
  let sessionId: string | null = null;

  const modeLabel = profile.mode === 'session' ? ' (session)' : '';
  console.log(`Listening${modeLabel}. Messages from phone → ${profile.command} ${profile.args.join(' ')} <message>\n`);

  // Message loop: phone message → run agent → send output
  const sse = subscribeToRoom(server, room.roomHash, {
    onChat: async (event: RoomEvent) => {
      if (event.from === ownTokenHash) return;

      let text: string;
      try {
        const encPayload = typeof event.body.encrypted_payload === 'string'
          ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
          : event.body.encrypted_payload as EncryptedPayload;
        const msgId = (event.body.msg_id as string) || '';
        const decrypted = await decryptText(room.messageKey, room.roomHash, 'chat', msgId, encPayload);
        const parsed = JSON.parse(decrypted) as { text: string };
        text = parsed.text;
      } catch (err) {
        console.error('[bridge] failed to decrypt inbound:', err);
        return;
      }

      console.log(`← ${text}`);

      if (running) {
        await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey,
          'Still running previous command. Please wait.');
        return;
      }

      running = true;

      // Per-turn arg construction. buildResumeArgs fully overrides base args for resume turns
      // (codex's `exec resume <id>` is a subcommand, not a flag append). Default resume strategy
      // (claude) pushes `--resume <id>` onto the base args.
      const isResume = profile.mode === 'session' && sessionId !== null;
      const args = isResume && profile.buildResumeArgs
        ? profile.buildResumeArgs(sessionId!)
        : [...profile.args];

      let messageToSend = text;
      if (profile.appendSystemPrompt) {
        if (profile.systemPromptMode === 'prepend-message-once') {
          // For agents without a system-prompt flag (codex). Prepend on first turn only;
          // session continuity carries it forward.
          if (!isResume) messageToSend = `${profile.appendSystemPrompt}\n\n${text}`;
        } else {
          args.push('--append-system-prompt', profile.appendSystemPrompt);
        }
      }

      if (isResume && !profile.buildResumeArgs) {
        args.push('--resume', sessionId!);
      }
      args.push(messageToSend);

      const displayArgs = args.map(a => a.length > 80 ? `"${a.slice(0, 40)}..."` : a.includes(' ') ? `"${a}"` : a);
      console.log(`  $ ${profile.command} ${displayArgs.join(' ')}`);

      const result = await runCommand(profile.command, args);

      let output: string;
      if (profile.mode === 'session') {
        const parsed = profile.outputFormat === 'codex-ndjson'
          ? parseCodexNdjson(result.stdout)
          : parseJsonOutput(result.stdout);
        if (parsed.sessionId) {
          sessionId = parsed.sessionId;
          console.log(`  [session: ${sessionId}]`);
        }
        output = (parsed.text || result.stderr || '(no output)').trim();
      } else {
        output = (result.stdout || result.stderr || '(no output)').trim();
      }

      // Try to parse block-structured output from Claude
      const blockParsed = parseBlockOutput(output);
      const sendText = blockParsed?.text ?? output;
      const sendBlocks = blockParsed?.blocks ?? undefined;

      console.log(`→ ${sendText.slice(0, 120)}${sendText.length > 120 ? '...' : ''}${sendBlocks ? ` [${sendBlocks.length} blocks]` : ''}\n`);

      // Send output back to room — split into chunks if too long
      const MAX_MSG = 4000;
      if (sendText.length <= MAX_MSG) {
        await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey, sendText, { blocks: sendBlocks });
      } else {
        // Can't attach blocks to chunked messages — send blocks with first chunk
        for (let i = 0; i < sendText.length; i += MAX_MSG) {
          const chunk = sendText.slice(i, i + MAX_MSG);
          await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey, chunk, i === 0 ? { blocks: sendBlocks } : undefined);
        }
      }

      if (result.code !== 0 && result.stderr) {
        await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey,
          `(exit code ${result.code})`);
      }

      running = false;
    },
    onDestroy: () => {
      console.log('Room destroyed. Exiting.');
      sse.close();
      presence.stop();
      process.exit(0);
    },
    onOpen: () => {
      console.log('[bridge] SSE connected');
    },
    onError: (err) => {
      console.error('[bridge] SSE error:', typeof err === 'string' ? err : 'reconnecting...');
    },
  });

  // Keep alive
  await new Promise(() => {});
};
