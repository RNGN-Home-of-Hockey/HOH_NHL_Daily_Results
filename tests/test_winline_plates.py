"""Winline's line kept with its history, and plates drafted from it. Names and prices are invented."""
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "tennis"))

import winline_snapshot as ws  # noqa: E402
import wta_plates as wp  # noqa: E402

FEED = """<Feed><Sport Name="Футбол" Id="1"><Country Name="Лига"><Tournament Name="Кубок"><Match Team1="А" Team2="Б" Id="9">
<line freetext="Победитель" name1="1" odd1="2.0" name2="2" odd2="2.0"></line></Match></Tournament></Country></Sport>
<Sport Name="Теннис" Id="5"><Country Name="WTA" Id="6"><Tournament Name="Город, Страна" Id="7">
<Match Team1="Альфа А." Team2="Бета Б." Id1="11" Id2="22" MatchDate="2026-11-05T13:00:00.000+03:00" MatchUrl="https://x/1" islive="0" Id="100">
<line freetext="Победитель" name1="1" odd1="1.60" name2="2" odd2="2.30"></line>
<line freetext="Фора" value="-1.5" name1="1" odd1="1.70" name2="2" odd2="2.10"></line>
<line freetext="Тотал" value="20.5" name1="Больше" odd1="1.80" name2="Меньше" odd2="1.95"></line>
</Match></Tournament>
<Tournament Name="Город, Страна, Пары" Id="8"><Match Team1="Альфа А./Гамма Г." Team2="Бета Б./Дельта Д." Id="101">
<line freetext="Победитель" name1="1" odd1="1.90" name2="2" odd2="1.90"></line></Match></Tournament>
</Country></Sport></Feed>"""


def fresh_db():
    db = sqlite3.connect(":memory:")
    db.executescript((ROOT / "tools" / "tennis" / "schema.sql").read_text(encoding="utf-8"))
    return db


class Snapshot(unittest.TestCase):
    def setUp(self):
        self.db = fresh_db()
        self.events, self.lines = ws.parse_feed(FEED)

    def test_only_tennis_is_read_and_doubles_are_marked(self):
        self.assertEqual([(e["wl_id"], e["circuit"], e["is_doubles"]) for e in self.events], [("100", "WTA", 0), ("101", "WTA", 1)])
        self.assertEqual({l["market"] for l in self.lines}, {"Победитель", "Фора", "Тотал"})

    def test_a_feed_without_tennis_gives_nothing(self):
        self.assertEqual(ws.parse_feed("<Feed></Feed>"), ([], []))

    def test_a_price_is_stored_only_when_it_changes(self):
        self.assertEqual(ws.store(self.db, self.events, self.lines, "t1"), 4)
        self.assertEqual(ws.store(self.db, self.events, self.lines, "t2"), 0)
        moved = [{**l, "odd1": 1.55} if l["market"] == "Победитель" and l["wl_id"] == "100" else l for l in self.lines]
        self.assertEqual(ws.store(self.db, self.events, moved, "t3"), 1)
        history = self.db.execute("SELECT taken_at, odd1 FROM winline_line WHERE wl_id='100' AND market='Победитель' ORDER BY taken_at").fetchall()
        self.assertEqual(history, [("t1", 1.6), ("t3", 1.55)])

    def test_current_view_shows_the_last_price_of_every_rung(self):
        ws.store(self.db, self.events, self.lines, "t1")
        moved = [{**l, "odd1": 1.55} if l["market"] == "Победитель" and l["wl_id"] == "100" else l for l in self.lines]
        ws.store(self.db, self.events, moved, "t2")
        rows = dict(self.db.execute("SELECT market, odd1 FROM winline_current WHERE wl_id='100'"))
        self.assertEqual(rows, {"Победитель": 1.55, "Фора": 1.7, "Тотал": 1.8})

    def test_event_keeps_its_first_sighting(self):
        ws.store(self.db, self.events, self.lines, "t1")
        ws.store(self.db, self.events, self.lines, "t2")
        self.assertEqual(self.db.execute("SELECT first_seen, last_seen FROM winline_event WHERE wl_id='100'").fetchone(), ("t1", "t2"))


def result(won, margin=4, total=20, full=True, day="2026-10-01", surface="hard", opp=999):
    return {"date": day, "surface": surface, "full": full, "total": total, "won": won, "margin": margin, "opp": opp}


EVENT = {"wl_id": "100", "team1": "Альфа А.", "team2": "Бета Б.", "tournament": "Город, Страна",
         "start_at": "2026-11-05T13:00:00.000+03:00", "url": "u"}


def lines_of(*rows):
    return [{"market": m, "value": v, "odd1": a, "odd2": b} for m, v, a, b in rows]


class Gate(unittest.TestCase):
    def test_price_range_and_sample(self):
        self.assertIsNone(wp.priced(1.40, 3.0, 18, 20))
        self.assertIsNone(wp.priced(5.0, 1.15, 18, 20))
        self.assertIsNone(wp.priced(1.8, 2.0, 9, 9))
        self.assertIsNone(wp.priced(1.8, 2.0, 11, 20))
        self.assertIsNotNone(wp.priced(1.8, 2.0, 18, 20))

    def test_a_record_the_market_already_expects_does_not_pass(self):
        self.assertIsNone(wp.priced(1.52, 2.6, 13, 20))

    def test_the_margin_is_taken_out_of_what_the_market_expects(self):
        self.assertAlmostEqual(wp.fair_price(1.9, 1.9), 0.5)


class Lines(unittest.TestCase):
    def test_winner_goes_to_the_side_with_the_record(self):
        hist = {1: [result(False)] * 10, 2: [result(True)] * 10}
        cards = wp.line_cards(EVENT, lines_of(("Победитель", None, 1.6, 2.3)), hist)
        self.assertEqual([c["text"] for c in cards], ["Победа Бета Б. — 2.3"])

    def test_handicap_is_turned_for_the_second_side(self):
        hist = {1: [result(False, margin=-8)] * 10, 2: [result(True, margin=1)] * 10}
        cards = wp.line_cards(EVENT, lines_of(("Фора", -1.5, 2.0, 1.8)), hist)
        self.assertEqual([c["text"] for c in cards], ["Бета Б. +1.5 по геймам — 1.8"])
        self.assertEqual(cards[0]["hits"], 10)

    def test_a_ladder_gives_one_card_per_market(self):
        hist = {1: [result(True, margin=9)] * 12, 2: [result(False, margin=-9)] * 12}
        ladder = lines_of(("Фора", -1.5, 1.6, 2.2), ("Фора", -2.5, 1.8, 1.9), ("Фора", -3.5, 2.1, 1.7))
        self.assertEqual(len(wp.line_cards(EVENT, ladder, hist)), 1)

    def test_total_needs_both_players(self):
        low = [result(True, total=15)] * 12
        self.assertEqual(wp.line_cards(EVENT, lines_of(("Тотал", 20.5, 1.9, 1.9)), {1: low, 2: low[:5]}), [])
        cards = wp.line_cards(EVENT, lines_of(("Тотал", 20.5, 1.9, 1.9)), {1: low, 2: low})
        self.assertEqual(cards[0]["text"], "Тотал меньше 20.5 — 1.9")
        self.assertEqual(cards[0]["n"], 24)

    def test_retirements_count_for_the_winner_market_but_not_for_games(self):
        cut = [result(True, margin=1, total=7, full=False)] * 12
        self.assertEqual(wp.line_cards(EVENT, lines_of(("Фора", -1.5, 1.9, 1.9)), {1: cut, 2: []}), [])
        self.assertEqual(len(wp.line_cards(EVENT, lines_of(("Победитель", None, 1.9, 1.9)), {1: cut, 2: []})), 1)

    def test_wording_never_calls_a_bet_good(self):
        hist = {1: [result(True, margin=9, total=15)] * 12, 2: [result(True, margin=9, total=15)] * 12}
        ladder = lines_of(("Победитель", None, 1.9, 1.9), ("Фора", -1.5, 1.9, 1.9), ("Тотал", 20.5, 1.9, 1.9))
        for card in wp.line_cards(EVENT, ladder, hist):
            for word in ("выгод", "ставь", "ставк", "верняк", "ценн"):
                self.assertNotIn(word, (card["text"] + card["what"] + card["why"]).lower())

    def test_a_card_says_what_it_counts_and_why_it_was_picked(self):
        hist = {1: [result(True)] * 15 + [result(False)] * 5, 2: []}
        card = wp.line_cards(EVENT, lines_of(("Победитель", None, 2.2, 1.6)), hist, "hard")[0]
        self.assertIn("побед 15 из 20 последних матчей", card["what"])
        self.assertIn("на харде", card["what"])
        self.assertIn("Цена 2.2", card["why"])
        self.assertIn("42 %", card["why"])
        self.assertIn("не прогноз", card["why"])

    def test_a_card_lists_the_matches_behind_its_count(self):
        hist = {1: [result(True, opp=5)] * 11 + [result(False, opp=6)] * 2, 2: []}
        card = wp.line_cards(EVENT, lines_of(("Победитель", None, 1.9, 1.9)), hist)[0]
        self.assertEqual(len(card["matches"]), card["n"])
        self.assertEqual(sum(m["hit"] for m in card["matches"]), card["hits"])

    def test_handicap_matches_show_the_margin_and_whether_it_played(self):
        hist = {1: [result(True, margin=5)] * 9 + [result(False, margin=-1)] * 3, 2: []}
        card = wp.line_cards(EVENT, lines_of(("Фора", 1.5, 1.9, 1.9)), hist)[0]
        self.assertEqual((card["hits"], card["n"]), (12, 12))
        self.assertEqual(card["matches"][-1]["note"], "разница геймов -1")
        self.assertTrue(card["matches"][-1]["hit"])
        self.assertIn("фора +1.5 сыграла бы в 12 из 12", card["what"])

    def test_total_says_how_many_each_player_brought(self):
        one, two = [result(True, total=15)] * 12, [result(True, total=15)] * 8 + [result(True, total=30)] * 4
        card = wp.line_cards(EVENT, lines_of(("Тотал", 20.5, 1.9, 1.9)), {1: one, 2: two})[0]
        self.assertEqual(card["text"], "Тотал меньше 20.5 — 1.9")
        self.assertIn("20 из 24", card["what"])
        self.assertIn("Альфа А. 12 из 12", card["what"])
        self.assertIn("Бета Б. 8 из 12", card["what"])
        self.assertEqual({m["player"] for m in card["matches"]}, {"Альфа А.", "Бета Б."})


class Facts(unittest.TestCase):
    def test_head_to_head_names_the_leader(self):
        cards = wp.fact_cards(EVENT, {1: [], 2: []}, {1: [], 2: []}, [result(False), result(False), result(True)], None)
        self.assertEqual([c["text"] for c in cards], ["Личные встречи: Бета Б. ведёт 2-1"])

    def test_level_head_to_head(self):
        cards = wp.fact_cards(EVENT, {1: [], 2: []}, {1: [], 2: []}, [result(False), result(True)], None)
        self.assertEqual(cards[0]["text"], "Личные встречи: 1-1")

    def test_form_needs_five_and_surface_needs_the_sample(self):
        form = {1: [result(True)] * 4, 2: [result(True)] * 5}
        hist = {1: [result(True)] * 9, 2: [result(True)] * 10}
        texts = [c["text"] for c in wp.fact_cards(EVENT, hist, form, [], "hard")]
        self.assertEqual(texts, ["Бета Б.: 5-0 в последних 5 матчах", "Бета Б.: 10-0 в последних 10 матчах на харде"])


class Linking(unittest.TestCase):
    def setUp(self):
        self.db = fresh_db()
        for pid, name, wta in (("a", "Анна Альфа", "1"), ("b", "Бея Бета", "2"), ("c", "Вера Вторая", "3"), ("d", "Варя Вторая", "4"),
                               ("e", "Ёлка Семёнова", "5")):
            self.db.execute("INSERT INTO player (player_id, name_ru, wta_id, tour, source) VALUES (?, ?, ?, 'WTA', 't')", (pid, name, wta))
        self.index = wp.player_index(self.db)

    def test_surname_and_initial(self):
        self.assertEqual(wp.find_wta_id("Альфа А.", self.index), 1)
        self.assertEqual(wp.find_wta_id("Семенова Е.", self.index), 5)

    def test_two_candidates_or_none_link_nobody(self):
        self.assertIsNone(wp.find_wta_id("Вторая В.", self.index))
        self.assertIsNone(wp.find_wta_id("Неизвестная Н.", self.index))
        self.assertIsNone(wp.find_wta_id("Альфа Б.", self.index))
        self.assertIsNone(wp.find_wta_id(None, self.index))

    def test_surface_from_the_city(self):
        self.db.execute("INSERT INTO tournament (tournament_key, tour, tournament, surface, first_seen, source) VALUES ('k', 'WTA', 'Город', 'hard', '2026', 't')")
        index = wp.surface_index(self.db)
        self.assertEqual(wp.surface_of("Город, Страна", index), "hard")
        self.assertIsNone(wp.surface_of("Другой, Страна", index))


class Learned(unittest.TestCase):
    def setUp(self):
        self.db = fresh_db()
        self.db.execute("INSERT INTO player (player_id, fs_id, wta_id, tour, source) VALUES ('a', 'F1', '1', 'WTA', 't')")
        self.db.execute("INSERT INTO player (player_id, fs_id, wta_id, tour, source) VALUES ('b', 'F2', '2', 'WTA', 't')")

    def link(self, wl_id, team1, team2, odd1, odd2, pre1, pre2, name1="Иная И.", name2="Другая Д."):
        self.db.execute("INSERT INTO match (match_id, p1_fs_id, p2_fs_id, source) VALUES (?, 'F1', 'F2', 't')", (f"M{wl_id}",))
        self.db.execute("INSERT INTO match_odds (match_id, wl_id, pre1, pre2, source) VALUES (?, ?, ?, ?, 't')", (f"M{wl_id}", wl_id, pre1, pre2))
        ws.store(self.db, [{"wl_id": wl_id, "circuit": "WTA", "tournament": "Т", "team1": name1, "team2": name2, "team1_id": team1,
                            "team2_id": team2, "start_at": "2026-11-05", "url": "", "is_doubles": 0}],
                 [{"wl_id": wl_id, "market": "Победитель", "value": None, "odd1": odd1, "odd2": odd2}], f"t{wl_id}")

    def test_same_order_and_crossed_order_by_the_prices(self):
        self.link("1", "w1", "w2", 1.5, 2.5, 1.5, 2.5)
        self.assertEqual(wp.learned_players(self.db, {}), {"w1": 1, "w2": 2})

    def test_crossed(self):
        self.link("1", "w2", "w1", 2.5, 1.5, 1.5, 2.5)
        self.assertEqual(wp.learned_players(self.db, {}), {"w2": 2, "w1": 1})

    def test_level_prices_need_a_name(self):
        self.link("1", "w1", "w2", 1.9, 1.9, 1.9, 1.9)
        self.assertEqual(wp.learned_players(self.db, {}), {})
        self.assertEqual(wp.learned_players(self.db, {("другая", "д"): {1}}), {"w2": 1, "w1": 2})

    def test_an_id_pointing_at_two_players_is_dropped(self):
        self.link("1", "w1", "w2", 1.5, 2.5, 1.5, 2.5)
        self.link("2", "w1", "w2", 2.5, 1.5, 1.5, 2.5)
        self.assertEqual(wp.learned_players(self.db, {}), {})

    def test_build_prefers_the_learned_id(self):
        event = {**EVENT, "team1": "Иначе И.", "team2": "Совсем С.", "team1_id": "w1", "team2_id": "w2"}
        built = wp.build(event, [], {}, {}, {"город": "hard"}, {"w1": 1, "w2": 2})
        self.assertTrue(built["linked"])


class Build(unittest.TestCase):
    def setUp(self):
        self.ids = {("альфа", "а"): {1}, ("бета", "б"): {2}}
        self.surfaces = {"город": "hard"}

    def test_future_results_are_not_used(self):
        players = {1: [result(True, day="2026-11-06")] * 12 + [result(False, day="2026-10-01")] * 2, 2: []}
        built = wp.build(EVENT, [], players, self.ids, self.surfaces)
        self.assertEqual(built["facts"], [])

    def test_unknown_player_gives_a_note_and_no_cards(self):
        built = wp.build({**EVENT, "team2": "Неизвестная Н."}, lines_of(("Победитель", None, 1.9, 1.9)), {}, self.ids, self.surfaces)
        self.assertFalse(built["linked"])
        self.assertEqual((built["facts"], built["lines"]), ([], []))
        self.assertTrue(built["notes"])

    def test_unknown_surface_still_gives_form_and_head_to_head(self):
        players = {1: [result(True, opp=2)] * 6, 2: [result(False, opp=1)] * 6}
        built = wp.build({**EVENT, "tournament": "Другой, Страна"}, lines_of(("Победитель", None, 1.9, 1.9)), players, self.ids, self.surfaces)
        self.assertEqual({c["kind"] for c in built["facts"]}, {"form", "h2h"})
        self.assertEqual(built["lines"], [])
        self.assertTrue(any("покрытие" in n for n in built["notes"]))

    def test_end_to_end_from_the_feed(self):
        db = fresh_db()
        events, lines = ws.parse_feed(FEED)
        ws.store(db, events, lines, "t1")
        found = wp.upcoming(db, None, None)
        self.assertEqual([e["wl_id"] for e in found], ["100"])  # doubles left out
        self.assertEqual(len(found[0]["lines"]), 3)
        self.assertEqual(wp.upcoming(db, "2026-11-06", None), [])
        self.assertEqual(len(wp.upcoming(db, None, "альфа")), 1)


if __name__ == "__main__":
    unittest.main()
