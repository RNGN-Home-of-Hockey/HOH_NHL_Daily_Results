#!/usr/bin/env python3
"""Checks for tools/epl_text.py: club names in cases and gender, counts in whole numbers, plate texts that fit."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import epl_engine as eng  # noqa: E402
import epl_text as T  # noqa: E402


def test_club_cases():
    assert T.gen("Эвертон") == "Эвертона" and T.dat("Ливерпуль") == "Ливерпулю" and T.ins("Ипсвич") == "Ипсвичем"
    assert T.gen("Астон Вилла") == "Астон Виллы" and T.gen("Челси") == "Челси" and T.gen("Манчестер Сити") == "Манчестер Сити"
    assert T.gen("Вест Хэм") == "Вест Хэма" and T.ins("Лестер") == "Лестером" and T.gen("Бернли") == "Бернли"  # clubs not in the table
    assert T.agree("Астон Вилла", "не пропускал и вёл") == "не пропускала и вела" and T.agree("Челси", "не пропускал") == "не пропускал"
    title = "Астон Вилла подавал не больше 4 угловых в 7 из 8 последних матчей, Ньюкасл — подавал больше"
    assert T.agree_title(title, ("Астон Вилла", "Ньюкасл")).startswith("Астон Вилла подавала не больше")
    assert T.agree_title(title, ("Астон Вилла", "Ньюкасл")).endswith("Ньюкасл — подавал больше")


def test_counts_in_whole_numbers():
    # owner 2026-10-16: «меньше 2,5 гола» -> say it in whole goals
    assert T.total("under", 2.5) == "не больше 2 голов" and T.total("under", 3) == "не больше 2 голов"  # 3 exactly is a refund
    assert T.total("over", 2.5) == "3+ гола" and T.total("over", 3) == "4+ гола" and T.total("over", 0.5) == "хотя бы один гол"
    assert T.total("under", 0.5) == "без голов" and T.total("under", 1.5) == "не больше 1 гола"
    assert T.total("under", 4.5, "corner") == "не больше 4 угловых" and T.total("over", 2.5, "card") == "3+ карточки"
    assert T.between(2, 3) == "2–3 гола" and T.between(0, 8, "corner") == "не больше 8 угловых" and T.between(2, 2, "card") == "ровно 2 карточки"
    assert T.word(8.5, "shot") == "удара" and T.word(9, "shot") == "ударов" and T.num(8.5) == "8,5" and T.num(12.0) == "12"
    assert T.margin_verb(0) == "не проигрывал" and T.margin_verb(-1) == "не проигрывал крупнее чем в 1 мяч"
    assert T.margin_verb(2) == "выигрывал с разницей в 2+ мяча"


def test_plate_texts_fit():
    assert T.pair("Эвертон", "Челси") == "Эвертон – Челси" and T.pair("Манчестер Сити", "Кристал Пэлас") == "Ман Сити – Кристал Пэлас"
    head = T.pooled_headline("ничья во втором тайме", "Эвертон", "Челси", 5, 8, 3, 8)
    assert head == "Ничья во 2-м тайме: Эвертон 5 из 8, Челси 3 из 8", head  # "— 5 из 8 у Эвертона, 3 из 8 у Челси" is 53
    assert T.pooled_headline("ничья", "Эвертон", "Челси", 5, 8, 3, 8) == "Ничья — 5 из 8 у Эвертона, 3 из 8 у Челси"
    title = T.sides_title("Во втором тайме ", "Эвертон", "без поражений", 7, 8, "Челси", "без побед", 6, 8)
    assert title == "Во втором тайме Эвертон — без поражений в 7 из 8 последних матчей, Челси — без побед в 6 из 8"
    head = T.sides_headline("Во 2-м тайме ", "Эвертон", "без поражений", 7, 8, "Челси", "без побед", 6, 8, prefer="h")
    assert head == "Во 2-м тайме Эвертон — без поражений в 7 из 8 матчей", head
    assert T.headline("Челси пропускал во втором тайме в 7 из 8 последних матчей") == "Челси пропускал во 2-м тайме в 7 из 8 матчей"
    assert T.headline("Эвертон не пропускал в первом тайме в 6 из 8 последних матчей, Челси — нет") == "Эвертон не пропускал в 1-м тайме в 6 из 8 матчей"
    assert T.fits({"headline": "x" * 52, "team": "x" * 20, "bet": "x" * 40}) == {"headline": "ok", "team": "small", "bet": "long"}


def test_same_fact_on_nested_lines_is_one_card():
    card = lambda line, hits: {"rule": "team_corners", "market": {"line": line, "side": "under", "family": "corners", "period": "FT", "scope": "away"},  # noqa: E731
                               "evidence": {"hits": hits, "sample": 8}, "plate": {"crest": "away"}, "details": {}}
    assert eng.same_games(card(4.5, 6)) == eng.same_games(card(5.5, 6))  # "не больше 4" and "не больше 5" in the same 6 of 8 games
    assert eng.same_games(card(4.5, 6)) != eng.same_games(card(5.5, 7))
    assert eng.same_games({**card(4.5, 6), "market": {**card(4.5, 6)["market"], "line": None, "side": None}}) is None  # buckets never merge


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
