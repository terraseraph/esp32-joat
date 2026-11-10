import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { cx } from "../../lib/cx";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  tone?: "danger";
  disabled?: boolean;
}

export interface MenuProps {
  /** The trigger element (a Button, usually icon-only with an aria-label). Must accept a ref and props. */
  trigger: ReactElement;
  /** Items, or `"separator"` for a divider. */
  items: (MenuItem | "separator")[];
  align?: "start" | "center" | "end";
}

/** Dropdown menu (Radix): arrow keys, type-ahead, Esc, focus return. */
export function Menu({ trigger, items, align = "end" }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align={align} sideOffset={6} collisionPadding={8}>
          {items.map((it, i) => {
            if (it === "separator") return <DropdownMenu.Separator key={`sep-${i}`} className="ui-menu-sep" />;
            const Icon = it.icon;
            return (
              <DropdownMenu.Item key={it.label} className={cx("menu-item", it.tone === "danger" && "danger")} disabled={it.disabled} onSelect={it.onSelect}>
                {Icon && <Icon className="i sm" aria-hidden="true" />}
                {it.label}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
