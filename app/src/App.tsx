import { Navigate, Route, Routes } from 'react-router-dom';
import AppLock from './components/AppLock';
import RoomsPage from './pages/RoomsPage';
import RoomCreator from './pages/RoomCreator';
import RoomController from './pages/RoomController';
import NotFound from './pages/NotFound';
import { useTheme } from './lib/theme';

// `/` used to escape the SPA to the static landing Caddy served at the root.
// The landing moved to the marketing host (www.hisohiso.org), so the root now
// belongs to the app — send it to the rooms list. (The old full-page
// `location.replace('/')` would reload `/` forever now that the SPA owns it.)
const LandingRedirect = () => <Navigate to="/rooms" replace />;

const App = () => {
  // Subscribed at the root so the persisted choice and the system-preference
  // listener stay live on every route, even where no toggle is mounted.
  useTheme();
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
