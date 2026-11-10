import type { ReactNode } from "react";
import { OverlayFrame } from "./Overlay";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Modal width (px or CSS length), default 480. */
  width?: number | string;
  tone?: "default" | "danger";
  /** Block Esc / outside click / close while something is running. */
  locked?: boolean;
  hideClose?: boolean;
}

/** Centered modal. Radix Dialog: focus trap, Esc, scroll lock, focus returns to the trigger. */
export function Dialog(props: DialogProps) {
  return <OverlayFrame variant="modal" {...props} />;
}
