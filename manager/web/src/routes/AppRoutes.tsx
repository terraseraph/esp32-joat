import { Route, Routes, useLocation } from "react-router";
import { RouteTransition } from "../components/shell/RouteTransition";
import { BackupsPage } from "./BackupsPage";
import { DevicePage } from "./DevicePage";
import { DiscoverPage } from "./DiscoverPage";
import { FirmwarePage } from "./FirmwarePage";
import { FleetPage } from "./FleetPage";
import { NotFoundPage } from "./NotFoundPage";
import { SettingsPage } from "./SettingsPage";

/** All top-level routes; switching section cross-fades (keyed by the first path segment). */
export function AppRoutes() {
  const location = useLocation();
  const section = location.pathname.split("/")[1] ?? "";
  return (
    <RouteTransition routeKey={section} className="page-body" onExitComplete={() => window.scrollTo(0, 0)}>
      {/* explicit location: the outgoing page must not re-match the new URL while it fades out */}
      <Routes location={location}>
        <Route path="/" element={<FleetPage />} />
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/firmware" element={<FirmwarePage />} />
        <Route path="/backups" element={<BackupsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/devices/:id/*" element={<DevicePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </RouteTransition>
  );
}
