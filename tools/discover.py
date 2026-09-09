#!/usr/bin/env python3
"""Find de-esp32 boards on the LAN.

1. Probe last-seen IPs from tools/lan_state.json
2. mDNS browse _http._tcp.local (ESP advertises this + A record)
3. HTTP GET /api/v1/status on each local interface /24

No extra pip packages. Windows mDNS is flaky; the HTTP sweep is the fallback.

Usage:
  python tools/discover.py
  python tools/discover.py --json
  python tools/discover.py --timeout 8
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import socket
import struct
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

STATE_PATH = Path(__file__).resolve().parent / "lan_state.json"
MDNS_GROUP = "224.0.0.251"
MDNS_PORT = 5353
HTTP_TIMEOUT = 0.6
STATUS_PATH = "/api/v1/status"


def _load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def save_state(devices: list[dict], last_ota_ip: str | None = None) -> None:
    prev = _load_state()
    state = {
        "ips": [d["ip"] for d in devices],
        "devices": devices,
        "last_ota_ip": last_ota_ip if last_ota_ip is not None else prev.get("last_ota_ip", ""),
    }
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def local_ipv4s() -> list[str]:
    found: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                found.append(ip)
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        found.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    out: list[str] = []
    for ip in found:
        if ip not in out:
            out.append(ip)
    return out


def _is_ours(st: dict) -> bool:
    if not isinstance(st, dict):
        return False
    ota = st.get("ota") or {}
    if ota.get("project") == "de_esp32_runtime":
        return True
    hn = str(st.get("hostname") or "")
    if hn.startswith("esp32-"):
        return True
    chip = str(st.get("chip") or "")
    if chip.startswith("ESP32") and isinstance(st.get("id"), str) and len(st["id"]) == 12:
        return True
    return False


def probe_status(ip: str, timeout: float = HTTP_TIMEOUT) -> dict | None:
    url = f"http://{ip}{STATUS_PATH}"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(8192)
        st = json.loads(raw.decode("utf-8", errors="replace"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError, TimeoutError):
        return None
    if not _is_ours(st):
        return None
    mqtt = st.get("mqtt") or {}
    ota = st.get("ota") or {}
    return {
        "ip": ip,
        "id": st.get("id") or "",
        "name": st.get("name") or "",
        "hostname": st.get("hostname") or "",
        "fw": st.get("fw") or "",
        "mqtt_prefix": mqtt.get("prefix") or "",
        "topic_id": st.get("topic_id") or mqtt.get("topic_id") or "",
        "partition": ota.get("running_partition") or "",
        "boot_state": st.get("boot_state") or "",
        "via": "http",
    }


def _mdns_query() -> bytes:
    # PTR _http._tcp.local
    qname = b"".join(len(l).to_bytes(1, "big") + l for l in (b"_http", b"_tcp", b"local")) + b"\x00"
    header = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0)
    question = qname + struct.pack("!HH", 12, 1)  # PTR IN
    return header + question


def _read_name(pkt: bytes, offset: int, hops: int = 0) -> tuple[str, int]:
    if hops > 10 or offset >= len(pkt):
        return "", offset
    labels = []
    jumped = False
    end = offset
    while offset < len(pkt):
        length = pkt[offset]
        if length == 0:
            offset += 1
            if not jumped:
                end = offset
            break
        if (length & 0xC0) == 0xC0:
            if offset + 1 >= len(pkt):
                break
            ptr = ((length & 0x3F) << 8) | pkt[offset + 1]
            if not jumped:
                end = offset + 2
            jumped = True
            extra, _ = _read_name(pkt, ptr, hops + 1)
            if extra:
                labels.append(extra)
            break
        offset += 1
        labels.append(pkt[offset : offset + length].decode("utf-8", errors="replace"))
        offset += length
        if not jumped:
            end = offset
    return ".".join(labels), end


def _parse_mdns_ips(pkt: bytes) -> list[str]:
    if len(pkt) < 12:
        return []
    _, _, qd, an, ns, ar = struct.unpack("!HHHHHH", pkt[:12])
    offset = 12
    ips: list[str] = []
    try:
        for _ in range(qd):
            _, offset = _read_name(pkt, offset)
            offset += 4
        records = an + ns + ar
        for _ in range(records):
            name, offset = _read_name(pkt, offset)
            if offset + 10 > len(pkt):
                break
            rtype, _, _, rdlen = struct.unpack("!HHIH", pkt[offset : offset + 10])
            offset += 10
            rdata = pkt[offset : offset + rdlen]
            offset += rdlen
            if rtype == 1 and rdlen == 4:  # A
                ips.append(socket.inet_ntoa(rdata))
            elif rtype == 16:  # TXT — only used to prefer our boards
                pass
            _ = name
    except (struct.error, IndexError, OSError):
        return ips
    return ips


def mdns_candidate_ips(seconds: float = 2.0) -> list[str]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    ips: list[str] = []
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", 0))
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        try:
            mreq = struct.pack("=4s4s", socket.inet_aton(MDNS_GROUP), socket.inet_aton("0.0.0.0"))
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        except OSError:
            pass
        query = _mdns_query()
        deadline = time.time() + seconds
        sock.sendto(query, (MDNS_GROUP, MDNS_PORT))
        sock.settimeout(0.25)
        while time.time() < deadline:
            try:
                data, _addr = sock.recvfrom(2048)
            except socket.timeout:
                sock.sendto(query, (MDNS_GROUP, MDNS_PORT))
                continue
            for ip in _parse_mdns_ips(data):
                if ip not in ips and not ip.startswith("127."):
                    ips.append(ip)
    except OSError:
        return ips
    finally:
        sock.close()
    return ips


def subnet_hosts(ip: str) -> list[str]:
    net = ipaddress.ip_network(ip + "/24", strict=False)
    own = ipaddress.ip_address(ip)
    return [str(h) for h in net.hosts() if h != own]


def find_devices(timeout: float = 6.0, http_scan: bool = True) -> list[dict]:
    """Return de-esp32 device dicts, unique by id (fallback ip)."""
    candidates: list[str] = []
    state = _load_state()
    for ip in state.get("ips") or []:
        if ip not in candidates:
            candidates.append(ip)
    last = state.get("last_ota_ip") or ""
    if last and last not in candidates:
        candidates.append(last)

    mdns_budget = min(2.5, timeout * 0.4)
    for ip in mdns_candidate_ips(mdns_budget):
        if ip not in candidates:
            candidates.append(ip)

    probe_ips = list(candidates)
    if http_scan:
        hosts: list[str] = []
        for lip in local_ipv4s():
            hosts.extend(subnet_hosts(lip))
        for h in hosts:
            if h not in probe_ips:
                probe_ips.append(h)

    found: dict[str, dict] = {}
    workers = min(48, max(8, os.cpu_count() or 8) * 4)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(probe_status, ip): ip for ip in probe_ips}
        for fut in as_completed(futs):
            dev = fut.result()
            if not dev:
                continue
            key = dev["id"] or dev["ip"]
            via = "mdns+http" if futs[fut] in candidates else "http"
            dev["via"] = via
            found[key] = dev

    devices = sorted(found.values(), key=lambda d: (d.get("name") or d.get("hostname") or d["ip"]))
    save_state(devices)
    return devices


def format_table(devices: list[dict]) -> str:
    if not devices:
        return "No de-esp32 devices found on this LAN."
    lines = [f"Found {len(devices)} device" + ("s" if len(devices) != 1 else "") + ":"]
    for d in devices:
        host = d.get("hostname") or "?"
        lines.append(
            f"  {d['ip']:<16}  {d.get('name') or host:<20}  {host}.local  "
            f"id={d.get('id')}  fw={d.get('fw')}  mqtt={d.get('mqtt_prefix') or '—'}  via={d.get('via')}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Find de-esp32 boards on the LAN")
    p.add_argument("--json", action="store_true", help="print JSON array")
    p.add_argument("--timeout", type=float, default=6.0)
    p.add_argument("--no-http-scan", action="store_true", help="mDNS + last-seen only")
    args = p.parse_args(argv)
    devices = find_devices(timeout=args.timeout, http_scan=not args.no_http_scan)
    if args.json:
        print(json.dumps(devices, indent=2))
    else:
        print(format_table(devices))
    return 0 if devices else 1


if __name__ == "__main__":
    sys.exit(main())
