import { useEffect, type RefObject } from "react";

const root = () => document.documentElement;

/**
 * Keeps the page behind a Sheet/Dialog from scrolling. Radix only blocks wheel/touch events, which
 * still lets keyboard and some trackpad scrolling through, so we also set a class the CSS uses
 * to hide the page scrollbar. Counted, so stacked overlays release it only when the last closes.
 */
let locks = 0;
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    locks += 1;
    root().classList.add("ui-scroll-locked");
    return () => {
      locks -= 1;
      if (locks <= 0) {
        locks = 0;
        root().classList.remove("ui-scroll-locked");
      }
    };
  }, [active]);
}

/**
 * Tells the toast stack how tall the sticky bar at the bottom of the page is (`--toast-lift`), so
 * toasts sit above it instead of covering its buttons.
 */
export function useToastLift(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const apply = () => root().style.setProperty("--toast-lift", `${Math.ceil(el.getBoundingClientRect().height) + 24}px`);
    apply();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root().style.removeProperty("--toast-lift");
    };
  }, [ref, active]);
}
