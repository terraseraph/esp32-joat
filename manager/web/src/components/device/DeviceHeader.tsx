import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, Ellipsis, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cx } from "../../lib/cx";
import { Button, ButtonLink } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { Tooltip } from "../ui/Tooltip";
import "./deviceShell.css";

export interface DeviceAction {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** In-app route. */
  to?: string;
  /** External page (opens in a new tab). */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Stays visible as a button when the header is narrow; everything else moves into "More". */
  primary?: boolean;
  danger?: boolean;
  /** Shows a spinner instead of the icon and disables the action. */
  pending?: boolean;
  /** Explains the action (shown on hover/focus, also when it is disabled). */
  tooltip?: string;
}

export interface DeviceHeaderProps {
  title: string;
  /** Mono secondary line, e.g. `hostname · IP · id`. */
  subtitle?: string;
  chips?: ReactNode;
  actions: DeviceAction[];
  backTo?: string;
  backLabel?: string;
}

function ActionButton({ action }: { action: DeviceAction }) {
  const Icon = action.icon;
  const variant = action.primary ? "primary" : action.danger ? "danger" : "default";
  const content = (
    <>
      {action.pending ? <Spinner /> : Icon && <Icon className="i" aria-hidden="true" />}
      {action.label}
    </>
  );
  const off = action.disabled || action.pending;
  let el;
  if (off || (!action.to && !action.href)) {
    el = (
      <Button variant={variant} disabled={off} aria-busy={action.pending || undefined} onClick={action.onSelect}>
        {content}
      </Button>
    );
  } else if (action.to) {
    el = <ButtonLink variant={variant} to={action.to}>{content}</ButtonLink>;
  } else {
    el = <ButtonLink variant={variant} href={action.href}>{content}</ButtonLink>;
  }
  if (!action.tooltip) return el;
  // A disabled button gets no pointer events, so the tooltip hangs off a wrapper.
  return (
    <Tooltip label={action.tooltip}>
      <span className="dh-tip" tabIndex={off ? 0 : undefined}>
        {el}
      </span>
    </Tooltip>
  );
}

function MenuEntry({ action }: { action: DeviceAction }) {
  const Icon = action.icon;
  const content = (
    <>
      {Icon && <Icon className="i sm" aria-hidden="true" />}
      {action.label}
    </>
  );
  const cls = cx("menu-item", action.danger && "danger");
  if (action.disabled || action.pending) {
    return (
      <DropdownMenu.Item className={cls} disabled title={action.tooltip}>
        {content}
      </DropdownMenu.Item>
    );
  }
  if (action.to) {
    return (
      <DropdownMenu.Item className={cls} asChild>
        <Link to={action.to}>{content}</Link>
      </DropdownMenu.Item>
    );
  }
  if (action.href) {
    return (
      <DropdownMenu.Item className={cls} asChild>
        <a href={action.href} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      </DropdownMenu.Item>
    );
  }
  return (
    <DropdownMenu.Item className={cls} onSelect={action.onSelect} title={action.tooltip}>
      {content}
    </DropdownMenu.Item>
  );
}

/**
 * Shared header for every device screen. Layout is driven by the header's own width (container
 * queries, see app.css): all actions inline when wide, otherwise primary action(s) + a "More" menu,
 * and a single column on very narrow containers. The title and subtitle truncate; chips wrap.
 */
export function DeviceHeader({ title, subtitle, chips, actions, backTo = "/", backLabel = "Fleet" }: DeviceHeaderProps) {
  const primary = actions.filter((a) => a.primary);
  const rest = actions.filter((a) => !a.primary);
  return (
    <div className="device-head-box">
      <header className="device-head">
        <Link className="back" to={backTo}>
          <ArrowLeft className="i sm" aria-hidden="true" /> {backLabel}
        </Link>
        <div className="dh-id">
          <div className="device-title">
            <h1 title={title}>{title}</h1>
          </div>
          {subtitle && (
            <p className="device-sub mono" title={subtitle}>
              {subtitle}
            </p>
          )}
          {chips && <div className="chips">{chips}</div>}
        </div>
        <div className="dh-actions">
          <div className="dh-full" role="group" aria-label="Device actions">
            {actions.map((a) => (
              <ActionButton key={a.key} action={a} />
            ))}
          </div>
          <div className="dh-compact">
            {primary.map((a) => (
              <ActionButton key={a.key} action={a} />
            ))}
            {rest.length > 0 && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button iconOnly aria-label="More actions">
                    <Ellipsis className="i" aria-hidden="true" />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="menu" align="end" sideOffset={6} collisionPadding={8}>
                    {rest.map((a) => (
                      <MenuEntry key={a.key} action={a} />
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </div>
        </div>
      </header>
    </div>
  );
}
