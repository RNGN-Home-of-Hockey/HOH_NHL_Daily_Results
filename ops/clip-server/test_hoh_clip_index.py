"""Tests for hoh_clip_index.py (run: python -m unittest discover -s ops/clip-server -v)."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hoh_clip_index as idx  # noqa: E402


def goal(event_id, file, status="PASS", **extra):
    base = {
        "event_id": event_id, "period": 1, "time_remaining": "05:19", "away_score": 1, "home_score": 0,
        "scorer": "Judd Caulfield", "scorer_id": 8481538, "team": "ANA", "file": file, "status": status,
        "duration": 41.43, "finished": "2026-10-10T00:45:25+00:00",
        # internal fields that must never reach the public index
        "source": "direct2026020069", "checks": {"run_votes": {"1": 128}}, "window": {"first_index": 1},
        "segments": [[1.0, 2.0]], "t_goal": 307.5,
    }
    base.update(extra)
    return base


class Tree:
    """A throw-away clips tree: <root>/<day>/<game>/{manifest.json, *.mp4, tg/*.mp4, _thumbs/*.jpg}."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def game(self, day, game, manifest, files=(), tg=(), thumbs=()):
        gdir = os.path.join(self.root, day, game)
        os.makedirs(os.path.join(gdir, "tg"), exist_ok=True)
        os.makedirs(os.path.join(gdir, "_thumbs"), exist_ok=True)
        with open(os.path.join(gdir, "manifest.json"), "w", encoding="utf-8") as fh:
            fh.write(manifest if isinstance(manifest, str) else json.dumps(manifest))
        for name in files:
            with open(os.path.join(gdir, name), "wb") as fh:
                fh.write(b"x" * 100)
        for name in tg:
            with open(os.path.join(gdir, "tg", name), "wb") as fh:
                fh.write(b"x" * 40)
        for name in thumbs:
            with open(os.path.join(gdir, "_thumbs", name), "wb") as fh:
                fh.write(b"j" * 10)
        return gdir


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.t = Tree()
        self.addCleanup(self.t.tmp.cleanup)

    def build(self):
        return idx.build_index((("live", self.t.root),))

    def test_only_passed_goals_with_files_sorted_by_event(self):
        a, b, c = "20261009_ana-wpg_1-0_j.caulfield.mp4", "20261009_ana-wpg_2-0_t.washe.mp4", "20261009_ana-wpg_3-0_x.gone.mp4"
        self.t.game("20261009", "ana-wpg", {
            "game_id": 2026020069, "date": "20261009", "away": "ANA", "home": "WPG",
            "goals": [goal(407, b), goal(405, a), goal(409, "20261009_ana-wpg_9-9_rejected.mp4", status="REJECT"), goal(408, c)],
        }, files=[a, b, "20261009_ana-wpg_9-9_rejected.mp4"], tg=[a], thumbs=[a.replace(".mp4", ".jpg")])
        index = self.build()
        self.assertEqual(index["version"], 1)
        (game,) = index["games"]
        self.assertEqual((game["game_pk"], game["date"], game["away"], game["home"], game["kind"]), (2026020069, "20261009", "ANA", "WPG", "live"))
        self.assertEqual([g["event_id"] for g in game["goals"]], [405, 407], "REJECT and missing files are dropped, order by event")
        first, second = game["goals"]
        self.assertEqual(first["orig"], {"path": "live/20261009/ana-wpg/" + a, "bytes": 100})
        self.assertEqual(first["light"], {"path": "live/20261009/ana-wpg/tg/" + a, "bytes": 40})
        self.assertEqual(first["poster"], "live/20261009/ana-wpg/_thumbs/" + a.replace(".mp4", ".jpg"))
        self.assertIsNone(second["light"], "no light copy yet")
        self.assertIsNone(second["poster"])
        self.assertEqual((first["scorer"], first["scorer_id"], first["team"], first["period"], first["time_remaining"]), ("Judd Caulfield", 8481538, "ANA", 1, "05:19"))
        self.assertEqual((first["away_score"], first["home_score"]), (1, 0))

    def test_no_internal_fields_leak(self):
        a = "20261009_ana-wpg_1-0_j.caulfield.mp4"
        self.t.game("20261009", "ana-wpg", {
            "game_id": 2026020069, "date": "20261009", "away": "ANA", "home": "WPG", "engine": "hoh.liveclip", "healed": "x",
            "goals": [goal(405, a)],
        }, files=[a])
        text = json.dumps(self.build())
        for secret in ("direct2026020069", "run_votes", "first_index", "segments", "t_goal", "engine", "healed", "checks", "window", self.t.root):
            self.assertNotIn(secret, text)

    def test_unsafe_file_names_are_ignored(self):
        good = "20261009_ana-wpg_1-0_j.caulfield.mp4"
        bad = ["../secret.mp4", "a/b.mp4", ".hidden.mp4", "with space.mp4", "x.mkv", "", None, "..", "a\\b.mp4"]
        goals = [goal(400 + i, name) for i, name in enumerate(bad)] + [goal(500, good)]
        self.t.game("20261009", "ana-wpg", {"game_id": 1, "away": "ANA", "home": "WPG", "goals": goals}, files=[good])
        (game,) = self.build()["games"]
        self.assertEqual([g["event_id"] for g in game["goals"]], [500])

    def test_all_goals_and_ending(self):
        a, allf, fin = "20261009_ana-wpg_1-0_j.caulfield.mp4", "20261009_ana-wpg_ALL-GOALS.mp4", "20261009_ana-wpg_FINAL.mp4"
        self.t.game("20261009", "ana-wpg", {
            "game_id": 2026020069, "away": "ANA", "home": "WPG", "goals": [goal(405, a)],
            "all_goals": {"file": allf, "clips": [a]}, "ending": {"kind": "final_horn", "file": fin, "t_horn": 524.8},
        }, files=[a, allf, fin], tg=[allf])
        (game,) = self.build()["games"]
        self.assertEqual(game["all_goals"]["orig"]["path"], "live/20261009/ana-wpg/" + allf)
        self.assertEqual(game["all_goals"]["light"]["path"], "live/20261009/ana-wpg/tg/" + allf)
        self.assertEqual(game["ending"]["orig"]["path"], "live/20261009/ana-wpg/" + fin)
        self.assertIsNone(game["ending"]["light"])
        self.assertEqual(game["ending"]["kind"], "final_horn")

    def test_missing_compilation_file_is_none(self):
        a = "20261009_ana-wpg_1-0_j.caulfield.mp4"
        self.t.game("20261009", "ana-wpg", {"game_id": 1, "away": "ANA", "home": "WPG", "goals": [goal(405, a)],
                    "all_goals": {"file": "20261009_ana-wpg_ALL-GOALS.mp4"}, "ending": {"kind": "final_horn", "file": "gone.mp4"}}, files=[a])
        (game,) = self.build()["games"]
        self.assertIsNone(game["all_goals"])
        self.assertIsNone(game["ending"])

    def test_bad_manifests_are_skipped(self):
        a = "20261009_ana-wpg_1-0_j.caulfield.mp4"
        self.t.game("20261009", "ok-game", {"game_id": 7, "away": "AAA", "home": "BBB", "goals": [goal(1, a)]}, files=[a])
        self.t.game("20261009", "broken", "{not json", files=[a])
        self.t.game("20261009", "no-id", {"game_id": "abc", "goals": [goal(1, a)]}, files=[a])
        self.t.game("20261009", "empty", {"game_id": 8, "away": "CCC", "home": "DDD", "goals": []})
        self.t.game("2026-10-09", "wrong-day", {"game_id": 9, "goals": [goal(1, a)]}, files=[a])
        self.assertEqual([g["game_pk"] for g in self.build()["games"]], [7])

    def test_two_trees_and_ordering(self):
        a = "20261006_car-mtl_1-0_t.hall.mp4"
        live, vod = Tree(), Tree()
        self.addCleanup(live.tmp.cleanup)
        self.addCleanup(vod.tmp.cleanup)
        live.game("20261009", "ana-wpg", {"game_id": 20, "away": "ANA", "home": "WPG", "goals": [goal(1, a)]}, files=[a])
        vod.game("20261006", "car-mtl", {"game_id": 10, "away": "CAR", "home": "MTL", "goals": [goal(1, a)]}, files=[a])
        index = idx.build_index((("live", live.root), ("vod", vod.root)))
        self.assertEqual([(g["kind"], g["date"], g["game_pk"]) for g in index["games"]], [("vod", "20261006", 10), ("live", "20261009", 20)])

    def test_write_is_atomic_and_skips_unchanged(self):
        a = "20261009_ana-wpg_1-0_j.caulfield.mp4"
        self.t.game("20261009", "ana-wpg", {"game_id": 1, "away": "ANA", "home": "WPG", "goals": [goal(1, a)]}, files=[a])
        out = os.path.join(self.t.root, "public", "index.json")
        self.assertTrue(idx.write_index(self.build(), out))
        mtime = os.stat(out).st_mtime_ns
        self.assertFalse(idx.write_index(self.build(), out), "same content must not rewrite the file")
        self.assertEqual(os.stat(out).st_mtime_ns, mtime)
        with open(out, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["games"][0]["game_pk"], 1)
        self.assertEqual([f for f in os.listdir(os.path.dirname(out)) if f.endswith(".tmp")], [], "no temp files left behind")
        b = "20261009_ana-wpg_2-0_t.washe.mp4"
        gdir = os.path.join(self.t.root, "20261009", "ana-wpg")
        with open(os.path.join(gdir, b), "wb") as fh:
            fh.write(b"x")
        with open(os.path.join(gdir, "manifest.json"), encoding="utf-8") as fh:
            manifest = json.load(fh)
        manifest["goals"].append(goal(2, b))
        with open(os.path.join(gdir, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh)
        self.assertTrue(idx.write_index(self.build(), out), "a new goal rewrites the index")

    def test_missing_tree_is_not_an_error(self):
        self.assertEqual(idx.build_index((("live", os.path.join(self.t.root, "nope")),))["games"], [])


if __name__ == "__main__":
    unittest.main()
