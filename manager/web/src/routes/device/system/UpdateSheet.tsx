import { ArrowRight, Download } from "lucide-react";
import { useState } from "react";
import { useDevice } from "../../../api/devices";
import { sameBuild, startDeviceUpdate, useFirmware } from "../../../api/firmware";
import { isJobFinished, useJob, useJobs } from "../../../api/jobs";
import { Banner } from "../../../components/ui/Banner";
import { Button, ButtonLink } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { errorMessage, InlineError } from "../../../components/ui/InlineError";
import { Sheet } from "../../../components/ui/Sheet";
import { Skeleton } from "../../../components/ui/Skeleton";
import { Spinner } from "../../../components/ui/Spinner";
import { deviceTitle } from "../../../lib/format";
import { ImageOption } from "../../firmware/ImageOption";
import { eligibility, imageBuilt, isRollbackJob } from "../../firmware/logic";
import { OtaJobView } from "../../firmware/OtaJobView";
import "../../firmware/firmware.css";

export interface UpdateSheetProps {
  deviceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Update one device: pick an image (the target is preselected), see from -> to, start the job and follow it live.
 * Opened from the device header and from the Firmware card. An unfinished update of this device is shown again when reopened.
 */
export function UpdateSheet({ deviceId, open, onOpenChange }: UpdateSheetProps) {
  const { summary } = useDevice(deviceId);
  const fw = useFirmware();
  const { jobs: active } = useJobs({ kind: "ota", active: true });
  const [started, setStarted] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = active.find((j) => j.deviceIds.includes(deviceId));
  const jobId = started ?? running?.id ?? null;
  const { job } = useJob(jobId ?? undefined);
  const jobRollback = job ? isRollbackJob(job) : false;

  const imageId = choice && fw.images.some((i) => i.id === choice) ? choice : (fw.target?.id ?? fw.images[0]?.id ?? null);
  const image = fw.images.find((i) => i.id === imageId) ?? null;
  const title = summary ? deviceTitle(summary) : deviceId;
  const elig = summary ? eligibility(summary, new Set()) : null;
  const identical = summary && image ? sameBuild(summary, image) : false;

  const close = (next: boolean) => {
    if (!next && job && isJobFinished(job)) setStarted(null);
    if (!next) setError(null);
    onOpenChange(next);
  };

  const start = async () => {
    if (!imageId) return;
    setStarting(true);
    setError(null);
    try {
      const j = await startDeviceUpdate(deviceId, imageId);
      setStarted(j.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const following = jobId !== null;
  const footer = following ? (
    <Button variant={job && isJobFinished(job) ? "primary" : "default"} onClick={() => close(false)}>
      Close
    </Button>
  ) : (
    <>
      <Button onClick={() => close(false)} disabled={starting}>
        Cancel
      </Button>
      <Button variant="primary" onClick={() => void start()} disabled={!image || starting || (elig ? !elig.ok : false)} aria-busy={starting || undefined}>
        {starting ? <Spinner /> : <Download className="i" aria-hidden="true" />}
        Start update
      </Button>
    </>
  );

  return (
    <Sheet
      open={open}
      onOpenChange={close}
      title={following ? (jobRollback ? "Rolling back" : "Updating firmware") : "Update firmware"}
      description={title}
      width={520}
      footer={footer}
    >
      <div className="fw-sheet">
        {following ? (
          <OtaJobView jobId={jobId} onFollow={(id) => setStarted(id)} />
        ) : !fw.loaded ? (
          <Skeleton variant="block" height={120} />
        ) : fw.images.length === 0 ? (
          <Banner tone="info" title="No firmware in the library yet" action={<ButtonLink to="/firmware" size="sm" variant="primary">Open Firmware</ButtonLink>}>
            Get the latest build or upload a .bin file on the Firmware screen, then come back here.
          </Banner>
        ) : (
          <>
            {elig && !elig.ok && (
              <Banner tone="warn" title="This device can't be updated right now">
                {elig.note}.
              </Banner>
            )}
            <fieldset className="opts">
              <legend className="sr">Firmware to install</legend>
              {fw.images.map((img) => (
                <ImageOption
                  key={img.id}
                  image={img}
                  name="fw-update-image"
                  checked={img.id === imageId}
                  onSelect={() => setChoice(img.id)}
                  badges={fw.target?.id === img.id ? <Chip tone="acc">Target</Chip> : undefined}
                />
              ))}
            </fieldset>
            {summary && image && (
              <div className="fw-fromto" aria-label="What changes">
                <span className="mono">{summary.app_version ?? "unknown"}</span>
                <ArrowRight className="i sm arrow" aria-hidden="true" />
                <span className="mono strong">{image.version}</span>
                <span className="mut" style={{ fontSize: "var(--fs-sm)" }}>
                  built {imageBuilt(image)}
                </span>
              </div>
            )}
            {identical && <p className="hint">This device already runs this build. Starting the update installs it again.</p>}
            <p className="hint">The device restarts during the update and is offline for about 30 seconds. If the new firmware does not start properly, it goes back to the old one by itself.</p>
            {error && <InlineError message={error} />}
          </>
        )}
      </div>
    </Sheet>
  );
}
