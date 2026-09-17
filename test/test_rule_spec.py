"""Host spec for on-device pin rules (mirrors io_rules validation, not a C parser)."""
import unittest

MAX_RULES = 8
OPS = {"gt", "ge", "lt", "le", "eq", "ne", ">", ">=", "<", "<=", "==", "!="}


def gpio_ok(gpio):
    return isinstance(gpio, int) and 0 <= gpio < 40


def cond(v, op, th):
    if op in ("gt", ">"):
        return v > th
    if op in ("ge", ">="):
        return v >= th
    if op in ("lt", "<"):
        return v < th
    if op in ("le", "<="):
        return v <= th
    if op in ("eq", "=="):
        return v == th
    if op in ("ne", "!="):
        return v != th
    return False


def validate_set(existing, spec):
    """Return None on success, or an error string."""
    on = spec.get("on") or spec
    src = on.get("gpio", spec.get("gpio"))
    if not gpio_ok(src):
        return "on.gpio required"
    op = on.get("op", "gt")
    if op not in OPS:
        return "on.op must be gt/ge/lt/le/eq/ne"
    then = spec.get("then") or {}
    dest = then.get("gpio")
    if not gpio_ok(dest):
        return "then.gpio required"
    if dest == src:
        return "then.gpio must differ from on.gpio"
    els = spec.get("else")
    if els is not None and gpio_ok(els.get("gpio")) and els.get("gpio") == src:
        return "else.gpio must differ from on.gpio"
    rid = spec.get("id") or ("r%d" % src)
    same = [e for e in existing if e.get("id") == rid or (e.get("on") or {}).get("gpio") == src]
    others = [e for e in existing if e not in same]
    if not same and len(existing) >= MAX_RULES:
        return "max %d rules" % MAX_RULES
    others.append({"id": rid, "on": {"gpio": src, "op": op, "value": on.get("value", 0)},
                   "then": then, "else": els})
    return None


class RuleSpec(unittest.TestCase):
    def test_example_adc_to_gpio(self):
        spec = {
            "on": {"gpio": 32, "op": "gt", "value": 1000},
            "then": {"gpio": 18, "value": 1},
            "else": {"gpio": 18, "value": 0},
        }
        self.assertIsNone(validate_set([], spec))
        self.assertTrue(cond(1001, "gt", 1000))
        self.assertFalse(cond(1000, "gt", 1000))

    def test_rejects_same_pin(self):
        self.assertEqual(
            validate_set([], {"on": {"gpio": 18, "op": "eq", "value": 1}, "then": {"gpio": 18, "value": 1}}),
            "then.gpio must differ from on.gpio",
        )

    def test_upsert_same_source(self):
        have = [{"id": "r32", "on": {"gpio": 32, "op": "gt", "value": 500}, "then": {"gpio": 18, "value": 1}}]
        self.assertIsNone(validate_set(have, {
            "on": {"gpio": 32, "op": "lt", "value": 200},
            "then": {"gpio": 19, "value": 1},
        }))

    def test_max_eight(self):
        have = [{"id": "r%d" % i, "on": {"gpio": i, "op": "eq", "value": 1}, "then": {"gpio": 18, "value": 1}}
                for i in range(8)]
        self.assertEqual(
            validate_set(have, {"on": {"gpio": 32, "op": "gt", "value": 1}, "then": {"gpio": 19, "value": 1}}),
            "max 8 rules",
        )

    def test_digital_eq(self):
        self.assertTrue(cond(1, "eq", 1))
        self.assertFalse(cond(0, "eq", 1))


if __name__ == "__main__":
    unittest.main()
