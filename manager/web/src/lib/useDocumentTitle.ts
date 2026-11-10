import { useEffect } from "react";

/** Browser tab title: "<title> · de-esp32 Manager". */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · de-esp32 Manager`;
  }, [title]);
}
