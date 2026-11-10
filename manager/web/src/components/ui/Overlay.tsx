import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { useScrollLock } from "../../lib/overlayState";
import { Button } from "./Button";

export interface OverlayFrameProps {
  variant: "sheet" | "modal";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  tone?: "default" | "danger";
  /** Esc, outside click and the close button do nothing while true (e.g. a request is running). */
  locked?: boolean;
  /** Hide the X button (use when the footer has Cancel). */
  hideClose?: boolean;
}

/** Shared Radix Dialog frame behind `Sheet` and `Dialog`: overlay, header, scrolling body, sticky footer. */
export function OverlayFrame({ variant, open, onOpenChange, title, description, children, footer, width, tone, locked, hideClose }: OverlayFrameProps) {
  const style = width !== undefined ? ({ "--ui-w": typeof width === "number" ? `${width}px` : width } as CSSProperties) : undefined;
  useScrollLock(open);
  return (
    <RD.Root open={open} onOpenChange={(o) => (locked && !o ? undefined : onOpenChange(o))}>
      <RD.Portal>
        <RD.Overlay className="ui-overlay" />
        <RD.Content
          className={cx("ui-panel", variant === "sheet" ? "ui-sheet" : "ui-modal", tone === "danger" && "danger")}
          style={style}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="dlg-head">
            <div className="ui-dlg-titles">
              <RD.Title asChild>
                <h2>{title}</h2>
              </RD.Title>
              {description && (
                <RD.Description asChild>
                  <p className="mut">{description}</p>
                </RD.Description>
              )}
            </div>
            {!hideClose && (
              <RD.Close asChild>
                <Button variant="ghost" iconOnly size="sm" aria-label="Close" disabled={locked}>
                  <X className="i" aria-hidden="true" />
                </Button>
              </RD.Close>
            )}
          </div>
          <div className="dlg-body ui-dlg-body">{children}</div>
          {footer && <div className="dlg-foot">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
