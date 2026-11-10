import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./Toast";

function Probe({ tone = "ok", title = "Saved" }: { tone?: "ok" | "bad"; title?: string }) {
  const toast = useToast();
  return <button onClick={() => toast({ tone, title, description: "GPIO 4" })}>go</button>;
}

afterEach(() => vi.useRealTimers());

describe("Toast", () => {
  it("shows a toast in a polite live region and dismisses it by button", async () => {
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByLabelText("Notifications")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByLabelText("Dismiss notification"));
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull());
  });

  it("auto-dismisses after 5 s, errors later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <Probe />
        <Probe tone="bad" title="Failed" />
      </ToastProvider>,
    );
    const buttons = screen.getAllByText("go");
    fireEvent.click(buttons[0] as HTMLElement);
    fireEvent.click(buttons[1] as HTMLElement);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    await act(async () => void vi.advanceTimersByTime(5100));
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull());
    expect(screen.getByText("Failed")).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(4500));
    await waitFor(() => expect(screen.queryByText("Failed")).toBeNull());
  });

  it("runs the action and dismisses", async () => {
    const onClick = vi.fn();
    function A() {
      const toast = useToast();
      return <button onClick={() => toast({ tone: "info", title: "Update", action: { label: "Undo", onClick } })}>go</button>;
    }
    render(
      <ToastProvider>
        <A />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Update")).toBeNull());
  });
});
