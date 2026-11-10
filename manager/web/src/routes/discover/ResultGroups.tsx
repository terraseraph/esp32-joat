import type { DiscoveryResult } from "@shared/api";
import { AlertTriangle, Clock, Info, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Button, ButtonLink } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { cx } from "../../lib/cx";
import { resultSub, resultTitle, viaLabels } from "./display";
import type { DiscoveryGroups, IgnoredEntry } from "./grouping";

const ROW_MOTION = {
  layout: "position" as const,
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: { duration: 0.15 } },
  transition: { duration: 0.2, ease: "easeOut" as const },
};

function RowMain({ r }: { r: DiscoveryResult }) {
  const title = resultTitle(r);
  return (
    <div className="res-main">
      <div className="res-name">{title}</div>
      <div className="res-sub">{resultSub(r).join(" · ")}</div>
    </div>
  );
}

function RowMeta({ r }: { r: DiscoveryResult }) {
  const fw = r.app_version || r.fw;
  return (
    <div className="res-meta">
      {fw && (
        <Chip mono title={r.app_version ? "Firmware build" : "Firmware version"}>
          {fw}
        </Chip>
      )}
      {viaLabels(r.via).map((v) => (
        <Chip key={v} title="How this board was found">
          {v}
        </Chip>
      ))}
    </div>
  );
}

interface RowProps {
  r: DiscoveryResult;
  busy: boolean;
  onAdd(id: string): void;
  onIgnore?(id: string): void;
}

function NewRow({ r, busy, onAdd, onIgnore }: RowProps) {
  const title = resultTitle(r);
  return (
    <motion.li layoutId={`res-${r.id}`} {...ROW_MOTION} className="res-row" data-id={r.id}>
      <RowMain r={r} />
      <RowMeta r={r} />
      <div className="res-act">
        <Button size="sm" variant="primary" disabled={busy} aria-busy={busy} aria-label={`Add ${title}`} onClick={() => onAdd(r.id)}>
          Add
        </Button>
        {onIgnore && (
          <Button size="sm" disabled={busy} aria-label={`Ignore ${title}`} onClick={() => onIgnore(r.id)}>
            Ignore
          </Button>
        )}
      </div>
    </motion.li>
  );
}

function SetupRow({ r, busy, onAdd }: RowProps) {
  const title = resultTitle(r);
  return (
    <motion.li layoutId={`res-${r.id}`} {...ROW_MOTION} className="res-row" data-id={r.id}>
      <RowMain r={r} />
      <div className="res-meta">
        <Chip tone="warn">Setup AP open</Chip>
        {r.netState && <Chip mono>{r.netState}</Chip>}
        {(r.app_version || r.fw) && <Chip mono>{r.app_version || r.fw}</Chip>}
      </div>
      <div className="res-act">
        <Button size="sm" variant="primary" disabled={busy} aria-busy={busy} aria-label={`Add ${title}`} onClick={() => onAdd(r.id)}>
          Add
        </Button>
        <ButtonLink size="sm" href={`http://${r.host}/`} aria-label={`Open device page for ${title}`}>
          Open device page ↗
        </ButtonLink>
      </div>
      <div className="res-note t-warn">
        <AlertTriangle className="i sm" aria-hidden="true" />
        <p>
          This board has no working Wi-Fi connection, so it opened its Setup AP, a Wi-Fi network of its own
          {r.hostname ? (
            <>
              {" "}
              called <code>{r.hostname}</code>
            </>
          ) : null}
          . It still answers on this network right now, so you can add it, but it may drop off. Setting up its Wi-Fi from here is not available yet.
        </p>
      </div>
    </motion.li>
  );
}

function KnownRow({ r }: { r: DiscoveryResult }) {
  return (
    <motion.li layoutId={`res-${r.id}`} {...ROW_MOTION} className={cx("res-row compact", r.ipChanged && "hl")} data-id={r.id}>
      <RowMain r={r} />
      <div className="res-meta">
        {r.ipChanged && <Chip tone="acc">IP changed</Chip>}
        <RowMeta r={r} />
      </div>
      <div className="res-act">
        <ButtonLink to={`/devices/${r.id}/live`} size="sm" variant={r.ipChanged ? "default" : "ghost"} aria-label={`Open ${resultTitle(r)}`}>
          Open
        </ButtonLink>
      </div>
      {r.ipChanged && (
        <div className="res-note">
          <Info className="i sm" aria-hidden="true" style={{ color: "var(--acc)" }} />
          <p>
            IP changed from <span className="mono">{r.ipChanged.from}</span> to <span className="mono">{r.ipChanged.to}</span>, updated automatically.
          </p>
        </div>
      )}
    </motion.li>
  );
}

function IgnoredRow({ e, busy, onUnignore }: { e: IgnoredEntry; busy: boolean; onUnignore(id: string): void }) {
  const r = e.result;
  const title = r ? resultTitle(r) : e.id;
  return (
    <motion.li layoutId={`res-${e.id}`} {...ROW_MOTION} className="res-row compact" data-id={e.id}>
      <div className="res-main">
        <div className={cx("res-name", !r && "mono")}>{title}</div>
        <div className="res-sub">{r ? resultSub(r).join(" · ") : "Not shown in New while ignored"}</div>
      </div>
      <div className="res-act">
        <Button size="sm" disabled={busy} aria-label={`Un-ignore ${title}`} onClick={() => onUnignore(e.id)}>
          Un-ignore
        </Button>
      </div>
    </motion.li>
  );
}

function GroupHead({ id, title, count, hint, children }: { id: string; title: string; count: number; hint?: string; children?: ReactNode }) {
  return (
    <>
      <h2 id={id}>{title}</h2>
      <span className="badge">{count}</span>
      {hint && <span className="mut grp-hint">{hint}</span>}
      {children}
    </>
  );
}

interface Props {
  groups: DiscoveryGroups;
  busy: ReadonlySet<string>;
  onAdd(ids: string[]): void;
  onIgnore(id: string): void;
  onUnignore(id: string): void;
}

/** The four result groups: New, In setup / recovery, Already in fleet, Ignored (collapsed). */
export function ResultGroups({ groups, busy, onAdd, onIgnore, onUnignore }: Props) {
  const { fresh, setup, known, ignored } = groups;
  const addAllBusy = fresh.some((r) => busy.has(r.id));
  return (
    <>
      <AnimatePresence initial={false}>
        {fresh.length > 0 && (
          <motion.section key="g-new" className="card flush" aria-labelledby="g-new" layout="position" exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <div className="grp-head">
              <GroupHead id="g-new" title="New" count={fresh.length} hint="Not in your fleet yet">
                <span className="spacer" />
                {fresh.length > 1 && (
                  <Button size="sm" variant="primary" disabled={addAllBusy} aria-busy={addAllBusy} onClick={() => onAdd(fresh.map((r) => r.id))}>
                    <Plus className="i sm" aria-hidden="true" />
                    Add all ({fresh.length})
                  </Button>
                )}
              </GroupHead>
            </div>
            <ul className="res">
              <AnimatePresence initial={false}>
                {fresh.map((r) => (
                  <NewRow key={r.id} r={r} busy={busy.has(r.id)} onAdd={(id) => onAdd([id])} onIgnore={onIgnore} />
                ))}
              </AnimatePresence>
            </ul>
          </motion.section>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {setup.length > 0 && (
          <motion.section key="g-rec" className="card flush" aria-labelledby="g-rec" layout="position" exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <div className="grp-head">
              <GroupHead id="g-rec" title="In setup / recovery" count={setup.length} hint="Boards that opened their own Wi-Fi (Setup AP)" />
            </div>
            <ul className="res">
              <AnimatePresence initial={false}>
                {setup.map((r) => (
                  <SetupRow key={r.id} r={r} busy={busy.has(r.id)} onAdd={(id) => onAdd([id])} />
                ))}
              </AnimatePresence>
            </ul>
          </motion.section>
        )}
      </AnimatePresence>

      {known.length > 0 && (
        <details className="card flush grp" open>
          <summary className="grp-head">
            <GroupHead id="g-known" title="Already in fleet" count={known.length} hint="Updated automatically, nothing to do" />
          </summary>
          <ul className="res" aria-labelledby="g-known">
            <AnimatePresence initial={false}>
              {known.map((r) => (
                <KnownRow key={r.id} r={r} />
              ))}
            </AnimatePresence>
          </ul>
        </details>
      )}

      {ignored.length > 0 && (
        <details className="card flush grp">
          <summary className="grp-head">
            <GroupHead id="g-ignored" title="Ignored" count={ignored.length} hint="Hidden from results" />
          </summary>
          <ul className="res" aria-labelledby="g-ignored">
            <AnimatePresence initial={false}>
              {ignored.map((e) => (
                <IgnoredRow key={e.id} e={e} busy={busy.has(e.id)} onUnignore={onUnignore} />
              ))}
            </AnimatePresence>
          </ul>
        </details>
      )}
    </>
  );
}

export function WaitingCard() {
  return (
    <div className="card res-wait" aria-live="polite">
      <Clock className="i" aria-hidden="true" />
      <p className="mut">Boards appear here as they answer.</p>
    </div>
  );
}
