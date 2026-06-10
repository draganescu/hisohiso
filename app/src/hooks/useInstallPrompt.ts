import { useCallback, useEffect, useState } from 'react';

// Chromium fires `beforeinstallprompt` with this shape when the PWA is
// installable. It isn't in the DOM lib types, so we model the bits we use.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

// True once the app is running as an installed PWA (standalone display, or the
// legacy iOS Safari `navigator.standalone`). When installed there's nothing to
// prompt, so the affordance hides itself.
const detectStandalone = (): boolean => {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return window.matchMedia?.('(display-mode: standalone)').matches === true || iosStandalone;
};

// iOS/iPadOS has no install API — the only path is the Safari share sheet — so
// we detect it to swap the native prompt for an instructions modal. iPadOS 13+
// masquerades as MacIntel, hence the touch-points check.
const detectIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iosDevice = /iphone|ipad|ipod/i.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iosDevice || iPadOS;
};

export type InstallPromptState = {
  // Whether to show the install affordance at all.
  canInstall: boolean;
  // Tap behaviour: iOS has no native prompt, so the caller opens a modal.
  isIOS: boolean;
  // Trigger the native Chromium install dialog. Returns 'unavailable' when
  // there's no deferred prompt (e.g. iOS) so the caller can fall back.
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
};

export const useInstallPrompt = (): InstallPromptState => {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(detectStandalone);
  const isIOS = detectIOS();

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // Stop Chromium's mini-infobar; we drive install from our own button.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferred) return 'unavailable';
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    return outcome;
  }, [deferred]);

  // Show the card when not already installed AND we have a real path: a
  // captured Chromium prompt, or iOS where the modal guides the share sheet.
  const canInstall = !installed && (deferred !== null || isIOS);

  return { canInstall, isIOS, promptInstall };
};
