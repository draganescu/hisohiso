// `hisohiso update` (#153) — update the CLI binary on demand instead of waiting
// for the daemon's 6h auto-update tick (or for fresh / `wrap` installs that
// never run the loop at all). Shares the download/verify/swap path with the
// background auto-updater (lib/updater.ts) — one implementation.
//
//   hisohiso update          download + verify + atomically swap the binary,
//                            report old → new (or "already up to date").
//   hisohiso update --check  report current vs latest only; download nothing.
//
// An explicit `update` runs even when HISOHISO_AUTO_UPDATE=off — that env var
// opts out of the *background* tick, not of a deliberate manual request.

import { checkLatest, applyUpdate } from '../lib/updater.js';
import { isDaemonRunning } from '../daemon/pid.js';

export const updateCmd = async (opts: { check?: boolean } = {}): Promise<void> => {
  if (opts.check === true) {
    const { current, latest, isNewer } = await checkLatest();
    if (latest === null) {
      console.error(`hisohiso ${current} — couldn't reach GitHub Releases to check for updates.`);
      process.exitCode = 1;
      return;
    }
    if (isNewer) {
      console.log(`Update available: ${current} → ${latest}`);
      console.log('Run `hisohiso update` to install it.');
    } else {
      console.log(`hisohiso ${current} — already up to date (latest ${latest}).`);
    }
    return;
  }

  const res = await applyUpdate({ log: (m) => console.log(m) });
  switch (res.status) {
    case 'updated':
      console.log(`Updated hisohiso ${res.from} → ${res.to}.`);
      if (await isDaemonRunning()) {
        console.log(
          'A daemon is running on the previous binary — restart it to pick up the new version:\n' +
            '  hisohiso daemon stop && hisohiso daemon start\n' +
            '(or just wait for its next auto-update tick).'
        );
      }
      break;
    case 'already-latest':
      console.log(`hisohiso ${res.current} — already up to date.`);
      break;
    case 'no-release':
      console.error(`hisohiso ${res.current} — couldn't reach GitHub Releases to check for updates.`);
      process.exitCode = 1;
      break;
    case 'unsupported':
      console.error(`Can't auto-update: ${res.reason}.`);
      process.exitCode = 1;
      break;
    case 'failed':
      console.error(`Update failed: ${res.reason}. Your current binary is unchanged.`);
      process.exitCode = 1;
      break;
  }
};
