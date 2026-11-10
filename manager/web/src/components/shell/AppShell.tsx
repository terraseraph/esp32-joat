import type { MouseEvent, ReactNode } from "react";
import { SideNav } from "./SideNav";

function skipToContent(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  document.getElementById("main")?.focus();
}

/** Skip link, side nav (rail / top bar when narrow) and the scrolling page area. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <a className="skip-link" href="#main" onClick={skipToContent}>
        Skip to content
      </a>
      <SideNav />
      <main className="page" id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
