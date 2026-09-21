#!/usr/bin/env python3
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import nhl_single_result_bot as bot


def main() -> None:
    original_get = bot.http_get_text
    original_enabled = bot.SPORTSRU_ON_DEMAND_ENABLED
    calls = []

    profiles = {
        "yegor-borikov": ("Егор Бориков", "Yegor Borikov"),
        "beckett-hamilton": ("Беккет Хэмилтон", "Beckett Hamilton"),
    }

    def fake_get(url: str, timeout: int = 30) -> str:
        calls.append(url)
        for slug, (ru, en) in profiles.items():
            if f"/hockey/person/{slug}/" in url:
                return f"<html><body><h1>{ru}</h1><div>{en}</div></body></html>"
            if f"/hockey/player/{slug}/" in url:
                raise RuntimeError("not found")
        if "/search/?q=" in url:
            return "<html><body></body></html>"
        raise RuntimeError("not found")

    try:
        bot.http_get_text = fake_get
        bot.SPORTSRU_ON_DEMAND_ENABLED = True
        names = {}
        events = [
            bot.ScoringEvent(
                period=1,
                period_type="REGULAR",
                time="10.00",
                team_for="UTA",
                home_goals=1,
                away_goals=0,
                scorer="Yegor Borikov",
                assists=["Beckett Hamilton"],
                scorer_id=111,
                assist_ids=[222],
            ),
        ]
        bot.resolve_event_people_from_sportsru(events, names)
        assert events[0].scorer == "Бориков", events[0].scorer
        assert events[0].assists == ["Хэмилтон"], events[0].assists
        assert names == {111: "Бориков", 222: "Хэмилтон"}, names
        bot.assert_no_english_scoring_names(events)

        before = len(calls)
        more = [
            bot.ScoringEvent(
                period=2,
                period_type="REGULAR",
                time="05.00",
                team_for="UTA",
                home_goals=2,
                away_goals=0,
                scorer="Yegor Borikov",
                assists=["Beckett Hamilton"],
                scorer_id=111,
                assist_ids=[222],
            )
        ]
        bot.resolve_event_people_from_sportsru(more, names)
        assert len(calls) == before, (before, len(calls))

        unresolved = [
            bot.ScoringEvent(
                period=1,
                period_type="REGULAR",
                time="01.00",
                team_for="SEA",
                home_goals=0,
                away_goals=1,
                scorer="Ty Nelson",
                assists=[],
                scorer_id=333,
                assist_ids=[],
            )
        ]
        try:
            bot.assert_no_english_scoring_names(unresolved)
        except RuntimeError as exc:
            assert "Ty Nelson" in str(exc)
        else:
            raise AssertionError("English-name publication guard did not fire")

        mixed = [
            bot.ScoringEvent(
                period=1,
                period_type="REGULAR",
                time="02.00",
                team_for="SEA",
                home_goals=0,
                away_goals=1,
                scorer="Yegor Бориков",
                assists=[],
                scorer_id=444,
                assist_ids=[],
            )
        ]
        try:
            bot.assert_no_english_scoring_names(mixed)
        except RuntimeError as exc:
            assert "Yegor Бориков" in str(exc)
        else:
            raise AssertionError("Mixed Latin/Cyrillic publication guard did not fire")

        print("SPORTSRU_ON_DEMAND_NAME_RESOLUTION_OK")
    finally:
        bot.http_get_text = original_get
        bot.SPORTSRU_ON_DEMAND_ENABLED = original_enabled


if __name__ == "__main__":
    main()
