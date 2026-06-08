import { randomBytes, base64UrlEncode } from './crypto.js';

// Bridges an agent's in-turn permission request out to the room (as a `buttons`
// block the phone already renders) and back (via the phone's `block_response`).
// One ApprovalManager per agent session. The agent's turn awaits request();
// the room's onChat handler calls resolve() when the operator taps Allow/Deny.

export type ApprovalDecision = { allow: boolean };

type Pending = {
  resolve: (d: ApprovalDecision) => void;
  tool: string;
  timer: ReturnType<typeof setTimeout> | null;
};

// Block id prefix used to route the phone's tap back to the right pending
// request: `approve-tool:<reqId>`. The option values are the literal strings
// 'allow' / 'deny'.
export const APPROVE_TOOL_PREFIX = 'approve-tool:';

export const approvalBlock = (reqId: string, tool: string): unknown => ({
  type: 'buttons',
  id: `${APPROVE_TOOL_PREFIX}${reqId}`,
  prompt: `Allow ${tool}?`,
  style: 'inline',
  multi: false,
  options: [
    { label: 'Allow', value: 'allow' },
    { label: 'Deny', value: 'deny' },
  ],
});

export class ApprovalManager {
  private pending = new Map<string, Pending>();

  constructor(
    // Sends the approval prompt into the room. The daemon supplies an encrypt
    // -and-send closure bound to this session's room + key.
    private readonly send: (text: string, block: unknown) => Promise<void>,
  ) {}

  // Raise an approval request and block until the operator answers — or until
  // timeoutMs elapses, in which case it defaults to DENY (a turn must never hang
  // forever waiting on an absent operator). Returns the decision.
  async request(tool: string, detail: string, timeoutMs = 5 * 60 * 1000): Promise<ApprovalDecision> {
    const reqId = base64UrlEncode(randomBytes(9));
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(reqId)) resolve({ allow: false });
            }, timeoutMs)
          : null;
      // Don't keep the event loop alive solely for a pending approval timer.
      timer?.unref?.();
      this.pending.set(reqId, { resolve, tool, timer });
    });
    const body = detail.trim() ? `⏸ Waiting on you — ${tool}\n${detail.trim()}` : `⏸ Waiting on you — ${tool}`;
    await this.send(body, approvalBlock(reqId, tool));
    return decision;
  }

  // Resolve a pending request from a phone block_response. `reqId` is the part
  // after APPROVE_TOOL_PREFIX in the block id. Returns true if it matched.
  resolve(reqId: string, allow: boolean): boolean {
    const p = this.pending.get(reqId);
    if (!p) return false;
    this.pending.delete(reqId);
    if (p.timer) clearTimeout(p.timer);
    p.resolve({ allow });
    return true;
  }

  // Deny everything still outstanding — used when a turn ends/aborts so no
  // promise is left dangling.
  cancelAll(): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ allow: false });
    }
    this.pending.clear();
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}
