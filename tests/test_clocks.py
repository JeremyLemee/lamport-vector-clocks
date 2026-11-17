import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from clock_visualizer.clocks import calculate


def execution(mode="lamport"):
    return {
        "mode": mode,
        "processes": [{"id": "a", "name": "P1"}, {"id": "b", "name": "P2"}, {"id": "c", "name": "P3"}],
        "events": [
            {"id": "e1", "process": "a", "kind": "internal"},
            {"id": "s1", "process": "a", "kind": "send"},
            {"id": "r1", "process": "b", "kind": "receive", "send": "s1"},
            {"id": "s2", "process": "c", "kind": "send"},
            {"id": "r2", "process": "b", "kind": "receive", "send": "s2"},
            {"id": "s3", "process": "b", "kind": "send"},
            {"id": "r3", "process": "a", "kind": "receive", "send": "s3"},
        ],
    }


class ClockTests(unittest.TestCase):
    def test_hand_calculated_message_chain_for_all_modes(self):
        expected = {
            "lamport": [1, 2, 3, 1, 4, 5, 6],
            "vector": [[1, 0, 0], [2, 0, 0], [2, 1, 0], [0, 0, 1], [2, 2, 1], [2, 3, 1], [3, 3, 1]],
            "modified": [[1, 0, 0], [2, 0, 0], [2, 0, 0], [0, 0, 1], [2, 0, 1], [2, 1, 1], [2, 1, 1]],
        }
        for mode, timestamps in expected.items():
            with self.subTest(mode=mode):
                payload = execution(mode)
                original = copy.deepcopy(payload)
                result = calculate(payload)
                self.assertEqual([event["timestamp"] for event in result["events"]], timestamps)
                self.assertEqual(payload, original)

    def test_default_mode_and_empty_execution(self):
        self.assertEqual(calculate({"processes": [], "events": []}), {"mode": "lamport", "processes": [], "events": []})

    def test_new_process_extends_existing_vectors_with_zero(self):
        payload = execution("vector")
        payload["processes"].append({"id": "d", "name": "P4"})
        self.assertEqual(calculate(payload)["events"][-1]["timestamp"], [3, 3, 1, 0])

    def test_independent_events_have_independent_clocks(self):
        payload = execution("vector")
        payload["events"] = [payload["events"][0], {"id": "e2", "process": "b", "kind": "internal"}]
        self.assertEqual([e["timestamp"] for e in calculate(payload)["events"]], [[1, 0, 0], [0, 1, 0]])

    def test_rejects_invalid_inputs(self):
        mutations = [
            lambda p: p.update(mode="wrong"),
            lambda p: p.update(processes=None),
            lambda p: p["processes"].append({"id": "d", "name": " P1 "}),
            lambda p: p["processes"].append({"id": "a", "name": "other"}),
            lambda p: p["processes"][0].update(name=" "),
            lambda p: p["events"][0].update(process="unknown"),
            lambda p: p["events"][0].update(kind="unknown"),
            lambda p: p["events"][2].update(send="missing"),
            lambda p: p["events"][2].update(send="s3"),
            lambda p: p["events"][2].update(send="e1"),
            lambda p: p["events"][2].update(process="a"),
            lambda p: p["events"][2].update(id="e1"),
            lambda p: p["events"].append({"id": "r4", "process": "c", "kind": "receive", "send": "s1"}),
            lambda p: p["events"].append(None),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)):
                payload = execution()
                mutation(payload)
                with self.assertRaises(ValueError):
                    calculate(payload)
        for payload in [None, [], {}, {"processes": [], "events": "bad"}]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                calculate(payload)


if __name__ == "__main__":
    unittest.main()
