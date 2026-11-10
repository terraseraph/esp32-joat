import type { DeviceSummary } from "@shared/api";
import { AlertTriangle, Check, Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { cx } from "../../lib/cx";
import { postJsonWithStatus } from "./api";
import { deviceTitle } from "./display";
import { addDeviceErrorMessage } from "./errors";
import { validateHost } from "./hostInput";

interface Added {
  id: string;
  title: string;
  /** false when the device was already in the fleet (its address was updated). */
  created: boolean;
}

/** "Add by IP" card: validates the address as you type, then `POST /api/devices`. */
export function ManualAdd({ onAdded }: { onAdded(): void }) {
  const uid = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);

  const check = value.trim() ? validateHost(value) : null;
  const clientError = touched ? (check && !check.ok ? check.message : null) : null;
  const error = serverError ?? clientError;
  const msgId = `${uid}-msg`;
  const hintId = `${uid}-hint`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setAdded(null);
    setServerError(null);
    const result = validateHost(value);
    if (!result.ok) {
      setTouched(true);
      setServerError(result.message);
      return;
    }
    setBusy(true);
    try {
      const { status, data } = await postJsonWithStatus<DeviceSummary>("/api/devices", { host: result.host });
      setAdded({ id: data.id, title: deviceTitle(data), created: status === 201 });
      setValue("");
      setTouched(false);
      onAdded();
    } catch (err) {
      setServerError(err instanceof ApiError ? addDeviceErrorMessage(err, result.host) : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card aria-labelledby="addip-h">
      <h2 id="addip-h" className="side-h">
        Add by IP
      </h2>
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <div className={cx("field", error && "err")}>
          <label htmlFor={`${uid}-host`}>IP address or hostname</label>
          <input
            id={`${uid}-host`}
            name="host"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setServerError(null);
              setAdded(null);
            }}
            onBlur={() => setTouched(true)}
            autoComplete="off"
            spellCheck={false}
            placeholder="192.168.1.50 or esp32-b3c4d5.local"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${msgId} ${hintId}` : hintId}
          />
          {error && (
            <div className="msg" id={msgId} role="alert">
              <AlertTriangle className="i sm" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          <div className="hint" id={hintId}>
            The Manager checks <code>/api/v1/status</code> on that address and adds it if it's a de-esp32 board. A port is fine: <code>192.168.1.50:8080</code>.
          </div>
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            <Plus className="i" aria-hidden="true" />
            {busy ? "Checking…" : "Add device"}
          </Button>
        </div>
      </form>
      {added && (
        <div className="banner ok add-ok" role="status">
          <Check className="i" aria-hidden="true" />
          <div className="txt">
            <strong>{added.created ? `Added ${added.title}` : "Already in your fleet, address updated"}</strong>
            <div>
              <Link to={`/devices/${added.id}/live`}>{added.created ? "Open" : `Open ${added.title}`}</Link>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
