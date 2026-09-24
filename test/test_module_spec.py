"""Host spec for module ids, MFRC522 / BME280 pin recipes, and shared bus rules.

Mirrors module_manager validation + type schemas (not a C parser).
"""
import unittest

FLASH = set(range(6, 12))
INPUT_ONLY = {34, 35, 36, 37, 38, 39}

TYPES = {
    "mfrc522": {
        "bus_kind": "spi",
        "default_bus": "vspi",
        "buses": ("vspi", "hspi"),
        "max": 4,
        "pins": (
            ("sck", True, "bus", "out"),
            ("mosi", True, "bus", "out"),
            ("miso", True, "bus", "in"),
            ("cs", True, "instance", "out"),
            ("rst", False, "instance", "out"),
        ),
        "settings": (),
    },
    "bme280": {
        "bus_kind": "i2c",
        "default_bus": "i2c0",
        "buses": ("i2c0", "i2c1"),
        "max": 2,
        "pins": (
            ("sda", True, "bus", "out"),
            ("scl", True, "bus", "out"),
        ),
        "settings": (
            ("addr", "enum", "118", None, None, ("118", "119")),
            ("sample_ms", "int", "1000", 200, 10000, None),
            ("osrs_t", "enum", "1", None, None, ("1", "2", "4", "8", "16")),
            ("osrs_p", "enum", "1", None, None, ("1", "2", "4", "8", "16")),
            ("osrs_h", "enum", "1", None, None, ("1", "2", "4", "8", "16")),
            ("filter", "enum", "0", None, None, ("0", "2", "4", "8", "16")),
            ("mode", "enum", "normal", None, None, ("normal", "forced")),
        ),
    },
}


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


def _setting_raw(spec, key, default):
    settings = spec.get("settings") or {}
    if key not in settings:
        return default
    return settings[key]


def _as_str(v):
    return str(v)


def validate_add(existing, spec):
    """Return None on success, or an error string."""
    mod_id = spec.get("id", "")
    if not id_valid(mod_id):
        return "id must be [a-z][a-z0-9_]{0,15}"
    typ = spec.get("type")
    ops = TYPES.get(typ)
    if not ops:
        return "unknown module type"
    if any(e.get("id") == mod_id for e in existing):
        return "id already in use"
    n = sum(1 for e in existing if e.get("type") == typ)
    if n >= ops["max"]:
        return f"{typ} limited to {ops['max']} instances"
    bus = spec.get("bus", ops["default_bus"])
    if bus not in ops["buses"]:
        if ops["bus_kind"] == "spi":
            return "bus must be vspi or hspi"
        return "bus must be i2c0 or i2c1"
    pins = spec.get("pins") or {}
    used = []
    for role, required, _share, cap in ops["pins"]:
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

    resolved = {}
    for key, kind, default, lo, hi, choices in ops["settings"]:
        raw = _setting_raw(spec, key, default)
        s = _as_str(raw)
        if kind == "enum":
            if s not in choices:
                return f"settings.{key} invalid"
            resolved[key] = int(s) if s.lstrip("+-").isdigit() else s
        else:
            try:
                v = int(raw)
            except (TypeError, ValueError):
                return f"settings.{key} must be a number"
            if v < lo or v > hi:
                return f"settings.{key} out of range"
            resolved[key] = v
    addr = resolved.get("addr")

    for e in existing:
        eops = TYPES.get(e.get("type"))
        if not eops or eops["bus_kind"] != ops["bus_kind"]:
            continue
        if e.get("bus") != bus:
            continue
        ep = e.get("pins") or {}
        for role, _req, share, _cap in ops["pins"]:
            if share != "bus":
                continue
            if role in pins and role in ep and pins[role] != ep[role]:
                return f"shared {ops['bus_kind']} bus pins must match"
        if ops["bus_kind"] == "spi":
            if pins.get("cs") is not None and ep.get("cs") is not None and pins["cs"] == ep["cs"]:
                return "cs must be unique per reader"
        if ops["bus_kind"] == "i2c":
            oaddr = (e.get("settings") or {}).get("addr")
            if oaddr is None:
                oaddr = next((d[2] for d in eops["settings"] if d[0] == "addr"), None)
            if addr is not None and oaddr is not None and int(addr) == int(oaddr):
                return "i2c address must be unique on this bus"
    return None


VSPI_OK = {
    "id": "rfid0",
    "type": "mfrc522",
    "bus": "vspi",
    "pins": {"sck": 18, "miso": 19, "mosi": 23, "cs": 5, "rst": 4},
}

I2C_OK = {
    "id": "env0",
    "type": "bme280",
    "bus": "i2c0",
    "pins": {"sda": 21, "scl": 22},
    "settings": {"addr": 118, "sample_ms": 1000, "osrs_t": 1, "osrs_p": 1, "osrs_h": 1, "filter": 0, "mode": "normal"},
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

    def test_bme280_defaults_ok(self):
        self.assertIsNone(validate_add([], I2C_OK))

    def test_bme280_defaults_without_settings(self):
        spec = {"id": "env0", "type": "bme280", "bus": "i2c0", "pins": {"sda": 21, "scl": 22}}
        self.assertIsNone(validate_add([], spec))

    def test_bme280_input_only_sda_rejected(self):
        spec = dict(I2C_OK, pins={"sda": 34, "scl": 22})
        self.assertIsNotNone(validate_add([], spec))

    def test_bme280_flash_rejected(self):
        spec = dict(I2C_OK, pins={"sda": 21, "scl": 6})
        self.assertIsNotNone(validate_add([], spec))

    def test_bme280_shared_pins_must_match(self):
        second = {
            "id": "env1",
            "type": "bme280",
            "bus": "i2c0",
            "pins": {"sda": 4, "scl": 5},
            "settings": {"addr": 119},
        }
        self.assertEqual(validate_add([I2C_OK], second), "shared i2c bus pins must match")

    def test_bme280_second_addr(self):
        second = {
            "id": "env1",
            "type": "bme280",
            "bus": "i2c0",
            "pins": {"sda": 21, "scl": 22},
            "settings": {"addr": 119},
        }
        self.assertIsNone(validate_add([I2C_OK], second))

    def test_bme280_addr_unique(self):
        second = {
            "id": "env1",
            "type": "bme280",
            "bus": "i2c0",
            "pins": {"sda": 21, "scl": 22},
            "settings": {"addr": 118},
        }
        self.assertEqual(validate_add([I2C_OK], second), "i2c address must be unique on this bus")

    def test_bme280_bad_addr(self):
        spec = dict(I2C_OK, settings=dict(I2C_OK["settings"], addr=0x3C))
        self.assertEqual(validate_add([], spec), "settings.addr invalid")

    def test_bme280_sample_range(self):
        spec = dict(I2C_OK, settings=dict(I2C_OK["settings"], sample_ms=50))
        self.assertEqual(validate_add([], spec), "settings.sample_ms out of range")

    def test_bme280_max_two(self):
        existing = [
            I2C_OK,
            {
                "id": "env1",
                "type": "bme280",
                "bus": "i2c0",
                "pins": {"sda": 21, "scl": 22},
                "settings": {"addr": 119},
            },
        ]
        extra = {
            "id": "env2",
            "type": "bme280",
            "bus": "i2c1",
            "pins": {"sda": 4, "scl": 5},
            "settings": {"addr": 118},
        }
        self.assertIn("limited to 2", validate_add(existing, extra))

    def test_bme280_bad_bus(self):
        spec = dict(I2C_OK, bus="vspi")
        self.assertEqual(validate_add([], spec), "bus must be i2c0 or i2c1")

    def test_rfid_and_bme_same_board(self):
        self.assertIsNone(validate_add([VSPI_OK], I2C_OK))


if __name__ == "__main__":
    unittest.main()
