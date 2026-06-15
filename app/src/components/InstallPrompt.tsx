import { useState, type ReactNode } from 'react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';

// The iOS share glyph (rounded box with an upward arrow) drawn inline so it
// matches the toolbar icon the user is looking for, in any theme.
const ShareGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M12 3v12" />
    <path d="M8 7l4-4 4 4" />
    <path d="M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
  </svg>
);

const Step = ({ n, children }: { n: number; children: ReactNode }) => (
  <li className="flex items-start gap-3">
    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-rule text-xs font-semibold text-ink">
      {n}
    </span>
    <span className="text-sm leading-6 text-ink-soft">{children}</span>
  </li>
);

const IosInstallModal = ({ onClose }: { onClose: () => void }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6"
    onClick={onClose}
    role="presentation"
  >
    <div
      className="w-full max-w-sm rounded-[22px] border border-rule bg-surface p-6 text-ink shadow-[0_20px_60px_-20px_rgba(10,10,10,0.3)]"
      onClick={(event) => event.stopPropagation()}
    >
      <p className="text-[0.6875rem] uppercase tracking-[0.32em] text-ink-dim">install</p>
      <h2 className="mt-2 text-xl font-bold tracking-[-0.02em]">add to your home screen</h2>
      <p className="mt-2 text-sm text-ink-soft">
        iphone installs web apps from the share sheet — it takes two taps.
      </p>

      <ol className="mt-5 flex flex-col gap-4">
        <Step n={1}>
          tap the{' '}
          <span className="inline-flex items-center gap-1 rounded-md border border-rule px-1.5 py-0.5 align-middle font-medium text-ink">
            <ShareGlyph className="h-4 w-4" />
            share
          </span>{' '}
          button in Safari&rsquo;s toolbar.
        </Step>
        <Step n={2}>
          scroll and choose <span className="font-medium text-ink">add to home screen</span>.
        </Step>
        <Step n={3}>
          open hisohiso from the new icon — notifications only work from there.
        </Step>
      </ol>

      <p className="mt-5 rounded-2xl border border-rule bg-overlay-soft px-4 py-3 text-xs leading-5 text-ink-soft">
        use <span className="font-medium text-ink">Safari</span> — other browsers on iphone can&rsquo;t install web apps.
      </p>

      <button
        className="mt-6 w-full btn-primary"
        onClick={onClose}
        type="button"
      >
        got it
      </button>
    </div>
  </div>
);

// Single install affordance for the channels home. One button: on Chromium it
// fires the native install dialog; on iOS it opens the share-sheet modal. Hides
// itself when the app is already installed, when there's no install path, or
// once dismissed for the session.
const InstallPrompt = () => {
  const { canInstall, isIOS, promptInstall } = useInstallPrompt();
  const [showModal, setShowModal] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => typeof sessionStorage !== 'undefined' && sessionStorage.getItem('hisohiso.install.dismissed') === '1',
  );

  if (!canInstall || dismissed) return null;

  const handleInstall = async () => {
    const result = await promptInstall();
    if (result === 'unavailable' && isIOS) {
      setShowModal(true);
    }
  };

  const handleDismiss = () => {
    try {
      sessionStorage.setItem('hisohiso.install.dismissed', '1');
    } catch {
      /* private mode — just hide for now */
    }
    setDismissed(true);
  };

  return (
    <>
      <section className="glass-panel flex items-center gap-4 rounded-[28px] p-5 sm:p-6">
        <img
          src="/icons/icon-192.png"
          alt=""
          className="h-12 w-12 shrink-0 rounded-2xl border border-rule sm:h-14 sm:w-14"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-[-0.015em] sm:text-lg">install hisohiso</h2>
          <p className="mt-1 text-sm leading-5 text-ink-soft">
            add it to your home screen for push notifications and one-tap access.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            className="-mr-1 flex h-6 w-6 items-center justify-center rounded-full text-ink-dim transition hover:bg-overlay-soft hover:text-ink"
            onClick={handleDismiss}
            type="button"
            aria-label="dismiss"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <button
            className="btn-primary"
            onClick={() => void handleInstall()}
            type="button"
          >
            install
          </button>
        </div>
      </section>

      {showModal && <IosInstallModal onClose={() => setShowModal(false)} />}
    </>
  );
};

export default InstallPrompt;
