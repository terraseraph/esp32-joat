import * as RT from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

/** Mount once near the root. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RT.Provider delayDuration={250} skipDelayDuration={300}>
      {children}
    </RT.Provider>
  );
}

export interface TooltipProps {
  label: ReactNode;
  /** The trigger; must accept a ref and props (any DOM element or forwardRef component). */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  /** Keep the tooltip closed (e.g. when the label is already visible). */
  disabled?: boolean;
}

export function Tooltip({ label, children, side = "top", disabled }: TooltipProps) {
  return (
    <RT.Root open={disabled ? false : undefined}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content className="tip" side={side} sideOffset={8} collisionPadding={8}>
          {label}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
