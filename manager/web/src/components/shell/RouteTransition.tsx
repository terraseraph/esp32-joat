import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export interface RouteTransitionProps {
  /** Changing the key swaps the content with a short fade + rise. */
  routeKey: string;
  className?: string;
  onExitComplete?: () => void;
  children: ReactNode;
}

/**
 * Cross-fade between routes (or tabs). The outgoing content stays mounted exactly as it was rendered
 * (callers must pass an explicit `location` to `<Routes>` so it does not re-match mid-exit).
 */
export function RouteTransition({ routeKey, className, onExitComplete, children }: RouteTransitionProps) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false} onExitComplete={onExitComplete}>
      <motion.div
        key={routeKey}
        className={className}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0, transition: { duration: reduce ? 0 : 0.18, ease: "easeOut" } }}
        exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.09, ease: "easeIn" } }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
