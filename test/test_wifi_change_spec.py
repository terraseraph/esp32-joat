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


if __name__ == "__main__":
    unittest.main()
