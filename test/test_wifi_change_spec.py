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


if __name__ == "__main__":
    unittest.main()
