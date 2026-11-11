import { LayoutGrid, Plus, Radar, RefreshCw, SearchX } from "lucide-react";
import { Banner, Button, ButtonLink, Card, EmptyState, Skeleton } from "../../components/ui";

export const INSTALLER_URL = "https://terraseraph.github.io/esp32-joat/";

export function FleetSkeleton() {
  return (
    <div className="grid" style={{ "--min": "340px" } as React.CSSProperties} aria-busy="true" aria-label="Loading devices">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="stack">
          <Skeleton variant="title" />
          <Skeleton width="80%" />
          <Skeleton variant="block" />
        </Card>
      ))}
    </div>
  );
}

export function EmptyFleet({ onScan, onAdd }: { onScan: () => void; onAdd: () => void }) {
  return (
    <EmptyState
      icon={LayoutGrid}
      title="No devices yet"
      action={
        <>
          <div className="actions fleet-empty-actions">
            <Button variant="primary" onClick={onScan}>
              <Radar className="i" aria-hidden="true" />
              Scan network
            </Button>
            <Button onClick={onAdd}>
              <Plus className="i" aria-hidden="true" />
              Add by IP
            </Button>
          </div>
          <a href={INSTALLER_URL} target="_blank" rel="noopener noreferrer">
            First time? Flash a board with the browser installer ↗
          </a>
        </>
      }
    >
      Scan your network to find boards running de-esp32, or add one by its IP address.
    </EmptyState>
  );
}

export function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState icon={SearchX} title="No devices match" action={<Button onClick={onClear}>Clear search and filters</Button>}>
      Try a different search or choose All.
    </EmptyState>
  );
}

export function AllOfflineBanner({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <Banner
      tone="warn"
      title="Can't reach any device"
      action={
        <>
          <Button size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCw className="i sm" aria-hidden="true" />
            Retry all
          </Button>
          <ButtonLink to="/discover" size="sm">
            Scan network
          </ButtonLink>
        </>
      }
    >
      Is this PC on the same network as your boards?
    </Banner>
  );
}
