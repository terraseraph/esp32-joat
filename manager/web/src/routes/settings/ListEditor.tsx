import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field } from "../../components/ui/Field";
import { TextInput } from "../../components/ui/TextInput";

export interface ListEditorProps {
  label: string;
  hint?: string;
  placeholder?: string;
  items: string[];
  onChange: (items: string[]) => void;
  /** Server validation messages by entry index (shown verbatim under the entry). */
  errors?: Record<number, string>;
  disabled?: boolean;
}

/** Add/remove editor for a list of strings (discovery targets, extra subnets). Validation is the server's: it names the bad entry. */
export function ListEditor({ label, hint, placeholder, items, onChange, errors = {}, disabled }: ListEditorProps) {
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  function add() {
    const value = draft.trim();
    if (!value) {
      setAddError("Type an address first.");
      return;
    }
    if (items.includes(value)) {
      setAddError(`${value} is already in the list.`);
      return;
    }
    onChange([...items, value]);
    setDraft("");
    setAddError(null);
  }

  return (
    <div className="list-editor">
      <Field label={label} hint={hint} error={addError}>
        <div className="le-add">
          <TextInput
            value={draft}
            onChange={(v) => {
              setDraft(v);
              setAddError(null);
            }}
            placeholder={placeholder}
            mono
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button onClick={add} disabled={disabled} aria-label={`Add to ${label}`}>
            <Plus className="i sm" aria-hidden="true" /> Add
          </Button>
        </div>
      </Field>
      {items.length > 0 ? (
        <ul className="le-list" aria-label={`${label} (added)`}>
          {items.map((item, i) => (
            <li key={item} className={errors[i] ? "bad" : undefined}>
              <div className="le-row">
                <code className="mono">{item}</code>
                <Button size="sm" variant="ghost" iconOnly aria-label={`Remove ${item}`} disabled={disabled} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                  <X className="i sm" aria-hidden="true" />
                </Button>
              </div>
              {errors[i] && (
                <div className="msg" role="alert">
                  {errors[i]}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint le-empty">None added.</p>
      )}
    </div>
  );
}
