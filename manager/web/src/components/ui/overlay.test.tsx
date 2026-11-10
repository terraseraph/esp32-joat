import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sheet } from "./Sheet";

describe("Sheet scroll lock", () => {
  it("locks the page scroll while open and releases it on close", () => {
    const { rerender } = render(<Sheet open onOpenChange={() => {}} title="Recover" />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(document.documentElement.classList.contains("ui-scroll-locked")).toBe(true);
    rerender(<Sheet open={false} onOpenChange={() => {}} title="Recover" />);
    expect(document.documentElement.classList.contains("ui-scroll-locked")).toBe(false);
  });
});
