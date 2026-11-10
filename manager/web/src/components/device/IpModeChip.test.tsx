import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IpModeChip } from "./IpModeChip";

describe("IpModeChip", () => {
  it("shows DHCP and Static, and nothing for unknown or missing modes", () => {
    const { container, rerender } = render(<IpModeChip mode="dhcp" />);
    expect(screen.getByText("DHCP")).toBeInTheDocument();
    rerender(<IpModeChip mode="static" />);
    expect(screen.getByText("Static")).toHaveClass("acc");
    for (const mode of ["unknown", null, undefined, ""]) {
      rerender(<IpModeChip mode={mode} />);
      expect(container).toBeEmptyDOMElement();
    }
  });
});
