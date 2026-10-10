import json
import os
import tempfile
import unittest

import hoh_clip_index
import hoh_cover_sync as cs

JPEG = b"\xff\xd8\xff\xe0" + b"x" * 4000


def wanted(*rows):
    return json.dumps({"ok": True, "games": [{"game_pk": pk, "source_key": key, "state": st, "start": "2026-10-10T17:00:00Z"} for pk, key, st in rows]}).encode()


class Fetcher:
    """Stands in for the network: the Worker list, then one answer per cover request."""

    def __init__(self, list_body, covers):
        self.list_body, self.covers, self.calls = list_body, covers, []

    def __call__(self, url, timeout=25, limit=0):
        self.calls.append(url)
        if url.endswith("/covers/wanted"):
            return 200, "application/json", self.list_body
        for key, answer in self.covers.items():
            if f"source_key={key}" in url:
                if isinstance(answer, Exception):
                    raise answer
                return answer
        return 404, "application/json", b"{}"


class ParseTests(unittest.TestCase):
    def test_only_sane_rows_survive(self):
        payload = {"ok": True, "games": [
            {"game_pk": 2026020069, "source_key": "vk_-1_2", "state": "off"},
            {"game_pk": "2026020070", "source_key": "vk_a"},
            {"game_pk": True, "source_key": "vk_a"},
            {"game_pk": 5, "source_key": "vk_a"},
            {"game_pk": 2026020071, "source_key": "../../etc/passwd"},
            {"game_pk": 2026020072, "source_key": ""},
            "junk",
        ]}
        self.assertEqual(cs.parse_wanted(payload), [(2026020069, "vk_-1_2", "OFF")])
        self.assertEqual(cs.parse_wanted({"ok": False, "games": [{"game_pk": 2026020069, "source_key": "a"}]}), [])
        self.assertEqual(cs.parse_wanted(None), [])

    def test_image_check(self):
        self.assertTrue(cs.looks_like_image("image/jpeg", JPEG))
        self.assertFalse(cs.looks_like_image("text/html", JPEG), "a VK error page is not a cover")
        self.assertFalse(cs.looks_like_image("image/jpeg", b"\xff\xd8\xff" + b"x" * 10), "too small")
        self.assertFalse(cs.looks_like_image("image/jpeg", b"<html>" + b"x" * 5000), "not an image")
        self.assertFalse(cs.looks_like_image("image/jpeg", b"\xff\xd8\xff" + b"x" * (7 * 1024 * 1024)), "too big")


class RefreshTests(unittest.TestCase):
    def test_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "2026020069.jpg")
            self.assertTrue(cs.needs_refresh(path, "OFF"), "no cover yet: save it whatever the state")
            open(path, "wb").write(JPEG)
            mtime = os.stat(path).st_mtime
            self.assertFalse(cs.needs_refresh(path, "LIVE", now=mtime + 60), "fresh enough")
            self.assertTrue(cs.needs_refresh(path, "LIVE", now=mtime + 21 * 60), "the game is on: refresh every 20 minutes")
            self.assertTrue(cs.needs_refresh(path, "FUT", now=mtime + 21 * 60))
            self.assertFalse(cs.needs_refresh(path, "OFF", now=mtime + 10 * 24 * 3600), "a finished game keeps its cover")
            self.assertFalse(cs.needs_refresh(path, "FINAL", now=mtime + 10 * 24 * 3600))


class SyncTests(unittest.TestCase):
    def run_sync(self, tmp, fetcher, shrinker=lambda data: b"\xff\xd8\xff" + b"s" * 2000, now=None):
        return cs.sync(fetch=fetcher, out_dir=tmp, shrinker=shrinker, now=now)

    def test_saves_new_covers_and_skips_finished_ones(self):
        with tempfile.TemporaryDirectory() as tmp:
            open(os.path.join(tmp, "2026020002.jpg"), "wb").write(b"old")
            fetcher = Fetcher(wanted((2026020001, "vk_a", "LIVE"), (2026020002, "vk_b", "OFF")), {"vk_a": (200, "image/jpeg", JPEG)})
            result = self.run_sync(tmp, fetcher)
            self.assertEqual(result, {"saved": 1, "skipped": 1, "failed": 0, "wanted": 2})
            self.assertEqual(sorted(os.listdir(tmp)), ["2026020001.jpg", "2026020002.jpg"])
            self.assertEqual(open(os.path.join(tmp, "2026020002.jpg"), "rb").read(), b"old", "finished game: not touched")
            self.assertEqual(open(os.path.join(tmp, "2026020001.jpg"), "rb").read()[:3], b"\xff\xd8\xff")
            self.assertEqual(len(fetcher.calls), 2, "the list and one cover, nothing for the finished game")

    def test_failures_leave_old_covers_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "2026020001.jpg")
            open(path, "wb").write(b"previous")
            os.utime(path, (1, 1))
            fetcher = Fetcher(wanted((2026020001, "vk_a", "LIVE"), (2026020003, "vk_c", "LIVE"), (2026020004, "vk_d", "LIVE"), (2026020005, "vk_e", "LIVE")), {
                "vk_a": (404, "application/json", b"{}"),
                "vk_c": (200, "text/html", b"<html>" + b"x" * 5000),
                "vk_d": OSError("timeout"),
                "vk_e": (200, "image/jpeg", JPEG),
            })
            result = self.run_sync(tmp, fetcher, shrinker=lambda data: None)
            self.assertEqual(result["saved"], 0)
            self.assertEqual(result["failed"], 4, "dead VK link, error page, network error, and a picture ffmpeg cannot read")
            self.assertEqual(open(path, "rb").read(), b"previous", "the cover we already have survives a failed refresh")
            self.assertEqual(sorted(os.listdir(tmp)), ["2026020001.jpg"], "no half-written files")

    def test_worker_down_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = cs.sync(fetch=lambda url, timeout=25, limit=0: (503, "application/json", b"{}"), out_dir=tmp)
            self.assertEqual(result["error"], "wanted_http_503")
            self.assertEqual(os.listdir(tmp), [])

    def test_a_run_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [(2026020100 + i, f"vk_{i}", "LIVE") for i in range(30)]
            fetcher = Fetcher(wanted(*rows), {f"vk_{i}": (200, "image/jpeg", JPEG) for i in range(30)})
            result = self.run_sync(tmp, fetcher)
            self.assertEqual(result["saved"], cs.MAX_PER_RUN, "the rest waits for the next run")

    def test_keys_are_url_encoded(self):
        with tempfile.TemporaryDirectory() as tmp:
            fetcher = Fetcher(wanted((2026020001, "vk_-1:2.3", "LIVE")), {"vk_-1%3A2.3": (200, "image/jpeg", JPEG)})
            self.assertEqual(self.run_sync(tmp, fetcher)["saved"], 1)
            self.assertIn("source_key=vk_-1%3A2.3", fetcher.calls[1])

    def test_save_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            cs.save(tmp, 2026020001, b"\xff\xd8\xff" + b"1" * 10)
            cs.save(tmp, 2026020001, b"\xff\xd8\xff" + b"2" * 10)
            self.assertEqual(os.listdir(tmp), ["2026020001.jpg"])
            self.assertEqual(open(os.path.join(tmp, "2026020001.jpg"), "rb").read()[-1:], b"2")


class BackfillTests(unittest.TestCase):
    """The one-off walk through the archive: pages newest first, resumable, gentle."""

    def pages(self, *pages):
        calls = []

        def fetch(url, timeout=25, limit=0):
            calls.append(url)
            if "/covers/wanted" in url:
                number = len([c for c in calls if "/covers/wanted" in c]) - 1
                return 200, "application/json", json.dumps(pages[number]).encode()
            return 200, "image/jpeg", JPEG

        return fetch, calls

    def page(self, rows, next_cursor=None):
        return {"ok": True, "games": [{"game_pk": pk, "source_key": key, "state": "OFF", "start": "2026-10-06T23:00:00Z"} for pk, key in rows], "next": next_cursor}

    def test_walks_every_page_and_keeps_what_it_has(self):
        with tempfile.TemporaryDirectory() as tmp:
            open(os.path.join(tmp, "2026020002.jpg"), "wb").write(b"already here")
            fetch, calls = self.pages(
                self.page([(2026020003, "vk_c"), (2026020002, "vk_b")], "2026-10-06T23:00:00Z|2026020002"),
                self.page([(2026020001, "vk_a")], None),
            )
            sleeps = []
            stats = cs.backfill(fetch=fetch, out_dir=tmp, shrinker=lambda d: b"\xff\xd8\xff" + b"s" * 2000, pause=0.5, sleep=sleeps.append, log=lambda m: None)
            self.assertEqual(stats, {"pages": 2, "games": 3, "have": 1, "saved": 2, "failed": 0})
            self.assertEqual(sorted(os.listdir(tmp)), ["2026020001.jpg", "2026020002.jpg", "2026020003.jpg"])
            self.assertEqual(open(os.path.join(tmp, "2026020002.jpg"), "rb").read(), b"already here", "an existing cover is not downloaded again")
            self.assertIn("since=2024-09-01&limit=100", calls[0])
            self.assertIn("before=2026-10-06T23%3A00%3A00Z%7C2026020002", [c for c in calls if "/covers/wanted" in c][1], "the second page starts at the cursor")
            self.assertEqual(sleeps, [0.5, 0.5], "a pause after each download, none for covers already kept")

    def test_a_second_run_downloads_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = dict(out_dir=tmp, shrinker=lambda d: b"\xff\xd8\xff" + b"s" * 2000, pause=0, sleep=lambda s: None, log=lambda m: None)
            fetch, _ = self.pages(self.page([(2026020001, "vk_a")]))
            self.assertEqual(cs.backfill(fetch=fetch, **args)["saved"], 1)
            fetch, calls = self.pages(self.page([(2026020001, "vk_a")]))
            again = cs.backfill(fetch=fetch, **args)
            self.assertEqual((again["saved"], again["have"]), (0, 1))
            self.assertEqual(len([c for c in calls if "vk-cover" in c]), 0)

    def test_dead_covers_are_counted_not_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            def fetch(url, timeout=25, limit=0):
                if "/covers/wanted" in url:
                    return 200, "application/json", json.dumps(self.page([(2026020001, "vk_a"), (2026020002, "vk_b"), (2026020003, "vk_c")])).encode()
                if "vk_a" in url:
                    raise OSError("HTTP 404")
                if "vk_b" in url:
                    return 200, "text/html", b"<html>" + b"x" * 5000
                return 200, "image/jpeg", JPEG
            stats = cs.backfill(fetch=fetch, out_dir=tmp, shrinker=lambda d: b"\xff\xd8\xff" + b"s" * 2000, pause=0, sleep=lambda s: None, log=lambda m: None)
            self.assertEqual((stats["saved"], stats["failed"]), (1, 2))
            self.assertEqual(os.listdir(tmp), ["2026020003.jpg"])

    def test_bad_input_and_bad_cursors_stop_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                cs.backfill(since="yesterday", out_dir=tmp)
            fetch, calls = self.pages(self.page([(2026020001, "vk_a")], "not a cursor at all"), self.page([(2026020009, "vk_z")]))
            stats = cs.backfill(fetch=fetch, out_dir=tmp, shrinker=lambda d: b"\xff\xd8\xff" + b"s" * 2000, pause=0, sleep=lambda s: None, log=lambda m: None)
            self.assertEqual(stats["pages"], 1, "a cursor that does not look like one ends the walk instead of being sent back")
            with self.assertRaises(RuntimeError):
                cs.backfill(fetch=lambda url, timeout=25, limit=0: (503, "application/json", b"{}"), out_dir=tmp)


class IndexCoversTests(unittest.TestCase):
    def test_covers_listed_in_the_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            covers = os.path.join(tmp, "covers")
            os.makedirs(covers)
            open(os.path.join(covers, "2026020069.jpg"), "wb").write(JPEG)
            open(os.path.join(covers, "notes.txt"), "wb").write(b"x")
            open(os.path.join(covers, "..hidden.jpg"), "wb").write(b"x")
            open(os.path.join(covers, "2026020070.jpg"), "wb").write(b"")
            index = hoh_clip_index.build_index(trees=(), covers_dir=covers)
            self.assertEqual(list(index["covers"]), ["2026020069"], "only <game_pk>.jpg files with content")
            entry = index["covers"]["2026020069"]
            self.assertEqual(entry["path"], "covers/2026020069.jpg")
            self.assertEqual(entry["bytes"], len(JPEG))
            self.assertIsInstance(entry["mtime"], int)
            self.assertEqual(hoh_clip_index.build_index(trees=(), covers_dir=os.path.join(tmp, "missing"))["covers"], {}, "no folder yet is fine")


if __name__ == "__main__":
    unittest.main()
