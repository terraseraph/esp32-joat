import type { ReactNode } from "react";
import { OverlayFrame } from "./Overlay";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Sticky bar under the scrolling body, usually Cancel + Save buttons. */
  footer?: ReactNode;
  /** Panel width on desktop (px or CSS length), default 480. Below 768px it is a full-width bottom sheet. */
  width?: number | string;
  /** Block Esc / outside click / close while something is saving. */
  locked?: boolean;
}

/** Right-hand side panel (bottom sheet on narrow screens). Radix Dialog: focus trap, Esc, scroll lock. */
export function Sheet(props: SheetProps) {
  return <OverlayFrame variant="sheet" {...props} />;
}
