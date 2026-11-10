"""Host spec for the safe Wi-Fi change in network_manager (mirrors network_try_sta, not a C parser).

Keep classify_failure() in step with components/network_manager/src/network_manager.cpp.
"""
import unittest

# wifi_err_reason_t values from ESP-IDF 5.4 esp_wifi_types_generic.h
AUTH_EXPIRE = 2
ASSOC_LEAVE = 8
MIC_FAILURE = 14
FOURWAY_HANDSHAKE_TIMEOUT = 15
IEEE_802_1X_AUTH_FAILED = 23
BEACON_TIMEOUT = 200
NO_AP_FOUND = 201
AUTH_FAIL = 202
ASSOC_FAIL = 203
HANDSHAKE_TIMEOUT = 204
NO_AP_FOUND_W_COMPATIBLE_SECURITY = 210
NO_AP_FOUND_IN_AUTHMODE_THRESHOLD = 211
NO_AP_FOUND_IN_RSSI_THRESHOLD = 212

NO_AP = {NO_AP_FOUND, NO_AP_FOUND_W_COMPATIBLE_SECURITY, NO_AP_FOUND_IN_AUTHMODE_THRESHOLD,
         NO_AP_FOUND_IN_RSSI_THRESHOLD}
AUTH = {AUTH_FAIL, AUTH_EXPIRE, FOURWAY_HANDSHAKE_TIMEOUT, HANDSHAKE_TIMEOUT, MIC_FAILURE,
        IEEE_802_1X_AUTH_FAILED}


def classify_failure(associated, reason):
    if associated:
        return "no_ip"
    if reason == 0:
        return "timeout"
    if reason in NO_AP:
        return "no_ap"
    if reason in AUTH:
        return "auth"
    return "connect_failed"


def record_reason(last, reason):
    """Event handler: our own disconnect (ASSOC_LEAVE) does not overwrite the test's reason."""
    return last if reason == ASSOC_LEAVE else reason


class Device:
    """State that matters for a Wi-Fi change: NVS creds, live STA target, radio mode."""

    def __init__(self, saved=None, mode="STA", want_ap=False):
        self.nvs = saved            # (ssid, password) or None
        self.sta = saved            # what the STA is pointed at
        self.mode = mode
        self.want_ap = want_ap
        self.restore_sta_only = False
        self.change = {"result": "none"}
        self.seq = 0
        self.busy = False
        self.ap_clients = 0
        self.connecting = False   # STA told to connect now (False = wait for background retry)

    def try_sta(self, ssid, password, outcome, reason=0, associated=False):
        """outcome: 'got_ip' or 'fail' (FAIL_BIT or timeout). Returns True on success."""
        if not ssid:
            raise ValueError("ssid required")
        if self.busy:
            return False
        prev = self.nvs
        prev_sta_only = self.mode == "STA" and not self.want_ap
        self.restore_sta_only = False
        self.seq += 1
        self.change = {"result": "testing", "ssid": ssid, "seq": self.seq}
        self.mode = "APSTA"
        self.sta = (ssid, password)
        if outcome == "got_ip":
            return True
        self.change = {"result": "failed", "ssid": ssid, "seq": self.seq,
                       "reason": classify_failure(associated, reason),
                       "restored_previous": prev is not None}
        if prev is not None:
            self.restore_sta_only = prev_sta_only
            self.sta = prev
            # rollback_sta: with a client on the SoftAP only restore the config.
            self.connecting = self.ap_clients == 0
        return False

    def commit(self, ssid, password):
        self.nvs = (ssid, password)
        self.want_ap = True
        self.change = dict(self.change, result="ok", reason="")

    def got_ip(self):
        if self.restore_sta_only:
            self.restore_sta_only = False
            self.want_ap = False
            self.mode = "STA"

    def reboot(self):
        self.sta = self.nvs
        self.mode = "STA" if self.nvs else "APSTA"
        self.want_ap = self.nvs is None
        self.change = {"result": "none"}

    def wifi_set(self, ssid, password, outcome, **kw):
        """command_router network.wifi.set"""
        if self.try_sta(ssid, password, outcome, **kw):
            self.commit(ssid, password)
            return {"ok": True}
        return {"ok": False, "error": "wifi test failed; credentials not saved"}


class ClassifyTest(unittest.TestCase):
    def test_wrong_password(self):
        for r in AUTH:
            self.assertEqual(classify_failure(False, r), "auth")

    def test_ssid_not_found(self):
        for r in NO_AP:
            self.assertEqual(classify_failure(False, r), "no_ap")

    def test_no_dhcp(self):
        self.assertEqual(classify_failure(True, 0), "no_ip")
        self.assertEqual(classify_failure(True, AUTH_FAIL), "no_ip")

    def test_silence_is_timeout(self):
        self.assertEqual(classify_failure(False, 0), "timeout")

    def test_other(self):
        self.assertEqual(classify_failure(False, ASSOC_FAIL), "connect_failed")
        self.assertEqual(classify_failure(False, BEACON_TIMEOUT), "connect_failed")

    def test_own_disconnect_ignored(self):
        self.assertEqual(record_reason(AUTH_FAIL, ASSOC_LEAVE), AUTH_FAIL)
        self.assertEqual(record_reason(0, ASSOC_LEAVE), 0)
        self.assertEqual(record_reason(0, NO_AP_FOUND), NO_AP_FOUND)


class ChangeTest(unittest.TestCase):
    HOME = ("home", "goodpass")

    def test_wrong_password_rolls_back(self):
        d = Device(saved=self.HOME)
        r = d.wifi_set("home", "typo", "fail", reason=FOURWAY_HANDSHAKE_TIMEOUT)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], "wifi test failed; credentials not saved")
        self.assertEqual(d.nvs, self.HOME)
        self.assertEqual(d.sta, self.HOME)
        self.assertEqual(d.change["reason"], "auth")
        self.assertTrue(d.change["restored_previous"])
        d.got_ip()
        self.assertEqual(d.mode, "STA")
        self.assertFalse(d.want_ap)

    def test_ssid_not_found_rolls_back(self):
        d = Device(saved=self.HOME)
        d.wifi_set("nope", "x", "fail", reason=NO_AP_FOUND)
        self.assertEqual(d.sta, self.HOME)
        self.assertEqual(d.change["reason"], "no_ap")

    def test_no_dhcp_rolls_back(self):
        d = Device(saved=self.HOME)
        d.wifi_set("guest", "pw", "fail", associated=True)
        self.assertEqual(d.sta, self.HOME)
        self.assertEqual(d.change["reason"], "no_ip")

    def test_success_saves(self):
        d = Device(saved=self.HOME)
        self.assertTrue(d.wifi_set("other", "pw", "got_ip")["ok"])
        self.assertEqual(d.nvs, ("other", "pw"))
        self.assertEqual(d.change["result"], "ok")

    def test_recovery_mode_keeps_softap(self):
        d = Device(saved=self.HOME, mode="APSTA", want_ap=True)
        d.wifi_set("home", "typo", "fail", reason=AUTH_FAIL)
        d.got_ip()
        self.assertEqual(d.mode, "APSTA")

    def test_first_provision_failure_unchanged(self):
        d = Device(saved=None, mode="APSTA", want_ap=True)
        d.wifi_set("home", "typo", "fail", reason=AUTH_FAIL)
        self.assertIsNone(d.nvs)
        self.assertEqual(d.mode, "APSTA")
        self.assertFalse(d.change["restored_previous"])

    def test_first_provision_success(self):
        d = Device(saved=None, mode="APSTA", want_ap=True)
        self.assertTrue(d.wifi_set("home", "goodpass", "got_ip")["ok"])
        self.assertEqual(d.nvs, self.HOME)

    def test_power_loss_mid_test_boots_old(self):
        d = Device(saved=self.HOME)
        d.try_sta("other", "pw", "got_ip")  # connected, but power lost before commit
        d.reboot()
        self.assertEqual(d.sta, self.HOME)

    def test_busy(self):
        d = Device(saved=self.HOME)
        d.busy = True
        self.assertFalse(d.wifi_set("other", "pw", "got_ip")["ok"])
        self.assertEqual(d.nvs, self.HOME)
        self.assertEqual(d.change["result"], "none")

    def test_seq_counts_attempts(self):
        d = Device(saved=self.HOME)
        d.wifi_set("a", "x", "fail")
        d.wifi_set("b", "x", "fail")
        self.assertEqual(d.change["seq"], 2)


class SoftApRollbackTest(unittest.TestCase):
    def test_wrong_password_over_softap_keeps_client(self):
        d = Device(saved=("home", "goodpass"), mode="APSTA", want_ap=True)
        d.ap_clients = 1
        r = d.wifi_set("home", "typo", "fail", reason=AUTH_FAIL)
        self.assertFalse(r["ok"])
        self.assertEqual(d.sta, ("home", "goodpass"))
        self.assertFalse(d.connecting)  # no join/scan that would move the AP channel
        self.assertEqual(d.change["reason"], "auth")
        self.assertEqual(d.mode, "APSTA")

    def test_lan_rollback_connects_now(self):
        d = Device(saved=("home", "goodpass"))
        d.wifi_set("home", "typo", "fail", reason=AUTH_FAIL)
        self.assertTrue(d.connecting)


# --- network_watch_tick (Lost network) ---
FAST_RETRIES = 8
BG_RETRY_MS = 30000
AP_STABLE_MS = 60000
FAIL_AP_MS = 60000


class Watch:
    """Mirror of network_watch_tick() plus the event-handler bits it relies on. Times in ms."""

    def __init__(self, saved=True, now=0):
        self.saved = saved
        self.want_ap = not saved
        self.auto_ap = False
        self.ap_clients = 0
        self.sta_down = saved
        self.down_at = now
        self.up_at = 0
        self.bg_at = None
        self.retry = 0
        self.connected = False
        self.testing = False
        self.attempts = []

    # event handler
    def disconnected(self, now):
        self.connected = False
        if not self.sta_down:
            self.sta_down = True
            self.down_at = now
        self.retry += 1

    def got_ip(self, now):
        self.connected = True
        self.retry = 0
        self.sta_down = False
        self.up_at = now

    def manual_ap(self):
        self.want_ap = True
        self.auto_ap = False

    def tick(self, now):
        if self.testing or not self.saved:
            return False
        if self.sta_down:
            raised = False
            if not self.want_ap and now - self.down_at >= FAIL_AP_MS:
                self.manual_ap()
                self.auto_ap = True
                raised = True
            if (self.retry >= FAST_RETRIES and self.ap_clients == 0
                    and (self.bg_at is None or now - self.bg_at >= BG_RETRY_MS)):
                self.bg_at = now
                self.attempts.append(now)
            return raised
        if (self.auto_ap and self.want_ap and self.ap_clients == 0 and self.connected
                and now - self.up_at >= AP_STABLE_MS):
            self.auto_ap = False
            self.want_ap = False
        return False


def run(w, start, end, step=2000):
    raised = []
    for t in range(start, end, step):
        if w.tick(t):
            raised.append(t)
    return raised


class LostNetworkTest(unittest.TestCase):
    def test_router_off_at_boot(self):
        w = Watch(saved=True, now=0)
        for _ in range(FAST_RETRIES):
            w.disconnected(1000)
        raised = run(w, 2000, 120000)
        self.assertEqual(raised, [60000])
        self.assertTrue(w.want_ap and w.auto_ap)
        self.assertGreaterEqual(len(w.attempts), 3)  # keeps retrying in the background
        gaps = [b - a for a, b in zip(w.attempts, w.attempts[1:])]
        self.assertTrue(all(g >= BG_RETRY_MS for g in gaps))

    def test_router_off_mid_run_counts_from_drop(self):
        w = Watch(saved=True, now=0)
        w.got_ip(5000)
        self.assertEqual(run(w, 6000, 600000), [])
        w.disconnected(600000)
        self.assertEqual(run(w, 600000, 658000), [])  # not before WIFI_FAIL_AP_MS
        self.assertEqual(run(w, 658000, 662000), [660000])

    def test_router_back_drops_auto_ap(self):
        w = Watch(saved=True, now=0)
        for _ in range(FAST_RETRIES):
            w.disconnected(0)
        run(w, 0, 70000)
        w.got_ip(80000)
        run(w, 80000, 138000)
        self.assertTrue(w.want_ap)  # not stable yet
        run(w, 138000, 142000)
        self.assertFalse(w.want_ap)

    def test_ap_kept_while_client_attached(self):
        w = Watch(saved=True, now=0)
        for _ in range(FAST_RETRIES):
            w.disconnected(0)
        run(w, 0, 62000)
        w.ap_clients = 1
        n = len(w.attempts)
        run(w, 62000, 300000)
        self.assertEqual(len(w.attempts), n)  # no scans while a client is on the AP
        w.got_ip(300000)
        run(w, 300000, 500000)
        self.assertTrue(w.want_ap)
        w.ap_clients = 0
        run(w, 500000, 504000)
        self.assertFalse(w.want_ap)

    def test_manual_ap_stays(self):
        w = Watch(saved=True, now=0)
        w.got_ip(1000)
        w.manual_ap()
        run(w, 2000, 500000)
        self.assertTrue(w.want_ap)

    def test_no_saved_network_untouched(self):
        w = Watch(saved=False, now=0)
        self.assertEqual(run(w, 0, 300000), [])
        self.assertTrue(w.want_ap)
        self.assertEqual(w.attempts, [])

    def test_idle_during_test(self):
        w = Watch(saved=True, now=0)
        w.testing = True
        for _ in range(FAST_RETRIES):
            w.disconnected(0)
        self.assertEqual(run(w, 0, 200000), [])
        self.assertEqual(w.attempts, [])


# --- Static IP (parse_ip4, validate_static, confirm-or-revert) ---
AP_NET = 0xC0A80400  # 192.168.4.0/24
IP_CONFIRM_MS = 90000
IP_APPLY_DELAY_MS = 1500


def parse_ip4(s):
    if not isinstance(s, str):
        return None
    parts = s.split(".")
    if len(parts) != 4:
        return None
    v = 0
    for p in parts:
        if not p or len(p) > 3 or not all("0" <= ch <= "9" for ch in p):
            return None
        if len(p) > 1 and p[0] == "0":
            return None
        n = int(p)
        if n > 255:
            return None
        v = (v << 8) | n
    return v


def host_ok(a):
    top = a >> 24
    return top != 0 and top != 127 and top < 224


def validate_static(ip, mask, gw, dns=0):
    inv = ~mask & 0xFFFFFFFF
    if mask == 0 or (inv & (inv + 1)) & 0xFFFFFFFF:
        return "netmask must be contiguous"
    if inv < 3:
        return "netmask too long (max /30)"
    if not host_ok(ip):
        return "ip must be a unicast host address"
    if ip & inv in (0, inv):
        return "ip is the network or broadcast address"
    if gw & mask != ip & mask:
        return "gateway outside the subnet"
    if gw == ip or gw & inv in (0, inv):
        return "gateway must be another host in the subnet"
    both = mask & 0xFFFFFF00
    if ip & both == AP_NET & both:
        return "subnet overlaps the SoftAP 192.168.4.0/24"
    if dns and not host_ok(dns):
        return "dns must be a unicast address"
    return None


def v(ip, mask="255.255.255.0", gw="192.168.1.1", dns=None):
    return validate_static(parse_ip4(ip), parse_ip4(mask), parse_ip4(gw), parse_ip4(dns) if dns else 0)


DHCP = ("dhcp",)


class IpModel:
    """network_ip_command + ip_tick + the Wi-Fi change hooks. Times in ms."""

    def __init__(self, saved=DHCP, connected=True):
        self.nvs = saved
        self.active = saved
        self.connected = connected
        self.pend = None  # None | "apply_due" | "wait"
        self.new = None
        self.prev = None
        self.at = 0
        self.lease = False
        self.result = "none"
        self.reason = ""
        self.seq = 0

    def set(self, cfg, now):
        if self.pend:
            return "ip change pending; confirm it or wait for it to revert"
        if cfg == self.nvs:
            return None
        if not self.connected:
            if cfg != DHCP:
                return "station not connected; a static IP can only be set while connected"
            self.seq += 1
            self.nvs = self.active = cfg
            self.result, self.reason = "ok", "offline"
            return None
        self.prev, self.new, self.at, self.pend = self.nvs, cfg, now, "apply_due"
        self.seq += 1
        self.result, self.reason = "pending", ""
        return None

    def confirm(self, seq=None):
        if not self.pend:
            return "no ip change pending"
        if self.pend == "apply_due":
            return "ip change not applied yet; confirm over the new address"
        if seq is not None and seq != self.seq:
            return "seq does not match the pending ip change"
        self.pend = None
        self.nvs = self.new
        self.result, self.reason = "ok", "confirmed"
        return None

    def tick(self, now):
        if self.pend == "apply_due" and now - self.at >= IP_APPLY_DELAY_MS:
            self.active, self.at, self.pend, self.lease = self.new, now, "wait", False
        elif self.pend == "wait":
            if self.new == DHCP and self.lease:
                self.pend = None
                self.nvs = self.new
                self.result, self.reason = "ok", "dhcp_lease"
            elif now - self.at >= IP_CONFIRM_MS:
                self.pend = None
                self.active = self.prev
                self.result = "reverted"
                self.reason = "not_confirmed" if self.new != DHCP else "no_dhcp_lease"

    def reboot(self):
        self.pend = None
        self.active = self.nvs

    def wifi_change(self, ok):
        """network_try_sta (+ network_commit_wifi on success)."""
        if self.pend:
            self.pend = None
            self.result, self.reason = "reverted", "wifi_change"
        prev = self.nvs
        self.active = DHCP  # the test runs on DHCP
        if ok:
            if prev != DHCP:
                self.seq += 1
                self.result, self.reason = "reset", "wifi_change"
            self.nvs = DHCP
        else:
            self.active = prev  # rollback_sta brings the saved mode back


STATIC = ("static", "192.168.1.50", "255.255.255.0", "192.168.1.1")
OTHER = ("static", "192.168.1.60", "255.255.255.0", "192.168.1.1")


class ParseTest(unittest.TestCase):
    def test_good(self):
        self.assertEqual(parse_ip4("192.168.1.50"), 0xC0A80132)
        self.assertEqual(parse_ip4("0.0.0.0"), 0)
        self.assertEqual(parse_ip4("255.255.255.255"), 0xFFFFFFFF)

    def test_bad(self):
        for s in ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1..3.4", "1.2.3.4 ",
                  " 1.2.3.4", "a.b.c.d", "1.2.3.-4", "1234.1.1.1", None, 5]:
            self.assertIsNone(parse_ip4(s), s)


class ValidateTest(unittest.TestCase):
    def test_ok(self):
        self.assertIsNone(v("192.168.1.50"))
        self.assertIsNone(v("10.0.0.5", "255.0.0.0", "10.0.0.1", "8.8.8.8"))
        self.assertIsNone(v("192.168.1.2", "255.255.255.252", "192.168.1.1"))

    def test_mask(self):
        self.assertEqual(v("192.168.1.50", "255.0.255.0"), "netmask must be contiguous")
        self.assertEqual(v("192.168.1.50", "0.0.0.0"), "netmask must be contiguous")
        self.assertEqual(v("192.168.1.50", "255.255.255.255"), "netmask too long (max /30)")
        self.assertEqual(v("192.168.1.50", "255.255.255.254"), "netmask too long (max /30)")

    def test_network_broadcast(self):
        self.assertEqual(v("192.168.1.0"), "ip is the network or broadcast address")
        self.assertEqual(v("192.168.1.255"), "ip is the network or broadcast address")

    def test_gateway(self):
        self.assertEqual(v("192.168.1.50", gw="192.168.2.1"), "gateway outside the subnet")
        self.assertEqual(v("192.168.1.50", gw="192.168.1.50"), "gateway must be another host in the subnet")
        self.assertEqual(v("192.168.1.50", gw="192.168.1.255"), "gateway must be another host in the subnet")

    def test_not_unicast(self):
        self.assertEqual(v("127.0.0.5", "255.0.0.0", "127.0.0.1"), "ip must be a unicast host address")
        self.assertEqual(v("224.0.0.5", "255.255.255.0", "224.0.0.1"), "ip must be a unicast host address")
        self.assertEqual(v("192.168.1.50", dns="224.0.0.1"), "dns must be a unicast address")

    def test_softap_overlap(self):
        self.assertEqual(v("192.168.4.50", gw="192.168.4.2"), "subnet overlaps the SoftAP 192.168.4.0/24")
        self.assertEqual(v("192.168.10.5", "255.255.0.0", "192.168.0.1"),
                         "subnet overlaps the SoftAP 192.168.4.0/24")
        self.assertIsNone(v("192.168.5.5", gw="192.168.5.1"))


class ConfirmRevertTest(unittest.TestCase):
    def test_confirmed_static_is_saved(self):
        m = IpModel()
        self.assertIsNone(m.set(STATIC, 0))
        self.assertEqual(m.confirm(), "ip change not applied yet; confirm over the new address")
        m.tick(2000)
        self.assertEqual(m.active, STATIC)
        self.assertEqual(m.nvs, DHCP)  # not saved yet
        self.assertIsNone(m.confirm(seq=m.seq))
        self.assertEqual(m.nvs, STATIC)
        m.reboot()
        self.assertEqual(m.active, STATIC)

    def test_unconfirmed_reverts(self):
        m = IpModel()
        m.set(STATIC, 0)
        m.tick(2000)
        m.tick(2000 + IP_CONFIRM_MS - 1)
        self.assertEqual(m.active, STATIC)
        m.tick(2000 + IP_CONFIRM_MS)
        self.assertEqual(m.active, DHCP)
        self.assertEqual((m.result, m.reason), ("reverted", "not_confirmed"))
        self.assertEqual(m.nvs, DHCP)

    def test_power_loss_in_window(self):
        m = IpModel()
        m.set(STATIC, 0)
        m.tick(2000)
        m.reboot()
        self.assertEqual(m.active, DHCP)

    def test_wrong_seq(self):
        m = IpModel()
        m.set(STATIC, 0)
        m.tick(2000)
        self.assertEqual(m.confirm(seq=m.seq + 1), "seq does not match the pending ip change")

    def test_one_at_a_time(self):
        m = IpModel()
        m.set(STATIC, 0)
        self.assertEqual(m.set(OTHER, 10), "ip change pending; confirm it or wait for it to revert")

    def test_dhcp_auto_confirms_on_lease(self):
        m = IpModel(saved=STATIC)
        m.set(DHCP, 0)
        m.tick(2000)
        m.lease = True
        m.tick(4000)
        self.assertEqual(m.nvs, DHCP)
        self.assertEqual(m.reason, "dhcp_lease")

    def test_dhcp_without_lease_reverts_to_static(self):
        m = IpModel(saved=STATIC)
        m.set(DHCP, 0)
        m.tick(2000)
        m.tick(2000 + IP_CONFIRM_MS)
        self.assertEqual(m.active, STATIC)
        self.assertEqual(m.reason, "no_dhcp_lease")

    def test_static_needs_connection(self):
        m = IpModel(connected=False)
        self.assertEqual(m.set(STATIC, 0),
                         "station not connected; a static IP can only be set while connected")

    def test_dhcp_offline_saved_at_once(self):
        m = IpModel(saved=STATIC, connected=False)
        self.assertIsNone(m.set(DHCP, 0))
        self.assertEqual(m.nvs, DHCP)


class IpWifiChangeTest(unittest.TestCase):
    def test_new_network_resets_to_dhcp(self):
        m = IpModel(saved=STATIC)
        m.wifi_change(ok=True)
        self.assertEqual((m.nvs, m.active), (DHCP, DHCP))
        self.assertEqual((m.result, m.reason), ("reset", "wifi_change"))

    def test_failed_change_restores_static(self):
        m = IpModel(saved=STATIC)
        m.wifi_change(ok=False)
        self.assertEqual((m.nvs, m.active), (STATIC, STATIC))

    def test_wifi_change_cancels_pending(self):
        m = IpModel()
        m.set(STATIC, 0)
        m.tick(2000)
        m.wifi_change(ok=False)
        self.assertIsNone(m.pend)
        self.assertEqual(m.active, DHCP)
        self.assertEqual(m.nvs, DHCP)


if __name__ == "__main__":
    unittest.main()
