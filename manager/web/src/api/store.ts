import { useSyncExternalStore } from "react";

/** Minimal observable store; read it in React with `useStore`. */
export interface Store<T> {
  get(): T;
  /** Replace the value (or derive it from the previous one). Equal values (Object.is) do not notify. */
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Subscribe a component to a store. With a selector the component re-renders only when the selected
 * value changes; the selector must return a primitive or a stable reference (not a fresh object).
 */
export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S;
export function useStore<T, S>(store: Store<T>, selector?: (state: T) => S): T | S {
  const read = () => (selector ? selector(store.get()) : store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
