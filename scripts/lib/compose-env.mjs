// The docker-compose env contract for a worktree's dev/relay stack, in ONE
// place so dev.mjs (attached) and relay.mjs (detached) inject identical values.
// Pairs the pure per-worktree derivation (worktree-env.mjs) with the cached dev
// VAPID keypair (vapid.mjs).
import { deriveWorktreeEnv } from './worktree-env.mjs';
import { loadOrCreateVapid } from './vapid.mjs';

// Returns { project, port, env } — `env` is a full process-env clone with the
// compose variables layered on, ready to hand to a `docker compose` child.
export async function composeEnv(cwd) {
  const { project, port, pubKey, subKey } = deriveWorktreeEnv(cwd);
  const vapid = await loadOrCreateVapid(cwd);
  return {
    project,
    port,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: project,
      HISOHISO_PORT: String(port),
      MERCURE_PUBLISHER_JWT_KEY: pubKey,
      MERCURE_SUBSCRIBER_JWT_KEY: subKey,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      // NOT a localhost mailto: Apple rejects those (403 BadJwtToken). The sub is
      // just an abuse contact for the push service; any real https:/mailto works.
      VAPID_SUBJECT: 'https://hisohiso.org',
    },
  };
}
