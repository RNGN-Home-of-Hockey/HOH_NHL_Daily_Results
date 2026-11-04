#!/usr/bin/env python3
"""A look at The Odds API before buying anything: which tennis it has, how deep, what a download costs.

The key is asked for hidden, kept only in local-data (not in git) and never printed; the API takes it in
the address, so addresses are never printed either. Spends at most --max-credits.

    python tools/tennis/odds_api_probe.py save-key
    python tools/tennis/odds_api_probe.py probe --max-credits 100
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEY_FILE = HERE.parents[1] / "local-data" / "tennis" / "secrets" / "odds_api.key"
API = "https://api.the-odds-api.com/v4"
USER_AGENT = "RNGN-Matchday-data/0.1"
# A Slam each year from before the history is said to begin, to find where it starts.
DEPTH_DATES = ("2026-01-25", "2024-01-20", "2023-01-20", "2021-02-12", "2020-09-05", "2020-01-25", "2019-01-20")
MARKETS = "h2h,spreads,totals"


def read_key() -> str:
    try:
        return KEY_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        raise SystemExit("Ключа нет: сначала save-key") from None


def save_key() -> int:
    key = getpass.getpass("Вставьте ключ (на экране не появится): ").strip()
    if not key:
        print("Пусто, ничего не сохранено")
        return 1
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(key)
    print(f"Ключ сохранён, знаков: {len(key)}")
    return 0


class Client:
    def __init__(self, key: str, max_credits: int):
        self.key, self.left_to_spend = key, max_credits
        self.remaining = self.used = None

    def get(self, path: str, cost: int = 0, **params):
        """(status, body). Refuses what would go over the budget. Never shows the address."""
        if cost > self.left_to_spend:
            return None, {"message": "пропущено: вышло бы за лимит кредитов"}
        query = urllib.parse.urlencode({"apiKey": self.key, **params})
        request = urllib.request.Request(f"{API}{path}?{query}", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                status, raw, headers = response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            status, raw, headers = error.code, error.read(), error.headers
        except (urllib.error.URLError, TimeoutError) as error:
            return None, {"message": f"сеть: {type(error).__name__}"}
        self.remaining = headers.get("x-requests-remaining", self.remaining)
        self.used = headers.get("x-requests-used", self.used)
        spent = headers.get("x-requests-last")
        self.left_to_spend -= int(spent) if spent and spent.isdigit() else 0
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, {"message": raw[:200].decode("utf-8", "replace")}


def message_of(body) -> str:
    return (body.get("message") or body.get("error_code") or "") if isinstance(body, dict) else ""


def bookmaker_markets(events: list) -> tuple[set, dict]:
    books, markets = set(), {}
    for event in events:
        for book in event.get("bookmakers", []):
            books.add(book["key"])
            for market in book.get("markets", []):
                markets[market["key"]] = markets.get(market["key"], 0) + 1
    return books, markets


def probe(client: Client) -> int:
    status, sports = client.get("/sports", all="true")
    if status != 200:
        print("Ключ не принят:", status, message_of(sports))
        return 1
    tennis = [s for s in sports if s.get("group") == "Tennis"]
    print(f"Теннисных турниров у них: {len(tennis)}; остаток кредитов: {client.remaining}, потрачено: {client.used}")
    for sport in tennis:
        print(f"  {sport['key']:36} {'идёт' if sport.get('active') else '-':5} {sport.get('title')}")

    active = [s["key"] for s in tennis if s.get("active")][:1]
    if active:
        status, events = client.get(f"/sports/{active[0]}/odds", cost=3, regions="eu", markets=MARKETS)
        if status == 200:
            books, markets = bookmaker_markets(events)
            print(f"\nСейчас {active[0]}: матчей {len(events)}, контор {len(books)}, рынки по строкам {markets}")
        else:
            print("\nТекущие коэффициенты:", status, message_of(events))

    print("\nИстория, Australian Open / US Open WTA:")
    for day in DEPTH_DATES:
        key = "tennis_wta_us_open" if day.startswith("2020-09") else "tennis_wta_aus_open_singles"
        status, events = client.get(f"/historical/sports/{key}/events", cost=1, date=f"{day}T12:00:00Z")
        if status != 200:
            print(f"  {day} {key}: {status} {message_of(events)}")
            if status in (401, 403):
                print("  История этому тарифу недоступна, дальше не спрашиваю.")
                break
            continue
        found = events.get("data", []) if isinstance(events, dict) else []
        print(f"  {day} {key}: событий {len(found)}, снимок {events.get('timestamp') if isinstance(events, dict) else '?'}")
        if not found:
            continue
        status, odds = client.get(f"/historical/sports/{key}/odds", cost=30, date=f"{day}T12:00:00Z", regions="eu", markets=MARKETS)
        if status == 200:
            data = odds.get("data", [])
            books, markets = bookmaker_markets(data)
            print(f"    коэффициенты: матчей {len(data)}, контор {len(books)}, рынки по строкам {markets}")
        else:
            print(f"    коэффициенты: {status} {message_of(odds)}")
    print(f"\nОстаток кредитов: {client.remaining}, потрачено всего: {client.used}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["save-key", "probe"])
    parser.add_argument("--max-credits", type=int, default=100)
    args = parser.parse_args()
    if args.command == "save-key":
        return save_key()
    return probe(Client(read_key(), args.max_credits))


if __name__ == "__main__":
    sys.exit(main())
