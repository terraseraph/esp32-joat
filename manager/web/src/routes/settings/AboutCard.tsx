import type { HealthResponse } from "@shared/api";
import { ExternalLink } from "lucide-react";
import { INSTALLER_URL } from "../../api/settings";
import { ButtonLink } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { KeyValue } from "../../components/ui/KeyValue";
import { CopyButton } from "./CopyButton";

/** Data folder (read-only). Comes from `GET /api/health`, which only callers that passed the security check can read. */
export function DataCard({ health }: { health: HealthResponse | null }) {
  return (
    <Card aria-labelledby="s-data">
      <div className="card-head">
        <h2 id="s-data">Data folder</h2>
      </div>
      {health ? (
        <div className="path-row">
          <code className="mono" data-testid="data-dir">
            {health.dataDir}
          </code>
          <CopyButton text={health.dataDir} label="Copy data folder path" />
        </div>
      ) : (
        <p className="mut">Not available yet.</p>
      )}
      <p className="hint">The registry, settings, backups and firmware library live here. Back it up to keep them.</p>
    </Card>
  );
}

export function AboutCard({ health }: { health: HealthResponse | null }) {
  return (
    <Card aria-labelledby="s-about">
      <div className="card-head">
        <h2 id="s-about">About</h2>
      </div>
      <div className="stack">
        <KeyValue
          items={[
            { label: "Version", value: health ? `de-esp32 Manager ${health.version}` : null },
            { label: "Started", value: health?.startedAt !== undefined ? new Date(health.startedAt).toLocaleString() : null },
          ]}
        />
        <div className="row">
          <ButtonLink href={INSTALLER_URL}>
            Browser installer <ExternalLink className="i sm" aria-hidden="true" />
          </ButtonLink>
        </div>
      </div>
    </Card>
  );
}
