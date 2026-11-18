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
            "causal": [[0, 0, 0]] * 7,
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

    def test_concurrent_broadcasts_share_one_timestamp_per_sender(self):
        for mode in ("lamport", "vector", "causal"):
            with self.subTest(mode=mode):
                payload = execution(mode)
                payload["events"] = [
                    {"id": "a", "process": "a", "kind": "send", "broadcast": True},
                    {"id": "b", "process": "b", "kind": "send", "broadcast": True},
                    {"id": "bc", "process": "c", "kind": "receive", "send": "b"},
                    {"id": "ac", "process": "c", "kind": "receive", "send": "a"},
                    {"id": "ab", "process": "b", "kind": "receive", "send": "a"},
                    {"id": "ba", "process": "a", "kind": "receive", "send": "b"},
                ]
                events = calculate(payload)["events"]
                expected = {
                    "lamport": [1, 1, 2, 3, 2, 2],
                    "vector": [[1, 0, 0], [0, 1, 0], [0, 1, 1], [1, 1, 2], [1, 2, 0], [2, 1, 0]],
                    "causal": [[1, 0, 0], [0, 1, 0], [0, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0]],
                }
                self.assertEqual([e["timestamp"] for e in events], expected[mode])
                self.assertTrue(events[0]["broadcast"])
                payload["events"].append({"id": "again", "process": "c", "kind": "receive", "send": "a"})
                with self.assertRaises(ValueError):
                    calculate(payload)

    def test_new_process_extends_existing_vectors_with_zero(self):
        payload = execution("vector")
        payload["processes"].append({"id": "d", "name": "P4"})
        self.assertEqual(calculate(payload)["events"][-1]["timestamp"], [3, 3, 1, 0])

    def test_causal_broadcast_replays_slide_42(self):
        payload = execution("causal")
        payload["events"] = [
            {"id": "a1", "process": "a", "kind": "send", "broadcast": True},
            {"id": "b1", "process": "b", "kind": "receive", "send": "a1"},
            {"id": "b2", "process": "b", "kind": "send", "broadcast": True},
            {"id": "c1", "process": "c", "kind": "receive", "send": "b2"},
            {"id": "c2", "process": "c", "kind": "send", "broadcast": True},
            {"id": "a2", "process": "a", "kind": "receive", "send": "b2"},
            {"id": "c3", "process": "c", "kind": "receive", "send": "a1"},
        ]
        events = calculate(payload)["events"]
        self.assertEqual([e["timestamp"] for e in events], [
            [1, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0],
            [0, 0, 1], [1, 1, 0], [1, 1, 1],
        ])
        self.assertEqual(events[3]["delivery"]["vector"], [1, 1, 0])
        self.assertEqual(events[3]["delivery"]["failures"], [
            {"source": 0, "isSender": False, "count": 1, "deliveredCount": 0, "blockers": ["a1"]},
        ])
        self.assertEqual(events[-1]["delivery"]["released"], 1)

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
            lambda p: p["events"][0].update(broadcast=True),
            lambda p: p["events"][1].update(broadcast="true"),
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
