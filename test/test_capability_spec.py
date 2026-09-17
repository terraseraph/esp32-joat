"""Host spec for classic ESP32 pin rules. Keep in sync with capability_manager.cpp."""
import unittest

# Mirrors capability_allows() policy (not a C parser).
FLASH = set(range(6, 12))
INPUT_ONLY = {34, 35, 36, 37, 38, 39}
ADC1 = {32, 33, 34, 35, 36, 37, 38, 39}
ADC2 = {0, 2, 4, 12, 13, 14, 15, 25, 26, 27}
STRAP = {0, 2, 5, 12, 15}


def allows(gpio: int, mode: str) -> bool:
    if gpio in FLASH:
        return False
    if mode == "disabled":
        return True
    if mode in ("out", "pwm", "servo"):
        return gpio not in INPUT_ONLY and gpio not in FLASH
    if mode == "in":
        return gpio not in FLASH
    if mode == "adc":
        return gpio in ADC1 and gpio not in ADC2
    return False


class CapabilitySpec(unittest.TestCase):
    def test_flash_reserved(self):
        for g in FLASH:
            self.assertFalse(allows(g, "out"), g)

    def test_input_only_no_output(self):
        for g in INPUT_ONLY:
            self.assertFalse(allows(g, "out"), g)
            self.assertTrue(allows(g, "in"), g)

    def test_adc2_blocked_with_wifi_policy(self):
        for g in ADC2:
            self.assertFalse(allows(g, "adc"), g)

    def test_adc1_ok(self):
        self.assertTrue(allows(32, "adc"))
        self.assertTrue(allows(34, "adc"))

    def test_general_out(self):
        self.assertTrue(allows(4, "out"))
        self.assertTrue(allows(4, "pwm"))
        self.assertTrue(allows(4, "servo"))
        self.assertFalse(allows(34, "servo"))
        self.assertFalse(allows(4, "adc"))

    def test_strapping_still_usable_but_flagged(self):
        self.assertTrue(allows(2, "out"))
        self.assertIn(2, STRAP)


if __name__ == "__main__":
    unittest.main()
