import { useSyncExternalStore } from "react";

/** Live `matchMedia` match; false where matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  const subscribe = (cb: () => void) => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
    mq?.addEventListener("change", cb);
    return () => mq?.removeEventListener("change", cb);
  };
  const read = () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  return useSyncExternalStore(subscribe, read, () => false);
}
