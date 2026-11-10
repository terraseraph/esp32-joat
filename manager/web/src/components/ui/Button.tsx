import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from "react";
import { Link, type LinkProps } from "react-router";
import { cx } from "../../lib/cx";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";

interface Look {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Square icon-only button: always pass an `aria-label`. */
  iconOnly?: boolean;
}

export function buttonClass({ variant = "default", size = "md", iconOnly }: Look, extra?: string): string {
  return cx("btn", variant !== "default" && variant, size === "sm" && "sm", iconOnly && "icon", extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Look {
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant, size, iconOnly, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, iconOnly }, className)} {...rest} />;
}

export interface ButtonLinkProps extends Look, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** In-app route (React Router `Link`). */
  to?: LinkProps["to"];
  /** External URL: opens in a new tab with `rel="noopener"`. */
  href?: string;
  ref?: Ref<HTMLAnchorElement>;
}

/** A link that looks like a button: `to` for routes, `href` for external pages. */
export function ButtonLink({ to, href, variant, size, iconOnly, className, ...rest }: ButtonLinkProps) {
  const cls = buttonClass({ variant, size, iconOnly }, className);
  if (to !== undefined) return <Link to={to} className={cls} {...rest} />;
  return <a href={href} className={cls} target="_blank" rel="noopener noreferrer" {...rest} />;
}
