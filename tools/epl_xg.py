#!/usr/bin/env python3
"""Our own expected-goals model for the EPL (no third-party xG).

The Premier League stats API gives every team's shots of a match split by situation (big chances, inside
the box, outside the box) and its goals. We fit what a shot of each kind is worth on the real goals of all
the collected matches (non-negative least squares, no intercept) and apply it to every match:

    npxG(team, match) = a * big chances + b * other shots inside the box + c * shots outside the box

Penalties are left out (the data lists penalty goals, not penalty awards), so this is a non-penalty model.
It is checked on a later period it was not fitted on, and against the real Opta xG that the Fantasy API
publishes per player and gameweek for the current season.

  python -I tools/epl_xg.py [--no-fpl]

Reads  local-data/epl/raw/pulselive/match-stats, normalized/matches.json (tools/epl_collect.py)
Writes local-data/epl/normalized/xg_proxy.json {match id: {team id: npxG}} and xg_model.json.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_collect as epl  # noqa: E402

FEATURES = ("big_chances", "other_box_shots", "outside_box_shots")
HOLDOUT_FROM_SEASON = 2025  # fit on earlier seasons, test on this one and later


def features(raw: dict[str, float]) -> list[float] | None:
    """Shot kinds of one team in one match. A counter the feed does not list is zero; no shot counter = no data."""
    if "total_scoring_att" not in raw or ("attempts_ibox" not in raw and "attempts_obox" not in raw):
        return None  # no shots listed, or the feed of that era does not split shots by zone (before 2016/17)
    big = raw.get("big_chance_scored", 0.0) + raw.get("big_chance_missed", 0.0)
    inside = raw.get("attempts_ibox", 0.0)
    return [big, max(inside - big, 0.0), raw.get("attempts_obox", 0.0)]


def non_penalty_goals(raw: dict[str, float]) -> float:
    """Goals scored by the team's players without penalties (opponents' own goals are not shots)."""
    return max(raw.get("goals", 0.0) - raw.get("att_pen_goal", 0.0), 0.0)


def fit_nnls(rows: list[list[float]], targets: list[float], iterations: int = 400) -> list[float]:
    """Non-negative least squares by coordinate descent (tiny problems, no numpy needed)."""
    k = len(rows[0])
    beta = [0.0] * k
    column_squares = [sum(r[j] * r[j] for r in rows) for j in range(k)]
    residual = list(targets)
    for _ in range(iterations):
        biggest = 0.0
        for j in range(k):
            if column_squares[j] == 0:
                continue
            step = sum(r[j] * e for r, e in zip(rows, residual)) / column_squares[j]
            new = max(0.0, beta[j] + step)
            delta = new - beta[j]
            if delta:
                for i, r in enumerate(rows):
                    residual[i] -= delta * r[j]
                beta[j] = new
                biggest = max(biggest, abs(delta))
        if biggest < 1e-10:
            break
    return beta


def predict(beta: list[float], row: list[float]) -> float:
    return sum(b * x for b, x in zip(beta, row))


def pearson(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 3:
        return float("nan")
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx, vy = sum((x - mx) ** 2 for x in xs), sum((y - my) ** 2 for y in ys)
    return cov / math.sqrt(vx * vy) if vx and vy else float("nan")


def metrics(beta: list[float], rows: list[list[float]], targets: list[float]) -> dict:
    predicted = [predict(beta, r) for r in rows]
    n = len(rows)
    mean_t = sum(targets) / n
    ss_res = sum((t - p) ** 2 for t, p in zip(targets, predicted))
    ss_tot = sum((t - mean_t) ** 2 for t in targets)
    return {
        "team_matches": n, "mean_goals": round(mean_t, 4), "mean_xg": round(sum(predicted) / n, 4),
        "mae": round(sum(abs(t - p) for t, p in zip(targets, predicted)) / n, 4),
        "r2": round(1 - ss_res / ss_tot, 4) if ss_tot else None, "corr": round(pearson(predicted, targets), 4),
    }


def season_scale(beta: list[float], samples: list[dict], min_samples: int = 300) -> dict[int, float]:
    """Per-season factor so that a season's total xG equals its non-penalty goals (Opta's tagging drifts over the years).
    A season with too few matches yet (the current one) takes the previous season's factor."""
    sums: dict[int, list[float]] = {}
    for s in samples:
        entry = sums.setdefault(s["season"], [0.0, 0.0, 0.0])
        entry[0] += s["goals"]
        entry[1] += predict(beta, s["row"])
        entry[2] += 1
    scale: dict[int, float] = {}
    previous = 1.0
    for season in sorted(sums):
        goals, expected, n = sums[season]
        scale[season] = goals / expected if n >= min_samples and expected else previous
        previous = scale[season]
    return scale


def load_samples() -> list[dict]:
    """One sample per team per match that has shot statistics: season, ids, features, non-penalty goals."""
    matches = {m["id"]: m for m in json.loads((epl.NORM / "matches.json").read_text(encoding="utf-8"))}
    samples = []
    for path in sorted((epl.RAW / "pulselive" / "match-stats").glob("[0-9]*.json")):
        match = matches.get(int(path.stem))
        if not match:
            continue
        for team_id, block in (epl.load_json(path).get("data") or {}).items():
            raw = {s["name"]: s["value"] for s in block.get("M") or []}
            row = features(raw)
            team = int(team_id)
            if row is None or team not in (match["home"]["id"], match["away"]["id"]):
                continue
            samples.append({"match": match["id"], "team": team, "season": int(match["season"][:4]), "row": row, "goals": non_penalty_goals(raw)})
    return samples


def fpl_true_xg() -> dict[tuple[int, int], float]:
    """Real Opta xG per (PL match id, PL team id) for the current season: Fantasy player xG summed per team."""
    bootstrap_path = epl.RAW / "fpl" / "bootstrap-static.json"
    fixtures_path = epl.RAW / "fpl" / "fixtures.json"
    if not (bootstrap_path.exists() and fixtures_path.exists()):
        return {}
    bootstrap, fixtures = epl.load_json(bootstrap_path), epl.load_json(fixtures_path)
    pulse_team = {int(t["id"]): int(t["pulse_id"]) for t in bootstrap["teams"] if t.get("pulse_id") is not None}
    # Fantasy's own pulse_id on fixtures is empty (0), so a fixture is matched by its pair of clubs in the current season
    season = max(int(m["season"][:4]) for m in json.loads((epl.NORM / "matches.json").read_text(encoding="utf-8")))
    by_clubs = {(m["home"]["id"], m["away"]["id"]): m["id"]
                for m in json.loads((epl.NORM / "matches.json").read_text(encoding="utf-8")) if int(m["season"][:4]) == season}
    pulse_of_fixture = {}
    for f in fixtures:
        pair = (pulse_team.get(int(f["team_h"])), pulse_team.get(int(f["team_a"])))
        if pair in by_clubs:
            pulse_of_fixture[int(f["id"])] = by_clubs[pair]
    team_of_element = {int(e["id"]): int(e["team"]) for e in bootstrap["elements"]}
    totals: dict[tuple[int, int], float] = {}
    for path in (epl.RAW / "fpl" / "element-summary").glob("*.json"):
        element = int(path.stem)
        team = pulse_team.get(team_of_element.get(element, -1))
        if team is None:
            continue
        for row in epl.load_json(path).get("history") or []:
            match = pulse_of_fixture.get(int(row["fixture"]))
            if match is not None:
                key = (match, team)
                totals[key] = totals.get(key, 0.0) + float(row.get("expected_goals") or 0.0)
    return totals


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-fpl", action="store_true", help="skip the comparison with Fantasy's Opta xG")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")

    samples = load_samples()
    train = [s for s in samples if s["season"] < HOLDOUT_FROM_SEASON]
    test = [s for s in samples if s["season"] >= HOLDOUT_FROM_SEASON]
    if len(train) < 200 or len(test) < 50:
        print(f"not enough matches yet (fit {len(train)}, test {len(test)}); run `epl_collect.py teamstats` first")
        return 1
    beta_train = fit_nnls([s["row"] for s in train], [s["goals"] for s in train])
    report = {
        "generated_at": epl.now_iso(), "features": list(FEATURES), "holdout_from_season": HOLDOUT_FROM_SEASON,
        "fit_on_earlier_seasons": {"coefficients": [round(b, 4) for b in beta_train], **metrics(beta_train, [s["row"] for s in train], [s["goals"] for s in train])},
        "tested_on_later_seasons": metrics(beta_train, [s["row"] for s in test], [s["goals"] for s in test]),
    }
    # reference: one price for every shot, whatever its kind
    naive = fit_nnls([[sum(s["row"])] for s in train], [s["goals"] for s in train])
    report["naive_one_price_per_shot_on_test"] = {"coefficient": [round(naive[0], 4)], **metrics(naive, [[sum(s["row"])] for s in test], [s["goals"] for s in test])}

    beta = fit_nnls([s["row"] for s in samples], [s["goals"] for s in samples])
    report["final_model"] = {"coefficients": dict(zip(FEATURES, [round(b, 4) for b in beta])), "fitted_on_team_matches": len(samples)}
    scale = season_scale(beta, samples)
    report["season_scale"] = {str(season): round(value, 3) for season, value in sorted(scale.items())}
    proxy: dict[str, dict[str, float]] = {}
    for s in samples:
        proxy.setdefault(str(s["match"]), {})[str(s["team"])] = round(predict(beta, s["row"]) * scale[s["season"]], 3)

    if not args.no_fpl:
        pairs = [(proxy[str(m)][str(t)], v) for (m, t), v in fpl_true_xg().items() if str(m) in proxy and str(t) in proxy[str(m)]]
        if len(pairs) >= 20:
            xs, ys = [p for p, _ in pairs], [v for _, v in pairs]
            report["against_real_opta_xg_current_season"] = {
                "team_matches": len(pairs), "corr": round(pearson(xs, ys), 4), "mean_proxy": round(sum(xs) / len(xs), 3),
                "mean_real_xg": round(sum(ys) / len(ys), 3), "mae": round(sum(abs(x - y) for x, y in pairs) / len(pairs), 3),
                "note": "real xG includes penalties, the proxy does not",
            }
    epl.write_json(epl.NORM / "xg_proxy.json", proxy)
    epl.write_json(epl.NORM / "xg_model.json", report, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
