import { MotionConfig } from "motion/react";
import { AppShell } from "./components/shell/AppShell";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import { ToastProvider } from "./components/ui/Toast";
import { TooltipProvider } from "./components/ui/Tooltip";
import { AppRoutes } from "./routes/AppRoutes";

/** The whole UI. It needs a Router above it (BrowserRouter in main.tsx, MemoryRouter in tests). */
export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AppShell>
              <AppRoutes />
            </AppShell>
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </MotionConfig>
  );
}
