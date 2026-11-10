import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Field } from "./Field";
import { NumberInput, TextInput } from "./TextInput";
import { Segmented } from "./Segmented";
import { Slider } from "./Slider";
import { TooltipProvider } from "./Tooltip";

describe("Field", () => {
  it("wires label, hint and error to the control", () => {
    render(
      <Field label="Hostname" hint="Letters and digits" error="Already in use" required>
        <TextInput value="" onChange={() => {}} />
      </Field>,
    );
    const input = screen.getByLabelText(/Hostname/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
    const described = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(described).toHaveLength(2);
    expect(document.getElementById(described[0] ?? "")).toHaveTextContent("Letters and digits");
    expect(document.getElementById(described[1] ?? "")).toHaveTextContent("Already in use");
  });

  it("has no invalid state without an error", () => {
    render(
      <Field label="Name">
        <TextInput value="a" onChange={() => {}} />
      </Field>,
    );
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
  });
});

describe("NumberInput", () => {
  it("reports numbers, undefined when empty, and clamps on blur", () => {
    const seen: (number | undefined)[] = [];
    function C() {
      const [v, setV] = useState<number | undefined>(5);
      return (
        <NumberInput aria-label="Rate" value={v} min={1} max={10} unit="Hz" onChange={(n) => { seen.push(n); setV(n); }} />
      );
    }
    render(<C />);
    const input = screen.getByLabelText("Rate") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    expect(seen).toEqual([undefined, 50, 10]);
    expect(input.value).toBe("10");
  });
});

describe("Segmented", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B", disabled: true, hint: "Not on this board" },
    { value: "c", label: "C" },
  ];
  it("moves with arrow keys, skipping disabled options", () => {
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <Segmented aria-label="Mode" value="a" onChange={onChange} options={options} />
      </TooltipProvider>,
    );
    const a = screen.getByRole("radio", { name: "A" });
    expect(a).toHaveAttribute("aria-checked", "true");
    expect(a).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(a, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("c");
  });
  it("ignores clicks on disabled options", () => {
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <Segmented aria-label="Mode" value="a" onChange={onChange} options={options} />
      </TooltipProvider>,
    );
    const b = screen.getByRole("radio", { name: "B" });
    expect(b).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(b);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Slider", () => {
  it("calls onChange and onCommit for a key step", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<Slider aria-label="Duty" value={10} min={0} max={100} step={5} onChange={onChange} onCommit={onCommit} format={(v) => `${v}%`} />);
    const thumb = screen.getByRole("slider", { name: "Duty" });
    expect(thumb).toHaveAttribute("aria-valuetext", "10%");
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(15);
    expect(onCommit).toHaveBeenCalledWith(15);
  });
});
