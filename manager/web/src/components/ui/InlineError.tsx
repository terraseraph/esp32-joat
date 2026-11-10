import { CircleAlert, RotateCw } from "lucide-react";
import { cx } from "../../lib/cx";
import { Button } from "./Button";

/** Text of anything thrown: `Error.message` as is, strings as is, everything else stringified. Never reworded. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export interface InlineErrorProps {
  /** Shown verbatim (device error strings are the useful part). */
  message: string;
  /** Shows a Retry button. */
  onRetry?: () => void;
  /** Disables Retry while a retry is running. */
  retrying?: boolean;
  className?: string;
}

/** Compact error line with an optional Retry, for failures inside a card, form or dialog. */
export function InlineError({ message, onRetry, retrying, className }: InlineErrorProps) {
  return (
    <div className={cx("ui-inline-error", className)} role="alert">
      <CircleAlert className="i sm" aria-hidden="true" />
      <span className="ui-inline-error-msg mono">{message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry} disabled={retrying}>
          <RotateCw className="i sm" aria-hidden="true" /> Retry
        </Button>
      )}
    </div>
  );
}
