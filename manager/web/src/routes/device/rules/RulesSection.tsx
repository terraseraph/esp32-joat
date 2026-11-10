import type { LiveIoMap, PinConfigResponse } from "@shared/api";
import type { Rule, RuleList } from "@shared/device-api";
import { AnimatePresence, motion } from "motion/react";
import { ListChecks, Plus } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useApi } from "../../../api/useApi";
import { useCommand, useDeviceCommandResult } from "../../../api/commands";
import { useDevice } from "../../../api/devices";
import { useDeviceLive } from "../../../api/live";
import { Banner, Button, Card, Chip, EmptyState, InlineError, ProgressBar, Skeleton, Switch, useConfirm, useToast } from "../../../components/ui";
import { cx } from "../../../lib/cx";
import { formatAgo } from "../../../lib/format";
import { RuleSheet } from "./RuleSheet";
import { MAX_RULES, buildRuleToggle, describeRule, describeRuleParts, inertDestinations, ioFromPinConfig, sourcePins } from "./ruleLogic";
import "./rules.css";

interface SheetState {
  open: boolean;
  n: number;
  editing: Rule | null;
}

/** Rules list + Add/Edit rule sheet (`rule.list|set|remove`). */
export function RulesSection({ id }: { id: string }) {
  const { summary } = useDevice(id);
  const offline = summary?.health === "offline" || summary?.health === "unreachable";
  const rulesRes = useDeviceCommandResult<RuleList>(id, { cmd: "rule.list" });
  const live = useDeviceLive(id);
  // Until the live snapshot arrives, the configured pins come from the Manager's pin-config view.
  const pinCfg = useApi<PinConfigResponse>(live.hydrated ? null : `/api/devices/${encodeURIComponent(id)}/pin-config`);
  const io: LiveIoMap = useMemo(() => (live.hydrated ? live.io : pinCfg.data ? ioFromPinConfig(pinCfg.data) : live.io), [live.hydrated, live.io, pinCfg.data]);
  const cmd = useCommand(id);
  const confirm = useConfirm();
  const toast = useToast();
  const [sheet, setSheet] = useState<SheetState>({ open: false, n: 0, editing: null });
  const [busy, setBusy] = useState<string | null>(null);

  const rules = rulesRes.data?.rules ?? [];
  const loadError = rulesRes.error?.message ?? null;
  const loading = !rulesRes.data && !loadError;
  const full = rules.length >= MAX_RULES;
  const noSources = sourcePins(io).length === 0;
  const ready = Boolean(rulesRes.data);

  const open = (editing: Rule | null) => setSheet((s) => ({ open: true, n: s.n + 1, editing }));

  const toggle = async (rule: Rule, enabled: boolean) => {
    setBusy(rule.id);
    try {
      await cmd.run(buildRuleToggle(rule, enabled));
      rulesRes.reload();
    } catch (err) {
      toast({ tone: "bad", title: `Could not ${enabled ? "enable" : "disable"} rule ${rule.id}`, description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (rule: Rule) => {
    const ok = await confirm({
      title: `Delete rule ${rule.id}?`,
      body: describeRule(rule, io),
      confirmLabel: "Delete rule",
      tone: "danger",
      run: async () => {
        await cmd.run({ cmd: "rule.remove", id: rule.id });
      },
    });
    if (ok) {
      toast({ tone: "ok", title: `Deleted rule ${rule.id}` });
      rulesRes.reload();
    }
  };

  const addDisabled = offline || !ready || full || noSources;
  const addTitle = full ? "All 8 rule slots are used" : noSources ? "Configure an input, analog or output pin first" : undefined;

  return (
    <section id="rules" className="rules-sec" aria-labelledby="rules-h">
      <div className="rules-head">
        <h2 id="rules-h">
          Rules · {rules.length} / {MAX_RULES} used
        </h2>
        <div className="rules-meter">
          <ProgressBar value={(rules.length / MAX_RULES) * 100} tone={full ? "warn" : undefined} label="Rule slots used" />
        </div>
        <span className="spacer" />
        <Button variant="primary" onClick={() => open(null)} disabled={addDisabled} title={addTitle}>
          <Plus className="i" aria-hidden="true" /> Add rule
        </Button>
      </div>

      {offline && (
        <Banner tone="warn" title="This device is offline" action={<Button size="sm" onClick={() => rulesRes.reload()}>Retry</Button>}>
          Rules are shown read-only{summary?.lastSeen ? `. Last seen ${formatAgo(summary.lastSeen)}` : ""}.
        </Banner>
      )}
      {full && !offline && <Banner tone="warn">All {MAX_RULES} rule slots are used. Delete a rule to add another (editing still works).</Banner>}
      {!full && !offline && ready && noSources && <Banner tone="info">Rules watch an input, analog or output pin. Configure one in Pins first.</Banner>}

      {loadError && <InlineError message={loadError} onRetry={() => rulesRes.reload()} />}

      {loading && (
        <Card aria-busy="true" aria-label="Loading rules">
          <Skeleton variant="line" width="90%" />
          <Skeleton variant="line" width="70%" />
        </Card>
      )}

      {rulesRes.data && rules.length === 0 && (
        <EmptyState
          icon={ListChecks}
          title="No rules yet"
          action={
            <Button variant="primary" onClick={() => open(null)} disabled={addDisabled} title={addTitle}>
              <Plus className="i" aria-hidden="true" /> Add rule
            </Button>
          }
        >
          A rule switches one pin when another pin changes, for example "when GPIO 32 is above 1000 mV, turn GPIO 4 on". Rules run on the device even when the Manager is closed.
        </EmptyState>
      )}

      {rules.length > 0 && (
        <Card flush>
          <ul className="rules-list" aria-label="Rules">
            <AnimatePresence initial={false}>
              {rules.map((rule) => {
                const inert = inertDestinations(rule, io);
                return (
                  <motion.li key={rule.id} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}>
                    <div className={cx("rule", !rule.enabled && "is-off", offline && "is-offline")}>
                      <Chip mono>{rule.id}</Chip>
                      <p className="sent">
                        {describeRuleParts(rule, io).map((p, i) => (
                          <Fragment key={i}>{p.strong ? <strong>{p.text}</strong> : p.text}</Fragment>
                        ))}
                        {inert.length > 0 && <span className="inert">GPIO {inert.join(", ")} is not an output, so this rule does nothing.</span>}
                      </p>
                      <div className="ra">
                        <Switch checked={rule.enabled} onCheckedChange={(v) => void toggle(rule, v)} disabled={offline || busy === rule.id} aria-label={`Enable rule ${rule.id}`} />
                        <Button size="sm" onClick={() => open(rule)} disabled={offline}>
                          Edit
                        </Button>
                        <Button size="sm" onClick={() => void remove(rule)} disabled={offline}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </Card>
      )}

      {rules.length > 0 && <p className="hint">One rule per input pin. Rules run on the device even when the Manager is closed.</p>}

      {ready && (
        <RuleSheet
          key={sheet.n}
          open={sheet.open}
          onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))}
          deviceId={id}
          rules={rules}
          io={io}
          editing={sheet.editing}
          onSaved={() => rulesRes.reload()}
        />
      )}
    </section>
  );
}
