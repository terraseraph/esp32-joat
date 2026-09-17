"""Host spec for module ids, MFRC522 pin recipes, and shared SPI rules.

Mirrors module_manager validation + mfrc522 schema (not a C parser).
"""
import unittest

FLASH = set(range(6, 12))
INPUT_ONLY = {34, 35, 36, 37, 38, 39}

MFRC522_PINS = (
    ("sck", True, "bus", "out"),
    ("mosi", True, "bus", "out"),
    ("miso", True, "bus", "in"),
    ("cs", True, "instance", "out"),
    ("rst", False, "instance", "out"),
)
MFRC522_MAX = 4


def id_valid(mod_id):
    if not mod_id or len(mod_id) > 16:
        return False
    if not ("a" <= mod_id[0] <= "z"):
        return False
    return all(("a" <= c <= "z") or ("0" <= c <= "9") or c == "_" for c in mod_id)


def cap_allows(gpio, mode):
    if gpio in FLASH:
        return False
    if mode == "out":
        return gpio not in INPUT_ONLY and gpio not in FLASH
    if mode == "in":
        return gpio not in FLASH
    return False


def validate_add(existing, spec):
    """Return None on success, or an error string."""
    mod_id = spec.get("id", "")
    if not id_valid(mod_id):
        return "id must be [a-z][a-z0-9_]{0,15}"
    if spec.get("type") != "mfrc522":
        return "unknown module type"
    if any(e.get("id") == mod_id for e in existing):
        return "id already in use"
    n = sum(1 for e in existing if e.get("type") == "mfrc522")
    if n >= MFRC522_MAX:
        return "mfrc522 limited to 4 instances"
    bus = spec.get("bus", "vspi")
    if bus not in ("vspi", "hspi"):
        return "bus must be vspi or hspi"
    pins = spec.get("pins") or {}
    used = []
    for role, required, _share, cap in MFRC522_PINS:
        if role not in pins:
            if required:
                return f"pin {role} required"
            continue
        gpio = pins[role]
        if not cap_allows(gpio, cap):
            return f"gpio {gpio} rejected for {role}"
        if gpio in used:
            return "module pins must be unique"
        used.append(gpio)
    sck, miso, mosi, cs = pins.get("sck"), pins.get("miso"), pins.get("mosi"), pins.get("cs")
    for e in existing:
        if e.get("type") != "mfrc522" or e.get("bus") != bus:
            continue
        ep = e.get("pins") or {}
        if sck is not None and ep.get("sck") is not None:
            if (sck, miso, mosi) != (ep.get("sck"), ep.get("miso"), ep.get("mosi")):
                return "shared spi bus pins must match"
        if cs is not None and ep.get("cs") is not None and cs == ep.get("cs"):
            return "cs must be unique per reader"
    return None


VSPI_OK = {
    "id": "rfid0",
    "type": "mfrc522",
    "bus": "vspi",
    "pins": {"sck": 18, "miso": 19, "mosi": 23, "cs": 5, "rst": 4},
}


class ModuleSpec(unittest.TestCase):
    def test_id_charset(self):
        self.assertTrue(id_valid("rfid0"))
        self.assertTrue(id_valid("rfid_0"))
        self.assertFalse(id_valid("RFID0"))
        self.assertFalse(id_valid("1rfid"))
        self.assertFalse(id_valid(""))
        self.assertFalse(id_valid("a" * 17))
        self.assertTrue(id_valid("a" * 16))

    def test_vspi_defaults_ok(self):
        self.assertIsNone(validate_add([], VSPI_OK))

    def test_flash_rejected(self):
        spec = dict(VSPI_OK, pins={"sck": 6, "miso": 19, "mosi": 23, "cs": 5})
        self.assertIsNotNone(validate_add([], spec))

    def test_input_only_cs_rejected(self):
        spec = dict(VSPI_OK, pins={"sck": 18, "miso": 19, "mosi": 23, "cs": 34})
        self.assertIsNotNone(validate_add([], spec))

    def test_miso_may_be_input_only(self):
        spec = dict(VSPI_OK, pins={"sck": 18, "miso": 34, "mosi": 23, "cs": 5})
        self.assertIsNone(validate_add([], spec))

    def test_unique_pins_in_instance(self):
        spec = dict(VSPI_OK, pins={"sck": 18, "miso": 19, "mosi": 18, "cs": 5})
        self.assertEqual(validate_add([], spec), "module pins must be unique")

    def test_shared_bus_must_match(self):
        second = {
            "id": "rfid1",
            "type": "mfrc522",
            "bus": "vspi",
            "pins": {"sck": 14, "miso": 12, "mosi": 13, "cs": 15},
        }
        self.assertEqual(validate_add([VSPI_OK], second), "shared spi bus pins must match")

    def test_second_reader_same_bus_new_cs(self):
        second = {
            "id": "rfid1",
            "type": "mfrc522",
            "bus": "vspi",
            "pins": {"sck": 18, "miso": 19, "mosi": 23, "cs": 15},
        }
        self.assertIsNone(validate_add([VSPI_OK], second))

    def test_cs_unique(self):
        second = {
            "id": "rfid1",
            "type": "mfrc522",
            "bus": "vspi",
            "pins": {"sck": 18, "miso": 19, "mosi": 23, "cs": 5},
        }
        self.assertEqual(validate_add([VSPI_OK], second), "cs must be unique per reader")

    def test_max_four(self):
        existing = []
        for i in range(4):
            existing.append(
                {
                    "id": f"rfid{i}",
                    "type": "mfrc522",
                    "bus": "vspi",
                    "pins": {"sck": 18, "miso": 19, "mosi": 23, "cs": [5, 15, 16, 17][i]},
                }
            )
        extra = {
            "id": "rfid4",
            "type": "mfrc522",
            "bus": "vspi",
            "pins": {"sck": 18, "miso": 19, "mosi": 23, "cs": 16},
        }
        self.assertIn("limited to 4", validate_add(existing, extra))

    def test_bad_bus(self):
        spec = dict(VSPI_OK, bus="i2c0")
        self.assertEqual(validate_add([], spec), "bus must be vspi or hspi")

    def test_duplicate_id(self):
        self.assertEqual(validate_add([VSPI_OK], VSPI_OK), "id already in use")

    def test_rst_optional(self):
        spec = {
            "id": "rfid0",
            "type": "mfrc522",
            "bus": "vspi",
            "pins": {"sck": 18, "miso": 19, "mosi": 23, "cs": 5},
        }
        self.assertIsNone(validate_add([], spec))


if __name__ == "__main__":
    unittest.main()
