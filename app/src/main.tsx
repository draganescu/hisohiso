import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
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
    if (document.body.classList.contains('no-scroll')) {
      window.scrollTo(0, 0);
    }
  });
};

updateAppHeight();
window.addEventListener('resize', updateAppHeight);
window.visualViewport?.addEventListener('resize', updateAppHeight);
window.visualViewport?.addEventListener('scroll', updateAppHeight);
