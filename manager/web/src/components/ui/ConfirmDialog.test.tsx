import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, ConfirmProvider, useConfirm } from "./ConfirmDialog";

function Harness({ onConfirm, typeToConfirm }: { onConfirm: () => Promise<void> | void; typeToConfirm?: string }) {
  const [open, setOpen] = useState(true);
  return <ConfirmDialog open={open} onOpenChange={setOpen} title="Forget device" body="This removes it." confirmLabel="Forget" tone="danger" typeToConfirm={typeToConfirm} onConfirm={onConfirm} />;
}

describe("ConfirmDialog", () => {
  it("gates the confirm button on the typed text", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} typeToConfirm="kitchen" />);
    const btn = screen.getByRole("button", { name: "Forget" });
    expect(btn).toBeDisabled();
    const input = screen.getByLabelText(/type/i);
    fireEvent.change(input, { target: { value: "Kitchen" } });
    expect(btn).toBeDisabled();
    fireEvent.change(input, { target: { value: "kitchen" } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows pending, then closes on success", async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Forget" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open and shows the thrown message verbatim", async () => {
    render(<Harness onConfirm={() => Promise.reject(new Error("ESP_ERR_INVALID_STATE (0x103)"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ESP_ERR_INVALID_STATE (0x103)");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget" })).toBeEnabled();
  });
});

describe("useConfirm", () => {
  it("resolves true after confirming and false after cancelling", async () => {
    const results: boolean[] = [];
    function Btn() {
      const confirm = useConfirm();
      return (
        <button onClick={() => void confirm({ title: "Sure?", confirmLabel: "Yes" }).then((ok) => results.push(ok))}>ask</button>
      );
    }
    render(
      <ConfirmProvider>
        <Btn />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByText("ask"));
    fireEvent.click(await screen.findByRole("button", { name: "Yes" }));
    await waitFor(() => expect(results).toEqual([true]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByText("ask"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(results).toEqual([true, false]));
  });
});
