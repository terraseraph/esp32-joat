import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorMessage, InlineError } from "./InlineError";
import { Spinner } from "./Spinner";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** The user must type this exactly (case-sensitive) before the confirm button enables. */
  typeToConfirm?: string;
  /**
   * Runs on confirm. While it is pending the buttons are disabled and the dialog cannot be dismissed.
   * Resolve: the dialog closes. Throw: the error's message is shown verbatim and the dialog stays open.
   */
  onConfirm: () => Promise<void> | void;
}

/** Confirmation modal with pending state, inline error and optional type-to-confirm. */
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, cancelLabel = "Cancel", tone = "default", typeToConfirm, onConfirm }: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTyped("");
      setError(null);
    }
  }

  const ready = !typeToConfirm || typed === typeToConfirm;

  const run = async () => {
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      tone={tone}
      locked={pending}
      hideClose
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={run} disabled={!ready || pending} aria-busy={pending || undefined}>
            {pending && <Spinner />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <div className="ui-confirm-body">{body}</div>}
      {typeToConfirm && (
        <div className="field">
          <label htmlFor="ui-confirm-type">
            Type <code>{typeToConfirm}</code> to confirm
          </label>
          <input
            id="ui-confirm-type"
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={pending}
          />
        </div>
      )}
      {error && <InlineError message={error} />}
    </Dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: "default" | "danger";
  typeToConfirm?: string;
  /** Optional async work run inside the dialog (pending + inline error). Without it, resolves on click. */
  run?: () => Promise<void> | void;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Mount once (App does). `const confirm = useConfirm(); if (await confirm({ title, tone: "danger", run })) ...`
 * Resolves true after the user confirmed (and `run` succeeded), false when cancelled.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; open: boolean } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const settled = useRef(false);

  const confirm = useCallback<ConfirmFn>((opts) => {
    resolver.current?.(false);
    settled.current = false;
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setState({ opts, open: true });
    });
  }, []);

  const finish = (ok: boolean) => {
    if (settled.current) return;
    settled.current = true;
    resolver.current?.(ok);
    resolver.current = null;
  };

  const opts = state?.opts;
  return (
    <ConfirmContext value={confirm}>
      {children}
      {opts && (
        <ConfirmDialog
          open={state.open}
          onOpenChange={(o) => {
            if (!o) {
              setState((s) => (s ? { ...s, open: false } : s));
              finish(false);
            }
          }}
          title={opts.title}
          body={opts.body}
          confirmLabel={opts.confirmLabel ?? "Confirm"}
          tone={opts.tone}
          typeToConfirm={opts.typeToConfirm}
          onConfirm={async () => {
            await opts.run?.();
            finish(true);
          }}
        />
      )}
    </ConfirmContext>
  );
}

/** Imperative confirmation; needs `ConfirmProvider` above (App mounts it). */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  return useMemo(() => fn ?? (() => Promise.resolve(false)), [fn]);
}
