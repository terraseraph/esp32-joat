import type { FirmwareImage, FirmwareList } from "../../api/firmware";

export function makeImage(over: Partial<FirmwareImage> & { id: string }): FirmwareImage {
  return {
    filename: "de_esp32_runtime.bin",
    size: 1_476_000,
    version: "9dcba89",
    project: "de_esp32_runtime",
    date: "Nov 10 2026",
    time: "09:12:44",
    idfVer: "v5.4.2",
    chip: "esp32",
    source: "upload",
    addedAt: new Date().toISOString(),
    ...over,
  };
}

export function makeFirmwareList(over: Partial<FirmwareList> = {}): FirmwareList {
  return {
    images: [],
    targetId: null,
    latest: { baseUrl: "https://terraseraph.github.io/esp32-joat/", checkedAt: null, imageId: null, error: null },
    ...over,
  };
}
