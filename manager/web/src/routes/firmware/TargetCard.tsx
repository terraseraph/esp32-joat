import { RefreshCw, Trash2, Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import {
  deleteFirmware,
  fetchLatestFirmware,
  setFirmwareTarget,
  uploadFirmware,
  type FirmwareImage,
  type UseFirmware,
} from "../../api/firmware";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { Card, CardHead } from "../../components/ui/Card";
import { Chip } from "../../components/ui/Chip";
import { useConfirm } from "../../components/ui/ConfirmDialog";
import { errorMessage, InlineError } from "../../components/ui/InlineError";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { Skeleton } from "../../components/ui/Skeleton";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { cx } from "../../lib/cx";
import { formatAgo } from "../../lib/format";
import { ImageOption } from "./ImageOption";
import "./firmware.css";

/** Where the "latest" build comes from, shown as host + path. */
function latestSource(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}firmware/de_esp32_runtime.bin`.replace(/^https?:\/\//, "");
}

interface UploadState {
  name: string;
  /** 0..1 while sending. */
  progress: number;
  error: string | null;
  busy: boolean;
}

/** The file chooser / drop zone with progress and the server's plain rejection reason. */
export function UploadZone({ onUploaded }: { onUploaded?: (image: FirmwareImage) => void }) {
  const toast = useToast();
  const [up, setUp] = useState<UploadState | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const send = async (file: File) => {
    setUp({ name: file.name, progress: 0, error: null, busy: true });
    try {
      const { image, existing } = await uploadFirmware(file, (p) => setUp((u) => (u && u.busy ? { ...u, progress: p } : u)));
      setUp(null);
      toast({ tone: "ok", title: existing ? `${image.version} is already in your library` : `Added firmware ${image.version}`, description: image.filename });
      onUploaded?.(image);
    } catch (err) {
      setUp({ name: file.name, progress: 0, error: errorMessage(err), busy: false });
    }
  };

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void send(f);
    if (input.current) input.current.value = "";
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files);
  };

  const busy = up?.busy ?? false;
  const failed = up?.error ?? null;
  return (
    <div className={cx("field", failed && "err dz-err")}>
      <label
        className={cx("dropzone sm", over && "over")}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <input ref={input} type="file" accept=".bin" aria-label="Choose a firmware .bin file" aria-invalid={failed ? true : undefined} disabled={busy} onChange={(e) => pick(e.target.files)} />
        <Upload className="i" aria-hidden="true" />
        <strong>{up ? up.name : "Drop a .bin here or choose a file"}</strong>
        <span className="hint">Checked before use: ESP32 app image of the de_esp32_runtime project, small enough for the update slot.</span>
      </label>
      {busy && up && (
        <div className="dz-busy">
          <ProgressBar value={Math.round(up.progress * 100)} label={`Uploading ${up.name}`} />
        </div>
      )}
      {failed && (
        <div className="msg" role="alert">
          {failed}
        </div>
      )}
    </div>
  );
}

export interface TargetCardProps {
  fw: UseFirmware;
  /** How many devices differ from the current target (null when unknown). */
  differing: number | null;
  /** Devices counted (for the "x of y differ" line). */
  total: number;
}

/** Image library, the "Get latest" source and the choice of the target firmware. */
export function TargetCard({ fw, differing, total }: TargetCardProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const { latest, images, target } = fw;

  const getLatest = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const img = await fetchLatestFirmware();
      toast({ tone: "ok", title: `Latest build is ${img.version}` });
    } catch (err) {
      setFetchError(errorMessage(err));
    } finally {
      setFetching(false);
    }
  };

  const choose = async (id: string) => {
    setChoiceError(null);
    try {
      await setFirmwareTarget(id);
    } catch (err) {
      setChoiceError(errorMessage(err));
    }
  };

  const remove = async (img: FirmwareImage) => {
    await confirm({
      title: `Remove ${img.filename}?`,
      body: <>Firmware {img.version} is deleted from the Manager's library. Devices that already run it are not affected.</>,
      confirmLabel: "Remove",
      tone: "danger",
      run: async () => {
        await deleteFirmware(img.id);
      },
    });
  };

  const lastError = fetchError ?? latest?.error ?? null;
  return (
    <Card aria-labelledby="fw-target-h">
      <CardHead
        title={<span id="fw-target-h">Target firmware</span>}
        actions={<span className="mut" style={{ fontSize: "var(--fs-sm)" }}>Devices are compared by build, not by version number.</span>}
      />

      <div className="fw-latest">
        <div className="fw-latest-row">
          <strong>Latest build</strong>
          <span className="opt-src">{latest ? latestSource(latest.baseUrl) : "terraseraph.github.io/esp32-joat/firmware/de_esp32_runtime.bin"}</span>
          <span className="spacer" />
          {latest?.checkedAt && <span className="mut" style={{ fontSize: "var(--fs-sm)" }}>Checked {formatAgo(latest.checkedAt)}</span>}
          <Button size="sm" onClick={() => void getLatest()} disabled={fetching} aria-busy={fetching || undefined}>
            {fetching ? <Spinner /> : <RefreshCw className="i sm" aria-hidden="true" />}
            {latest?.checkedAt ? "Check again" : "Get latest"}
          </Button>
        </div>
        {lastError && (
          <Banner tone="warn" title="Couldn't fetch the latest build">
            {lastError} Uploaded images are still usable.
          </Banner>
        )}
      </div>

      {!fw.loaded ? (
        <Skeleton variant="block" height={96} />
      ) : fw.error && !fw.data ? (
        <InlineError message={fw.error.message} onRetry={() => void fw.reload()} />
      ) : images.length === 0 ? (
        <p className="mut" style={{ marginBottom: "var(--s3)" }}>
          No firmware yet. Get the latest build or upload a .bin file, then choose it as the target.
        </p>
      ) : (
        <fieldset className="opts">
          <legend className="sr">Target firmware image</legend>
          {images.map((img) => (
            <ImageOption
              key={img.id}
              image={img}
              name="fw-target"
              checked={target?.id === img.id}
              onSelect={() => void choose(img.id)}
              badges={
                <>
                  {target?.id === img.id && <Chip tone="acc">Target</Chip>}
                  {latest?.imageId === img.id && <Chip>Latest CI build</Chip>}
                </>
              }
              side={
                <Button size="sm" variant="ghost" aria-label={`Remove ${img.filename} (${img.version})`} onClick={() => void remove(img)}>
                  <Trash2 className="i sm" aria-hidden="true" />
                  Remove
                </Button>
              }
            />
          ))}
        </fieldset>
      )}
      {choiceError && <InlineError message={choiceError} className="fw-hint-line" />}

      {target && differing !== null && total > 0 && (
        <p className="fw-hint-line" role="status">
          {differing === 0 ? `All ${total} ${total === 1 ? "device runs" : "devices run"} ${target.version}.` : `${differing} of ${total} ${total === 1 ? "device differs" : "devices differ"} from ${target.version}.`}
        </p>
      )}

      <div style={{ marginTop: "var(--s3)" }}>
        <UploadZone />
      </div>
    </Card>
  );
}
