import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import AppLock from './components/AppLock';
import RoomsPage from './pages/RoomsPage';
import RoomCreator from './pages/RoomCreator';
import RoomController from './pages/RoomController';
import NotFound from './pages/NotFound';

// The `/` route is owned by the static launch2 marketing site (served by Caddy
// from /app/landing), not the React app. If anyone lands here through a stale
// path or in dev, send them to the marketing page so they see the canonical
// pitch instead of an orphaned PWA-flavored copy.
const LandingRedirect = () => {
  useEffect(() => {
    window.location.replace('/launch2/');
  }, []);
  return null;
};

const App = () => {
  return (
    <AppLock>
      <Routes>
        <Route path="/" element={<LandingRedirect />} />
        <Route path="/rooms" element={<RoomsPage />} />
        <Route path="/new" element={<RoomCreator />} />
        <Route path="/room" element={<RoomController />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppLock>
  );
};

export default App;
