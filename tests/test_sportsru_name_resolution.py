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

        # Current Sports.ru club rosters are the preferred fast path and use
        # /tags/<id>/ player links rather than the old /hockey/person/<slug>/ pages.
        roster_html = """
        <table>
          <tr><td><a href="/tags/161155082/">Итан Кардуэлл</a></td><td>нападающий</td></tr>
          <tr><td><a href="/tags/999000001/">Эрик Полкамп</a></td><td>защитник</td></tr>
          <tr><td><a href="/tags/999000002/">Джимми Хантингтон</a></td><td>нападающий</td></tr>
        </table>
        """
        original_fake = bot.http_get_text
        roster_calls = []
        def roster_get(url: str, timeout: int = 30) -> str:
            roster_calls.append(url)
            if "/hockey/club/san-jose-sharks/team/" in url:
                return roster_html
            raise RuntimeError("unexpected profile fallback " + url)
        bot.http_get_text = roster_get
        roster_names = bot.fetch_sportsru_team_roster_names("SJS")
        assert "Итан Кардуэлл" in roster_names, roster_names
        assert bot.resolve_sportsru_name_from_team_roster("Ethan Cardwell", roster_names) == "Итан Кардуэлл"
        assert bot.resolve_sportsru_name_from_team_roster("Eric Pohlkamp", roster_names) == "Эрик Полкамп"
        assert bot.resolve_sportsru_name_from_team_roster("Jimmy Huntington", roster_names) == "Джимми Хантингтон"

        # Lower absolute transliteration similarity is acceptable only when the
        # roster winner is very clearly separated from every other candidate.
        pittsburgh_roster = [
            "Эйвери Хэйс",
            "Топиас Лейнонен",
            "Сергей Мурашов",
        ]
        assert bot.resolve_sportsru_name_from_team_roster("Avery Hayes", pittsburgh_roster) == "Эйвери Хэйс"
        assert bot.resolve_sportsru_name_from_team_roster("Thomas Bordeleau", pittsburgh_roster) == ""

        assert len(roster_calls) == 1, roster_calls
        bot.http_get_text = original_fake

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
