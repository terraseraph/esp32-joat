#!/usr/bin/env python3
"""POST de_esp32_runtime.bin to a live board (POST /api/v1/ota).

Usage:
  python tools/ota_push.py
  python tools/ota_push.py --ip 192.168.143.245
  python tools/ota_push.py --name esp-joat-test
  python tools/ota_push.py --bin D:/esp/de-esp32-build/de_esp32_runtime.bin
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import discover

DEFAULT_BIN = Path("D:/esp/de-esp32-build/de_esp32_runtime.bin")


def _pick(devices: list[dict], ip: str, name: str) -> dict:
    if ip:
        for d in devices:
            if d["ip"] == ip:
                return d
        probed = discover.probe_status(ip, timeout=2.0)
        if probed:
            return probed
        raise SystemExit(f"No de-esp32 at {ip}")
    if name:
        needle = name.lower()
        hits = [
            d
            for d in devices
            if needle in (d.get("name") or "").lower()
            or needle in (d.get("hostname") or "").lower()
            or needle in (d.get("topic_id") or "").lower()
            or needle == (d.get("id") or "").lower()
        ]
        if len(hits) == 1:
            return hits[0]
        if not hits:
            raise SystemExit(f"No device matching --name {name!r}")
        print(discover.format_table(hits), file=sys.stderr)
        raise SystemExit("Multiple matches for --name; pass --ip")
    if len(devices) == 1:
        return devices[0]
    last = (discover._load_state() or {}).get("last_ota_ip") or ""
    if last:
        for d in devices:
            if d["ip"] == last:
                return d
    print(discover.format_table(devices), file=sys.stderr)
    raise SystemExit("Multiple devices; pass --ip or --name")


def _post_bin(ip: str, blob: bytes) -> dict:
    req = urllib.request.Request(
        f"http://{ip}/api/v1/ota",
        data=blob,
        method="POST",
        headers={"Content-Type": "application/octet-stream"},
    )
    try:
        with urllib.request.urlopen(req, timeout=150) as resp:
            raw = resp.read()
        return json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return {"ok": True, "note": "non-JSON response (device may already be rebooting)"}
    except urllib.error.URLError as exc:
        # Connection drop after a successful write is common.
        return {"ok": True, "note": f"connection closed after upload: {exc}"}


def _wait_up(ip: str, attempts: int = 24) -> dict | None:
    time.sleep(4)
    for _ in range(attempts):
        st = discover.probe_status(ip, timeout=3.0)
        if st:
            return st
        time.sleep(2)
    return None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="OTA-push firmware to a live de-esp32")
    p.add_argument("--ip", default="")
    p.add_argument("--name", default="")
    p.add_argument("--bin", type=Path, default=DEFAULT_BIN)
    p.add_argument("--timeout", type=float, default=6.0)
    p.add_argument("--no-http-scan", action="store_true")
    args = p.parse_args(argv)

    bin_path = args.bin
    if not bin_path.is_file():
        print(f"missing firmware image: {bin_path}", file=sys.stderr)
        print("Build first: . .\\tools\\env.ps1; idf.py -B D:\\esp\\de-esp32-build build", file=sys.stderr)
        return 2

    blob = bin_path.read_bytes()
    devices = discover.find_devices(timeout=args.timeout, http_scan=not args.no_http_scan)
    if not devices and not args.ip:
        print("No live de-esp32 found. USB flash: .\\tools\\flash.ps1", file=sys.stderr)
        return 1

    target = _pick(devices, args.ip, args.name)
    ip = target["ip"]
    before = target.get("partition") or ""
    print(
        f"OTA {bin_path} ({len(blob)} bytes) -> {ip} "
        f"name={target.get('name') or target.get('hostname')} id={target.get('id')} slot={before}"
    )
    result = _post_bin(ip, blob)
    print(json.dumps(result, indent=2) if isinstance(result, dict) else result)
    after = _wait_up(ip)
    if not after:
        print("Upload finished but the device did not come back at the same IP.", file=sys.stderr)
        return 3
    discover.save_state([after], last_ota_ip=ip)
    print(
        f"Back: {after['ip']} name={after.get('name')} partition={after.get('partition')} "
        f"boot={after.get('boot_state')} mqtt={after.get('mqtt_prefix')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
