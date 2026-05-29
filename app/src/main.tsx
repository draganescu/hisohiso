import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { markInAppNavigation } from './lib/storage';
import './styles.css';

// Same-origin <a> navigations are full page loads here; mark them so the
// app-lock does not mistake the unload for a backgrounding and re-prompt for
// the PIN on the next screen. Programmatic navigations use navigateTo() in
// lib/navigation.ts instead. Capture phase so we see the click even if a
// handler later stops propagation; we never preventDefault.
document.addEventListener(
  'click',
  (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    // In-page hash jumps are not navigations; external links / new tabs leave
    // the app and may legitimately background it.
    if (!href || href.startsWith('#')) return;
    const target = anchor.getAttribute('target');
    if (target && target !== '_self') return;
    let url: URL;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    markInAppNavigation();
  },
  true,
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // No-op: app works without offline support
    });
  });
}

let appHeightRaf = 0;
const updateAppHeight = () => {
  cancelAnimationFrame(appHeightRaf);
  appHeightRaf = requestAnimationFrame(() => {
    const height = window.visualViewport?.height ?? window.innerHeight;
    const offsetTop = window.visualViewport?.offsetTop ?? 0;
    document.documentElement.style.setProperty('--app-height', `${height}px`);
    document.documentElement.style.setProperty('--app-offset', `${offsetTop}px`);
    if (document.documentElement.classList.contains('scroll-locked')) {
      window.scrollTo(0, 0);
    }
  });
};

updateAppHeight();
window.addEventListener('resize', updateAppHeight);
window.visualViewport?.addEventListener('resize', updateAppHeight);
window.visualViewport?.addEventListener('scroll', updateAppHeight);
