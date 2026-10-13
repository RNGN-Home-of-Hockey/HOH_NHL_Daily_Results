#!/usr/bin/env python3
"""Checks for tools/epl_xg.py on synthetic data (no network)."""
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import epl_xg as xg  # noqa: E402


def test_features_treat_missing_counters_as_zero():
    assert xg.features({"goals": 1}) is None  # no shot counter at all: no data, not zero shots
    assert xg.features({"total_scoring_att": 9}) is None  # shots without the zone split (old seasons): not usable
    assert xg.features({"total_scoring_att": 9, "attempts_ibox": 6, "attempts_obox": 3}) == [0.0, 6.0, 3.0]
    row = xg.features({"total_scoring_att": 9, "attempts_ibox": 6, "attempts_obox": 3, "big_chance_scored": 1, "big_chance_missed": 2})
    assert row == [3.0, 3.0, 3.0]  # big chances come out of the shots inside the box
    assert xg.features({"total_scoring_att": 1, "attempts_ibox": 1, "big_chance_missed": 3})[1] == 0.0  # never negative


def test_non_penalty_goals():
    assert xg.non_penalty_goals({"goals": 3, "att_pen_goal": 1}) == 2.0
    assert xg.non_penalty_goals({}) == 0.0  # an unlisted counter is zero, not the scoreboard
    assert xg.non_penalty_goals({"att_pen_goal": 1}) == 0.0


def test_fit_recovers_prices_and_clamps_negatives():
    rng = random.Random(7)
    rows = [[rng.randint(0, 3), rng.randint(0, 8), rng.randint(0, 8)] for _ in range(400)]
    targets = [0.4 * a + 0.05 * b + 0.03 * c for a, b, c in rows]
    beta = xg.fit_nnls([[float(v) for v in r] for r in rows], targets)
    assert all(abs(b - t) < 1e-3 for b, t in zip(beta, (0.4, 0.05, 0.03)))
    wrong_way = xg.fit_nnls([[float(v)] for v in range(1, 30)], [-0.5 * v for v in range(1, 30)])
    assert wrong_way[0] == 0.0  # the best price would be negative; a shot cannot be worth less than nothing


def test_metrics_and_pearson():
    assert abs(xg.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1.0) < 1e-9
    result = xg.metrics([1.0], [[1.0], [2.0], [3.0]], [1.0, 2.0, 3.0])
    assert result["mae"] == 0.0 and result["r2"] == 1.0 and result["team_matches"] == 3


def test_season_scale_aligns_totals_and_borrows_for_a_partial_season():
    full = [{"season": 2024, "row": [1.0], "goals": 1.0}] * 400 + [{"season": 2025, "row": [1.0], "goals": 2.0}] * 400
    partial = [{"season": 2026, "row": [1.0], "goals": 9.0}] * 10
    scale = xg.season_scale([1.0], full + partial)
    assert scale[2024] == 1.0 and scale[2025] == 2.0
    assert scale[2026] == 2.0  # too few matches yet: the previous season's factor


def main() -> None:
    for name, function in sorted(globals().items()):
        if name.startswith("test_") and callable(function):
            function()
            print(f"ok  {name}")


if __name__ == "__main__":
    main()
