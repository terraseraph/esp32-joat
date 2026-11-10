import { TriangleAlert } from "lucide-react";
import type { BackupPlan } from "../../api/backups";
import { Banner } from "../../components/ui/Banner";
import { Chip } from "../../components/ui/Chip";
import { MARK_CHAR, PLAN_GROUPS, countsText, nameLine, stepMark, stepSummaryText } from "./labels";

/** True when applying this plan would change something on a reachable target. */
export const planHasWork = (p: BackupPlan): boolean => p.reachable && p.steps.length > 0;

function Unchanged({ plan }: { plan: BackupPlan }) {
  const u = plan.unchanged;
  if (u.pins + u.modules + u.rules === 0) return null;
  return <p className="hint">Already matching: {countsText(u)}.</p>;
}

/** The new name this plan sets, or null when the name stays as it is. */
const renameTo = (p: BackupPlan): string | null => {
  const s = p.steps.find((x) => x.op === "identity.set_name");
  return s && typeof s.cmd.name === "string" ? s.cmd.name : null;
};

/** The dry run for one target: steps in apply order, conflicts in amber, "no changes" and "can't be reached" states. */
export function PlanView({ plan }: { plan: BackupPlan }) {
  const noChanges = plan.reachable && plan.steps.length === 0 && plan.conflicts.length === 0;
  const groups = PLAN_GROUPS.map((g) => ({ ...g, steps: plan.steps.filter((s) => g.ops.includes(s.op)) })).filter((g) => g.steps.length > 0);
  return (
    <section className="bk-plan" aria-label={`Plan for ${plan.targetName}`}>
      <h3 className="bk-plan-head">
        <span>{plan.targetName}</span>
        {!plan.reachable && <Chip tone="bad">Can't be reached</Chip>}
        {plan.reachable && plan.steps.length > 0 && <Chip>{plan.steps.length === 1 ? "1 step" : `${plan.steps.length} steps`}</Chip>}
      </h3>

      {!plan.reachable && (
        <Banner tone="bad" title={`${plan.targetName} can't be reached`}>
          {plan.error ? `${plan.error} ` : ""}It is left out. Check that it is online, then review again.
        </Banner>
      )}

      {noChanges && (
        <>
          <Banner tone="ok">This device already matches. There is nothing to change.</Banner>
          <Unchanged plan={plan} />
        </>
      )}

      {plan.reachable && plan.conflicts.length > 0 && (
        <ul className="diff" aria-label="Conflicts">
          {plan.conflicts.map((c) => (
            <li key={c.message} className="conflict">
              <TriangleAlert className="i sm t-warn" aria-hidden="true" />
              <span>
                <strong>Conflict.</strong> {c.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {plan.reachable && groups.length > 0 && (
        <ol className="plan">
          {groups.map((g, i) => (
            <li key={g.title} className="plan-step">
              <h4>
                <span className="n">{i + 1}</span>
                {g.title}
              </h4>
              <ul className="diff">
                {g.steps.map((s) => {
                  const mark = stepMark(s.op);
                  return (
                    <li key={s.id} className={mark}>
                      <span className="mk" aria-hidden="true">
                        {MARK_CHAR[mark]}
                      </span>
                      <span>{stepSummaryText(s.summary)}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {plan.reachable && <p className="hint" data-testid="plan-name">{nameLine(plan.targetName, renameTo(plan))}</p>}

      {plan.reachable && plan.steps.length > 0 && <Unchanged plan={plan} />}

      {plan.warnings.length > 0 && (
        <Banner tone="warn">
          <ul className="bk-gap-list">
            {plan.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}
    </section>
  );
}
