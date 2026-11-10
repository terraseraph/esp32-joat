import { fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFirmware } from "../api/firmware";
import { resetApiForTests } from "../api/testing";
import { FakeWebSocket } from "../test/fakes";
import { makeStatus, makeSummary, renderWithProviders, routeFetch } from "./device/system/testkit";
import { DevicePage } from "./DevicePage";
import { makeFirmwareList, makeImage } from "./firmware/fixtures";

const ID = "a4cf12b3c4d5";
const BASE = `/api/devices/${ID}`;

beforeEach(() => {
  resetApiForTests();
  resetFirmware();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  resetFirmware();
  vi.unstubAllGlobals();
});

function page(devices = [makeSummary()]) {
  routeFetch({
    "GET /api/devices": { body: devices },
    "GET /api/jobs": { body: [] },
    "GET /api/firmware": { body: makeFirmwareList({ images: [makeImage({ id: "aaa111", version: "1234567" })], targetId: "aaa111" }) },
    [`GET ${BASE}/v1/status`]: { body: makeStatus() },
    [`GET ${BASE}/v1/ota`]: { body: makeStatus().ota },
  });
  return renderWithProviders(
    <Routes>
      <Route path="/devices/:id/*" element={<DevicePage />} />
    </Routes>,
    `/devices/${ID}/system`,
  );
}

describe("DevicePage update action", () => {
  it("opens the update sheet from the header", async () => {
    page();
    const group = await screen.findByRole("group", { name: "Device actions" });
    fireEvent.click(within(group).getByRole("button", { name: "Update" }));
    const sheet = await screen.findByRole("dialog", { name: "Update firmware" });
    expect(await within(sheet).findByText("1234567", { selector: ".mono.strong" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Start update" })).toBeEnabled();
  });

  it("is disabled, with the reason, while the device is offline", async () => {
    page([makeSummary({ health: "offline" })]);
    const group = await screen.findByRole("group", { name: "Device actions" });
    expect(within(group).getByRole("button", { name: "Update" })).toBeDisabled();
  });
});
