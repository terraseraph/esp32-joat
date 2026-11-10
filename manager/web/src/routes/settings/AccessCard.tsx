import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AccessApi, AccessResponse } from "../../api/settings";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Chip } from "../../components/ui/Chip";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { errorMessage, InlineError } from "../../components/ui/InlineError";
import { Switch } from "../../components/ui/Switch";
import { Tooltip } from "../../components/ui/Tooltip";
import { useToast } from "../../components/ui/Toast";
import { CopyButton } from "./CopyButton";

const MASK = "•".repeat(12);

/** The link with its token hidden (the copy button still copies the whole link). */
function maskedLink(url: string, token: string | null): string {
  return token ? url.replace(token, MASK) : url;
}

function TokenRow({ access, shown, onToggle }: { access: AccessResponse; shown: boolean; onToggle: () => void }) {
  const token = access.token;
  if (!token) return null;
  return (
    <div className="token-row">
      <code className="token" data-testid="token">
        {shown ? token : (access.tokenMasked ?? MASK)}
      </code>
      <Tooltip label={shown ? "Hide token" : "Show token"}>
        <Button size="sm" variant="ghost" iconOnly aria-label={shown ? "Hide token" : "Reveal token"} aria-pressed={shown} onClick={onToggle}>
          {shown ? <EyeOff className="i sm" aria-hidden="true" /> : <Eye className="i sm" aria-hidden="true" />}
        </Button>
      </Tooltip>
      <CopyButton text={token} label="Copy token" />
    </div>
  );
}

/** LAN access: the on/off switch (re-binds the server), the links and token to share, and Regenerate token. */
export function AccessCard({ access: api }: { access: AccessApi }) {
  const access = api.data;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [cutOff, setCutOff] = useState(false);

  if (!access) {
    return (
      <Card aria-labelledby="s-access" aria-busy={api.loading}>
        <div className="card-head">
          <h2 id="s-access">LAN access</h2>
        </div>
        {api.loading ? (
          <div className="stack" aria-label="Loading access details">
            <span className="skeleton line" />
            <span className="skeleton line" />
          </div>
        ) : (
          <InlineError message={api.error?.message ?? "Could not load access details."} onRetry={api.reload} />
        )}
      </Card>
    );
  }

  async function apply(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setLan(enabled);
      setShown(false);
      if (enabled) toast({ tone: "ok", title: "LAN access is on", description: "Other devices need the access token." });
      else if (next.remote) setCutOff(true);
      else toast({ tone: "ok", title: "LAN access is off", description: "Other devices were disconnected." });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    const next = await api.regenerateToken();
    setShown(false);
    toast({ tone: "ok", title: "Access token regenerated", description: next.remote ? "This browser keeps access. Share the new link with everyone else." : "Share the new link with the people who should keep access." });
  }

  const on = access.lan;
  const canToggle = access.toggleAvailable;

  return (
    <Card aria-labelledby="s-access">
      <div className="card-head">
        <h2 id="s-access">LAN access</h2>
        <Chip tone={on ? "warn" : "ok"}>{on ? "LAN access on" : "This PC only"}</Chip>
      </div>
      <div className="stack">
        {cutOff && (
          <Banner tone="warn" title="LAN access is off and this device is disconnected">
            You switched it off from another device, so the Manager no longer answers here. To get back in, switch LAN access on again from the Manager PC.
          </Banner>
        )}

        <Banner tone="warn" title="Anyone with the access token can control every device">
          The devices behind the Manager have no password of their own, and the Manager uses plain http. Turn LAN access on only for a network you trust.
        </Banner>

        <Switch
          checked={on}
          disabled={busy || !canToggle}
          onCheckedChange={(next) => {
            if (next) void apply(true);
            else if (access.remote) setConfirmOff(true);
            else void apply(false);
          }}
          label="Let other devices on my network open the Manager"
          hint={on ? "On: phones and computers on your network can open it with the access link. Switching off disconnects them at once." : "Off: only this PC can open the Manager."}
        />
        <p className="set-state" role="status">
          {on ? "LAN access is on. Other devices need the access token." : "LAN access is off. Only this PC can open the Manager."}
        </p>
        {!canToggle && (
          <Banner tone="info" title="Not available here">
            {access.toggleUnavailableReason ?? "LAN access cannot be changed in this app."}
          </Banner>
        )}
        {error && <InlineError message={error} />}

        <dl className="kv">
          <dt>This PC</dt>
          <dd>
            <a href={access.localUrl}>{access.localUrl}</a>
          </dd>
          {on && (
            <>
              <dt>LAN addresses</dt>
              <dd>
                {access.lanUrls.length > 0 ? (
                  <ul className="plain-list">
                    {access.lanUrls.map((u) => (
                      <li key={u}>
                        <a href={u}>{u}</a>
                        <CopyButton text={u} label={`Copy ${u}`} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="mut">No network address found for this PC.</span>
                )}
              </dd>
              <dt>Access token</dt>
              <dd>
                <TokenRow access={access} shown={shown} onToggle={() => setShown((s) => !s)} />
              </dd>
              {access.openUrl && (
                <>
                  <dt>Link to open</dt>
                  <dd>
                    <div className="token-row">
                      <code className="token" data-testid="open-url">
                        {shown ? access.openUrl : maskedLink(access.openUrl, access.token)}
                      </code>
                      <CopyButton text={access.openUrl} label="Copy link with token" />
                    </div>
                    <div className="hint">Open this on a phone or another computer. The token moves into a cookie and leaves the address bar.</div>
                  </dd>
                </>
              )}
            </>
          )}
        </dl>

        {on && (
          <div className="row">
            <Button onClick={() => setConfirmRotate(true)}>
              <RefreshCw className="i sm" aria-hidden="true" /> Regenerate token
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Switch LAN access off?"
        tone="danger"
        confirmLabel="Switch off"
        body={
          <>
            <p>You are using the Manager from another device. Switching LAN access off disconnects every other device, including this one, until someone switches it on again on the Manager PC.</p>
          </>
        }
        onConfirm={() => apply(false)}
      />
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Regenerate the access token?"
        tone="danger"
        confirmLabel="Regenerate token"
        body={
          <>
            <p>Every other browser or phone that uses the current link or has opened it before loses access at once and needs the new link.</p>
            <p>{access.remote ? "This browser keeps access." : "This PC is not affected."}</p>
          </>
        }
        onConfirm={rotate}
      />
    </Card>
  );
}
