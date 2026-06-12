import { getServer, ensureConfigDir } from '../lib/config.js';
import { createRoomAndJoin, encryptAndSend, quoteForAgent } from '../lib/room-bridge.js';
import { startPresence } from '../lib/presence.js';
import { subscribeToRoom, type RoomEvent } from '../lib/sse-client.js';
import * as api from '../lib/api-client.js';
import { sha256Hex, decryptText, deriveKnockKey, beginApprove, type EncryptedPayload } from '../lib/crypto.js';
import { promptLine, generatePairingCode } from '../lib/prompt.js';
import { getAgent, listAgents, providerOf, type AgentProfile } from '../lib/agents.js';
import { isCommandAvailable } from '../lib/agent-detect.js';
import { runCommand, parseJsonOutput, parseCodexNdjson, parseBlockOutput } from '../lib/agent-process.js';
import { runStreamingTurn } from '../lib/agent-stream.js';
import { ensureBundledSkills } from '../lib/skills/bundled.js';
import qrTerminal from 'qrcode-terminal';

export const wrap = async (agentName: string, customCommand?: string[]): Promise<void> => {
  await ensureConfigDir();
  await ensureBundledSkills();
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
    if (!(await isCommandAvailable(builtin.command))) {
      console.error(`Agent "${agentName}" needs "${builtin.command}", which isn't installed on this host.`);
      console.error(`Install it and make sure it's on your PATH, then try again.`);
      process.exit(1);
    }
    profile = builtin;
  }

  // Prompt the operator for a session knock message BEFORE generating the QR.
  // Hidden input so it stays out of scrollback. This is the secret the phone
  // must type as the knock body — only knowing it AND the pairing code AND the
  // room URL together gets a phone past the auto-approve gate below.
  const sessionKnockMessage = (await promptLine('Knock message (the secret the phone will type as the knock body): ', { hidden: true })).trim();
  if (sessionKnockMessage === '') {
    console.error('Knock message cannot be empty. Aborting.');
    process.exit(1);
  }

  // Create room with a fresh 4-digit pairing code as the password — k_msg and
  // k_knock now depend on secret + code, not secret alone.
  const password = generatePairingCode();
  const room = await createRoomAndJoin(server, password, { catchUp: true });
  const knockKey = await deriveKnockKey(room.roomSecret, password);

  const joinUrl = `${server}/room#${room.roomSecret}`;
  console.log(`\nScan to connect (${agentName}):\n`);
  qrTerminal.generate(joinUrl, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log(`\nOr open: ${joinUrl}`);
  console.log(`Pairing code: ${password}`);
  console.log('(Enter the pairing code as the room password; use your knock message as the knock body.)\n');
  console.log('Waiting for phone to join...');

  const presence = startPresence(server, room.roomHash, room.participantToken);

  // Wait for phone to knock and auto-approve. Intentionally first-device-by-
  // construction: sse.close()+resolve() fire after the first successful approval
  // (below), so this onKnock site can never admit a second device and needs no
  // bound flag — unlike the daemon's long-lived control/agent rooms (finding #94).
  await new Promise<void>((resolve, reject) => {
    const sse = subscribeToRoom(server, room.roomHash, room.subscriberJwt, {
      onKnock: async (knockEvent: RoomEvent) => {
        const knockPubkey = knockEvent.body?.knock_pubkey;
        const knockMsgId = knockEvent.body?.msg_id;
        const rawPayload = knockEvent.body?.encrypted_payload;
        if (typeof knockPubkey !== 'string' || typeof knockMsgId !== 'string' || !rawPayload) {
          console.error('[wrap] knock missing fields — ignoring');
          return;
        }
        // Two-factor knock gate: decrypt with k_knock (proves possession of
        // the pairing code), then string-equality the cleartext to the
        // session knock message (proves possession of the operator's secret).
        // Both checks silent on failure — no info to brute-forcers.
        let knockText: string;
        try {
          const enc = typeof rawPayload === 'string'
            ? JSON.parse(rawPayload) as EncryptedPayload
            : rawPayload as EncryptedPayload;
          knockText = (await decryptText(knockKey, room.roomHash, 'knock', knockMsgId, enc)).trim();
        } catch {
          console.error('[wrap] knock decrypt failed — wrong pairing code, ignoring');
          return;
        }
        if (knockText !== sessionKnockMessage) {
          console.error('[wrap] knock message mismatch — ignoring');
          return;
        }
        try {
          // beginApprove derives the wrap material + claim tag from one ephemeral
          // keypair. claimTagHash is committed via /approve; the phone reveals the
          // matching tag on its first /presence to claim the token.
          const binding = await beginApprove(knockPubkey, knockMsgId);
          const approveRes = await api.approveKnock(server, room.roomHash, room.participantToken, binding.claimTagHash);
          // Wrap BOTH the participant token AND the new subscriber JWT — the
          // phone needs the JWT to subscribe to Mercure now that the hub
          // rejects anonymous clients.
          const bundle = JSON.stringify({
            token: approveRes.new_participant_token,
            subscriber_jwt: approveRes.subscriber_jwt,
          });
          const wrapped = await binding.wrap(bundle);
          await api.sendWrappedToken(server, room.roomHash, room.participantToken, knockMsgId, wrapped);
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
  // Messages that arrived mid-turn. Rather than bounce them with "still
  // running", we buffer here and the in-flight turn drains the whole batch
  // into ONE coalesced follow-up turn when it finishes.
  const pending: string[] = [];
  let sessionId: string | null = null;
  // Per-session msg_id dedup: drops any chat we've already dispatched. AAD
  // matching is necessary but not sufficient — server can replay captured
  // ciphertexts with their original msg_id, and offline-sync can re-deliver
  // historical messages. Without dedup the agent re-executes those.
  const seenMsgIds = new Set<string>();

  const modeLabel = profile.mode === 'session' ? ' (session)' : '';
  console.log(`Listening${modeLabel}. Messages from phone → ${profile.command} ${profile.args.join(' ')} <message>\n`);

  // Note: no auto-updater in wrap. Each `hisohiso wrap` invocation mints a
  // fresh room with a fresh QR, so re-execing mid-session would orphan the
  // phone (the new wrap would create yet another room). Users with long-
  // running wrap sessions pick up updates by Ctrl-C-ing and rescanning, or
  // by switching to the daemon which IS auto-updated.

  // Execute one agent turn for `text`. The onChat handler owns the turn
  // lifecycle (the `running` flag and queue draining); this is one
  // spawn→parse→send cycle and mutates the outer `sessionId` on resume.
  const runTurn = async (text: string): Promise<void> => {
    // Per-turn arg construction. buildResumeArgs fully overrides base args for resume turns
    // (codex's `exec resume <id>` is a subcommand, not a flag append). Default resume strategy
    // (claude) pushes `--resume <id>` onto the base args.
    const isResume = profile.mode === 'session' && sessionId !== null;
    const args = isResume && profile.buildResumeArgs
      ? profile.buildResumeArgs(sessionId!)
      : [...profile.args];

    let messageToSend = text;
    if (profile.appendSystemPrompt) {
      if (profile.systemPromptMode === 'codex-config') {
        args.push('--config', `instructions=${profile.appendSystemPrompt}`);
      } else if (profile.systemPromptMode === 'prepend-message-once') {
        if (!isResume) messageToSend = `${profile.appendSystemPrompt}\n\n${text}`;
      } else {
        args.push('--append-system-prompt', profile.appendSystemPrompt);
      }
    }

    if (isResume && !profile.buildResumeArgs) {
      args.push('--resume', sessionId!);
    }

    const env = {
      HISOHISO_AGENT_ID: room.roomHash.slice(0, 12),
      HISOHISO_AGENT_NAME: agentName,
      HISOHISO_ROOM_HASH: room.roomHash,
      // Opt-in per profile (finding #97): withheld by default so the wrapped
      // command can't trivially exfiltrate the room secret via its env. The
      // built-in profiles don't set needsRoomSecret; ad-hoc `wrap -- <cmd>`
      // commands likewise don't receive it.
      ...(profile.needsRoomSecret ? { HISOHISO_ROOM_SECRET: room.roomSecret } : {}),
    };

    // Claude/Codex emit a JSONL event stream (stream-json / --json), which the
    // buffered parseJsonOutput can't read — it would dump raw events to the room
    // and never capture the session id, so --resume would never engage. Use the
    // same streaming runner the daemon uses. Other commands keep the buffered path.
    const provider = providerOf(profile);
    let output: string;
    let exitNote: string | null = null;

    if (provider === 'claude' || provider === 'codex') {
      console.log(`  $ ${profile.command} (provider=${provider}${isResume ? ' resume' : ''})`);
      const result = await runStreamingTurn({ command: profile.command, argv: args, prompt: messageToSend, format: provider, env });
      if (profile.mode === 'session' && result.sessionId) {
        sessionId = result.sessionId;
        console.log(`  [session: ${sessionId}]`);
      }
      output = (result.text || '(no output)').trim();
      if (result.code !== 0 && !result.text) {
        exitNote = `(turn failed${result.code != null ? `, exit code ${result.code}` : ''})`;
      }
    } else {
      args.push(messageToSend);
      const displayArgs = args.map(a => a.length > 80 ? `"${a.slice(0, 40)}..."` : a.includes(' ') ? `"${a}"` : a);
      console.log(`  $ ${profile.command} ${displayArgs.join(' ')}`);

      const result = await runCommand(profile.command, args, { env });

      // oneshot profiles can still emit structured output (e.g. codex-once uses
      // `--json`); sessionId capture is gated on session mode.
      let parsedText: string;
      let parsedSessionId: string | null = null;
      if (profile.outputFormat === 'codex-ndjson') {
        const parsed = parseCodexNdjson(result.stdout);
        parsedText = parsed.text;
        parsedSessionId = parsed.sessionId;
      } else if (profile.mode === 'session') {
        const parsed = parseJsonOutput(result.stdout);
        parsedText = parsed.text;
        parsedSessionId = parsed.sessionId;
      } else {
        parsedText = result.stdout;
      }
      output = (parsedText || result.stderr || '(no output)').trim();
      if (profile.mode === 'session' && parsedSessionId) {
        sessionId = parsedSessionId;
        console.log(`  [session: ${sessionId}]`);
      }
      if (result.code !== 0 && result.stderr) exitNote = `(exit code ${result.code})`;
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

    if (exitNote) {
      await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey, exitNote);
    }
  };

  // Message loop: phone message → run agent → send output
  const sse = subscribeToRoom(server, room.roomHash, room.subscriberJwt, {
    onChat: async (event: RoomEvent) => {
      if (event.from === ownTokenHash) return;

      const incomingMsgId = (event.body.msg_id as string) || '';
      if (incomingMsgId === '') {
        console.error('[bridge] chat without msg_id — dropping');
        return;
      }
      if (seenMsgIds.has(incomingMsgId)) {
        console.error(`[bridge] replay of msg_id ${incomingMsgId} — dropping`);
        return;
      }
      seenMsgIds.add(incomingMsgId);

      let text: string;
      try {
        const encPayload = typeof event.body.encrypted_payload === 'string'
          ? JSON.parse(event.body.encrypted_payload) as EncryptedPayload
          : event.body.encrypted_payload as EncryptedPayload;
        const decrypted = await decryptText(room.messageKey, room.roomHash, 'chat', incomingMsgId, encPayload);
        const parsed = JSON.parse(decrypted) as {
          text: string;
          replies?: Array<{ text?: string; reply_to?: { quote?: string } }>;
        };
        // A batch of replies (agent-room collector): feed the whole set as ONE
        // turn so the agent reads them together, each tagged with the message it
        // answers — matching room-bridge's daemon path. Without this, only the
        // "N replies" summary text reaches the agent and the replies are lost.
        if (Array.isArray(parsed.replies) && parsed.replies.length > 0) {
          const lines = parsed.replies
            .filter((r) => r && typeof r.text === 'string')
            .map((r) => {
              const q = r.reply_to?.quote ? ` (re: "${quoteForAgent(r.reply_to.quote)}")` : '';
              return `↳${q} ${r.text}`;
            });
          const label = lines.length === 1 ? 'reply' : 'replies';
          text = `[FROM USER · ${lines.length} ${label}]\n${lines.join('\n')}`;
        } else {
          text = parsed.text;
        }
      } catch (err) {
        console.error('[bridge] failed to decrypt inbound:', err);
        return;
      }

      console.log(`← ${text}`);

      // Mid-turn message: queue instead of bouncing with "still running". The
      // in-flight turn drains the queue when it finishes, coalescing the pending
      // batch into one follow-up resume turn so steering messages run in order.
      if (running) {
        pending.push(text);
        await encryptAndSend(server, room.roomHash, room.participantToken, room.messageKey,
          `📥 Queued — will run after the current turn (${pending.length} pending).`);
        return;
      }

      running = true;
      try {
        await runTurn(text);
        // Drain whatever queued while we ran, coalescing the batch into a single
        // turn; the loop re-checks because more can arrive during the drain turn.
        while (pending.length > 0) {
          const batch = pending.splice(0, pending.length);
          await runTurn(batch.join('\n\n'));
        }
      } finally {
        running = false;
      }
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
  }, {
    // A wrap session left running past the subscriber JWT's 7-day TTL would go
    // silently deaf on the next reconnect — re-mint with the still-valid
    // participant token instead. In-memory only; wrap rooms don't persist.
    refreshJwt: async () => {
      try {
        const next = await api.refreshSubscriberJwt(server, room.roomHash, room.participantToken);
        console.log('[bridge] subscriber JWT refreshed');
        return next;
      } catch (err) {
        console.error('[bridge] subscriber JWT refresh failed:', err instanceof Error ? err.message : String(err));
        return null;
      }
    },
  });

  // Keep alive
  await new Promise(() => {});
};
