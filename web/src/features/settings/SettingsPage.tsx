import type React from "react";
import { Navigate } from "react-router-dom";

export function SettingsPage(): React.ReactElement {
  return <Navigate to="/settings/2fa" replace />;
}
