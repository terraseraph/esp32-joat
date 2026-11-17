/** Messages the API pushes over `GET /api/ws` when files change on disk (see api/watch.ts, app/src/useChangeFeed.ts). */
export type ChangeEvent =
  /** sent once when a socket connects; a client that was offline before treats it as "re-check everything" */
  | { type: "hello"; at: number }
  /** files inside one design folder changed (`files` are design-relative paths) */
  | { type: "design"; name: string; files: string[]; at: number }
  /** a shared block in hardware/lib changed, which can change every design that imports it */
  | { type: "lib"; files: string[]; at: number }
  /** a design folder was added, removed or renamed */
  | { type: "designs"; at: number }
  /** an order record or package changed */
  | { type: "orders"; at: number }
