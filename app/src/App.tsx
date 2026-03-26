import { Route, Routes } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import RoomsPage from './pages/RoomsPage';
import RoomCreator from './pages/RoomCreator';
import RoomController from './pages/RoomController';
import NotFound from './pages/NotFound';

const App = () => {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/rooms" element={<RoomsPage />} />
      <Route path="/new" element={<RoomCreator />} />
      <Route path="/room" element={<RoomController />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default App;
