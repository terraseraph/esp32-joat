import { Button } from "../../components/ui/Button";
import { InlineError } from "../../components/ui/InlineError";
import { Spinner } from "../../components/ui/Spinner";

export interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  /** false while the draft is not valid (client-side range checks). */
  canSave?: boolean;
  /** The server's error message, shown verbatim. */
  error: string | null;
  onSave: () => void;
  onRevert: () => void;
}

/** Save / Revert row at the bottom of a settings card. */
export function SaveBar({ dirty, saving, canSave = true, error, onSave, onRevert }: SaveBarProps) {
  return (
    <div className="save-bar">
      {error && <InlineError message={error} />}
      <div className="row">
        <Button variant="primary" onClick={onSave} disabled={!dirty || !canSave || saving} aria-busy={saving || undefined}>
          {saving && <Spinner />}
          Save
        </Button>
        <Button onClick={onRevert} disabled={!dirty || saving}>
          Revert
        </Button>
      </div>
    </div>
  );
}
