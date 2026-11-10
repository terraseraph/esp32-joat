import type { ReactNode } from "react";
import type { FirmwareImage } from "../../api/firmware";
import { Chip } from "../../components/ui/Chip";
import { formatAgo, formatBytes } from "../../lib/format";
import { imageBuilt } from "./logic";
import "./firmware.css";

export interface ImageOptionProps {
  image: FirmwareImage;
  /** Radio group name. */
  name: string;
  checked: boolean;
  onSelect: () => void;
  /** Extra chips after the version (Target, Latest CI build ...). */
  badges?: ReactNode;
  /** Right-hand side (Remove, checked-at ...). */
  side?: ReactNode;
  disabled?: boolean;
}

/** One firmware image as a radio option: version, project, build time, ESP-IDF, size and where it came from. */
export function ImageOption({ image, name, checked, onSelect, badges, side, disabled }: ImageOptionProps) {
  const added = formatAgo(image.addedAt);
  return (
    <div className="opt" data-image-id={image.id}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} aria-label={`Firmware ${image.version} (${image.filename})`} />
      <span className="opt-main" onClick={disabled ? undefined : onSelect}>
        <span className="opt-title">
          <span className="mono">{image.version}</span>
          <Chip tone="ok">{image.project}</Chip>
          {badges}
        </span>
        <span className="opt-meta">
          <span>Built {imageBuilt(image)}</span>
          <span>ESP-IDF {image.idfVer}</span>
          <span>{formatBytes(image.size)}</span>
          <span>{image.source === "latest" ? "Downloaded" : "Uploaded"} {added}</span>
        </span>
        <span className="opt-src">{image.filename}</span>
      </span>
      {side && <span className="opt-side">{side}</span>}
    </div>
  );
}
