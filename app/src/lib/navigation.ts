import { markInAppNavigation } from './storage';

// Navigate to another in-app screen. This app uses real full page loads (not
// client-side routing), so the unload looks identical to backgrounding the app.
// Marking the navigation first keeps the app-lock from treating it as a
// backgrounding and re-prompting for the PIN on the next screen. Plain <a href>
// navigations are covered by the global click handler in main.tsx; use this
// helper for programmatic window.location navigations.
export const navigateTo = (url: string): void => {
  markInAppNavigation();
  window.location.href = url;
};
