import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

export type BannerTone = "info" | "warn" | "bad" | "ok";

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Usually a `<Button size="sm">`; sits to the right (below on narrow widths). */
  action?: ReactNode;
  className?: string;
}

const ICONS = { info: Info, warn: TriangleAlert, bad: CircleAlert, ok: CircleCheck } as const;

/** Full-width notice: offline, safe mode, errors. `bad` is announced as an alert, the rest politely. */
export function Banner({ tone = "info", title, children, action, className }: BannerProps) {
  const Icon = ICONS[tone];
  return (
    <div className={cx("banner", tone !== "info" && tone, className)} role={tone === "bad" ? "alert" : "status"}>
      <Icon className="i" aria-hidden="true" />
      <div className="txt">
        {title && <strong>{title}</strong>}
        {children && <div className={cx(Boolean(title) && "ui-banner-body")}>{children}</div>}
      </div>
      {action && <div className="act">{action}</div>}
    </div>
  );
}
