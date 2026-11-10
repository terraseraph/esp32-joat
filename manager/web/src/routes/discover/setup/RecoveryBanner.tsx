import { useSetupRecovery } from "../../../api/setup";
import { Banner, Button, Spinner } from "../../../components/ui";

/** An interrupted setup may have left this PC on a device's Wi-Fi: offer to reconnect (never automatic). */
export function RecoveryBanner() {
  const r = useSetupRecovery();
  if (!r.pending && !r.message) return null;
  const was = r.marker?.originalSsid;
  return (
    <div className="su-stack">
      {r.pending && (
        <Banner
          tone="warn"
          title="An earlier setup did not finish"
          action={
            <span className="su-acts">
              <Button size="sm" variant="primary" disabled={r.busy !== null} onClick={() => void r.restore()}>
                {r.busy === "restore" && <Spinner />}
                Restore network
              </Button>
              <Button size="sm" disabled={r.busy !== null} onClick={() => void r.dismiss()}>
                Dismiss
              </Button>
            </span>
          }
        >
          This PC may still be on a device's setup Wi-Fi{was ? <> instead of <strong>{was}</strong></> : null}. Restore network reconnects it and removes the temporary Wi-Fi entries. Dismiss if your PC is already back on its own network.
        </Banner>
      )}
      {r.message && <Banner tone={r.message.tone === "ok" ? "ok" : "bad"}>{r.message.text}</Banner>}
    </div>
  );
}
