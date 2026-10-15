#!/usr/bin/env python3
"""Market-driven rules of the EPL trend engine (used by epl_engine.build_cards).

One family per kind of Winline market the basic rules do not cover: combos (result / double chance / both teams
to score with totals, half-time/full-time, winning margin, first goal and result, BTTS by halves), halves (result,
double chance, BTTS, totals, team totals, clean sheets, both halves over/under, which half a club scores more in),
goal counts, European handicap, the minute of the first goal, cards (first half, counts, who gets more, first card)
and corners (who wins them, counts, handicap). First-half corners have no data (the league feed has no corner times).

The two clubs' recent league matches are seen from the upcoming fixture ("views"): the home club's matches as they
are, the away club's mirrored. So "П1 и больше 2,5" is tested as "the home club won with over 2.5 goals" on its own
matches and "the away club lost with over 2.5" on its own. A card needs at least MIN_HITS hits, a pooled share of
at least the family's minimum, a conservative (Wilson) share not below the price's implied probability, and, when
the outcome favours one side, support from both clubs (each at least SIDE_MIN of its own matches).
"""
from __future__ import annotations

import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import epl_engine as eng  # noqa: E402
import epl_insights as ins  # noqa: E402

MIN_HITS = 4
SIDE_MIN = 0.25
STRONG_SIDE = 0.4  # below this share for either club a pooled fact cannot reach Огонь
CARDS_TAG = "карточки: правила подсчёта Winline не сверены"

RES = {"П1": "h", "Н": "d", "П2": "a", "Ничья": "d", "1X": "hd", "12": "ha", "X2": "da", "1": "h", "X": "d", "2": "a"}
SIDE_RES = {"home": "h", "draw": "d", "away": "a", "home_draw": "hd", "home_away": "ha", "draw_away": "da"}
RESULT_SETS = {"h": {"h"}, "d": {"d"}, "a": {"a"}, "hd": {"h", "d"}, "da": {"d", "a"}, "ha": {"h", "a"}}
MIRROR = {"h": "a", "a": "h", "d": "d", "hd": "da", "da": "hd", "ha": "ha"}
DIRECTIONAL = {"h", "a", "hd", "da"}

eng.RULE_META.update({
    "combo_result_total": ("Комбо", "Форма"), "combo_result_btts": ("Комбо", "Форма"), "combo_dc_total": ("Комбо", "Форма"),
    "combo_dc_btts": ("Комбо", "Форма"), "combo_btts_total": ("Комбо", "Форма"), "combo_htft": ("Комбо", "Форма"),
    "combo_margin": ("Комбо", "Форма"), "combo_first_goal": ("Комбо", "Форма"), "combo_btts_halves": ("Комбо", "Форма"),
    "half_result": ("Таймы", "Форма"), "half_double_chance": ("Таймы", "Форма"), "half_btts": ("Таймы", "Форма"),
    "half_total": ("Таймы", "Форма"), "team_half_total": ("Таймы", "Форма"), "half_clean_sheet": ("Таймы", "Форма"),
    "both_halves_total": ("Таймы", "Форма"), "team_better_half": ("Таймы", "Форма"),
    "goal_count": ("Голы", "Форма"), "team_goal_range": ("Голы", "Форма"), "team_to_score": ("Голы", "Форма"),
    "euro_handicap": ("Исход", "Форма"), "goal_interval": ("Ход матча", "Форма"),
    "cards_half_total": ("Карточки", "Форма"), "cards_count": ("Карточки", "Форма"), "team_cards_count": ("Карточки", "Форма"),
    "cards_result": ("Карточки", "Форма"), "first_card": ("Карточки", "Форма"),
    "corners_result": ("Угловые", "Форма"), "corners_count": ("Угловые", "Форма"), "team_corners_count": ("Угловые", "Форма"),
    "corners_handicap": ("Угловые", "Форма"),
})


# ----------------------------------------------------------------------------------------------------
# Helpers: names, labels, views, the gate
# ----------------------------------------------------------------------------------------------------

def number(text) -> float | None:
    try:
        return float(str(text).replace(",", "."))
    except (TypeError, ValueError):
        return None


def market_name(market: dict, event: dict) -> str:
    """Readable Winline market name: "@1P@ исход и тотал [a]" with param 1.5 -> "1-й тайм исход и тотал 1,5"."""
    text = market.get("template") or ""
    text = re.sub(r"@1(?:HT|P)@", "1-й тайм", text)
    text = re.sub(r"@2(?:HT|P)@", "2-й тайм", text).replace("@NP@", "")
    text = re.sub(r"(?<![A-Za-z0-9@])@1(?![A-Za-z0-9@])", event.get("home", "хозяева"), text)
    text = re.sub(r"(?<![A-Za-z0-9@])@2(?![A-Za-z0-9@])", event.get("away", "гости"), text)
    param = market.get("param")
    if param is not None:
        text = text.replace("[a]", str(param).replace(".", ","))
    text = re.sub(r"\(\s*\)", "", text)
    return re.sub(r"\s+", " ", text).strip()


def count_range(label: str) -> tuple[int, int | None] | None:
    """'0-3 карточки' -> (0, 3), '4 карточки' -> (4, 4), '12 карточек и более' -> (12, None), 'Нет гола' -> (0, 0)."""
    text = (label or "").strip().lower()
    if text.startswith("нет"):
        return 0, 0
    match = re.match(r"^(\d+)\s*(?:-\s*(\d+))?\s*[^\d\s]*(\s+и\s+(?:более|больше))?$", text)
    if not match:
        return None
    low = int(match.group(1))
    if match.group(3):
        return low, None
    return low, int(match.group(2)) if match.group(2) else low


def flip(pair, mirror: bool):
    return None if pair is None else ((pair[1], pair[0]) if mirror else (pair[0], pair[1]))


def side_of(value, mirror: bool):
    """'for'/'against' of a club row -> 'h'/'a' of the upcoming fixture ('none' stays)."""
    if value in (None, "none"):
        return value
    return ("a" if mirror else "h") if value == "for" else ("h" if mirror else "a")


def view(row: dict, mirror: bool) -> dict:
    return {"FT": flip((row["gf"], row["ga"]), mirror), "1H": flip(row["ht"], mirror), "2H": flip(row["h2"], mirror),
            "corners": flip(row["corners"], mirror), "cards": flip(row.get("cards_ev"), mirror), "cards_1H": flip(row.get("cards_h1"), mirror),
            "first": side_of(row["first"], mirror), "first_min": row["first_min"],
            "first_card": side_of(row.get("first_card"), mirror), "first_card_min": row.get("first_card_min"), "row": row}


def views(ctx: dict, need: str | None = None):
    """(home club views, away club views) of their recent league matches, or None when either has too few."""
    home = eng.recent_rows(ctx, ctx["home"], need=need)
    away = eng.recent_rows(ctx, ctx["away"], need=need)
    if len(home) < eng.FORM_MIN or len(away) < eng.FORM_MIN:
        return None
    return [view(r, False) for r in home], [view(r, True) for r in away]


def passes(hits: int, n: int, odds: float, min_rate: float) -> bool:
    return n > 0 and hits >= MIN_HITS and hits / n >= min_rate and ins.wilson_lower(hits, n) >= 1.0 / odds


def result_of(pair) -> str:
    return "h" if pair[0] > pair[1] else "a" if pair[0] < pair[1] else "d"


# ----------------------------------------------------------------------------------------------------
# Specs: what an outcome means, tested on a view
# ----------------------------------------------------------------------------------------------------

def test(spec: dict, v: dict) -> bool | None:
    """True/False for one match view, None when the match lacks the data the spec needs."""
    score = v.get(spec.get("on", "FT"))
    if score is None:
        return None
    h, a = score
    if "eh" in spec:  # European handicap: the away side starts `eh` goals up (negative: the home side does)
        h, a = h, a + spec["eh"]
    if spec.get("res") and result_of((h, a)) not in RESULT_SETS[spec["res"]]:
        return False
    if spec.get("margin"):
        low, high = spec["margin"]
        diff = abs(h - a)
        if diff < low or (high is not None and diff > high):
            return False
    if spec.get("total"):
        side, line = spec["total"]
        if not ((h + a > line) if side == "over" else (h + a < line)):
            return False
    if spec.get("count"):
        low, high = spec["count"]
        if h + a < low or (high is not None and h + a > high):
            return False
    if spec.get("btts") is not None and (h > 0 and a > 0) != spec["btts"]:
        return False
    if spec.get("only"):
        if (spec["only"] == "h" and not (h > 0 and a == 0)) or (spec["only"] == "a" and not (a > 0 and h == 0)):
            return False
    if spec.get("hcap"):
        side, line = spec["hcap"]
        if not ((h - a + line > 0) if side == "h" else (a - h + line > 0)):
            return False
    if spec.get("ht"):
        half = v.get("1H")
        if half is None:
            return None
        if result_of(half) not in RESULT_SETS[spec["ht"]]:
            return False
    if spec.get("first"):
        if v.get("first") is None:
            return None
        if v["first"] != spec["first"]:
            return False
    if spec.get("btts_halves"):
        first, second = v.get("1H"), v.get("2H")
        if first is None or second is None:
            return None
        if ((first[0] > 0 and first[1] > 0), (second[0] > 0 and second[1] > 0)) != spec["btts_halves"]:
            return False
    if spec.get("halves_total"):
        first, second = v.get("1H"), v.get("2H")
        if first is None or second is None:
            return None
        side, line, want = spec["halves_total"]
        both = all(((x[0] + x[1] > line) if side == "over" else (x[0] + x[1] < line)) for x in (first, second))
        if both != want:
            return False
    if spec.get("first_min"):
        low, high = spec["first_min"]
        if v.get("first") is None:
            return None
        if v["first"] == "none" or v["first_min"] is None or not (low <= v["first_min"] <= high):
            return False
    if spec.get("first_card"):
        if v.get("first_card") is None:
            return None
        if spec["first_card"] == "none":
            if v["first_card"] != "none" and not (spec.get("first_card_by") and (v["first_card_min"] or 99) > spec["first_card_by"]):
                return False
        elif v["first_card"] != spec["first_card"] or (spec.get("first_card_by") and (v["first_card_min"] or 99) > spec["first_card_by"]):
            return False
    return True


def directional(spec: dict) -> bool:  # the outcome favours one side, so each club's matches read differently
    return (spec.get("res") in DIRECTIONAL or spec.get("ht") in ("h", "a") or spec.get("first") in ("h", "a")
            or spec.get("only") in ("h", "a") or bool(spec.get("hcap")) or spec.get("first_card") in ("h", "a") or "eh" in spec)


PERIOD_PREFIX = {"1H": "Первый тайм: ", "2H": "Второй тайм: ", "cards_1H": "Первый тайм: "}
RES_VERB = {"FT": {"h": "побеждал", "d": "играл вничью", "a": "проигрывал", "hd": "не проигрывал", "da": "не побеждал", "ha": "не играл вничью"},
            "corners": {"h": "подавал больше угловых", "d": "подавал столько же угловых", "a": "подавал меньше угловых",
                        "hd": "подавал угловых не меньше соперника", "da": "подавал угловых не больше соперника", "ha": "подавал не столько же угловых"},
            "cards": {"h": "получал больше карточек", "d": "получал столько же карточек", "a": "получал меньше карточек",
                      "hd": "получал карточек не меньше соперника", "da": "получал карточек не больше соперника", "ha": "получал не столько же карточек"}}


def balls(n: int) -> str:
    return ins.count_word(n, "мяч", "мяча", "мячей")


def goal_margin_text(op: str, t: int) -> str:
    """The club's own goal difference m against t ('>' / '=' / '<') in words (European handicap)."""
    if op == "=":
        return f"побеждал ровно в {t} {balls(t)}" if t > 0 else "играл вничью" if t == 0 else f"проигрывал ровно в {-t} {balls(-t)}"
    if op == ">":
        k = t + 1  # m >= k
        return "побеждал" if k == 1 else f"побеждал в {k} {balls(k)} и больше" if k > 1 else "не проигрывал" if k == 0 else f"не проигрывал в {1 - k} {balls(1 - k)} и больше"
    k = t - 1  # m <= k
    return "проигрывал" if k == -1 else f"проигрывал в {-k} {balls(-k)} и больше" if k < -1 else "не побеждал" if k == 0 else f"не побеждал в {k + 1} {balls(k + 1)} и больше"


def corner_margin_text(op: str, t: float) -> str:
    """The club's own corner difference m against a half line t ('>' or '<') in words (corner handicap)."""
    word = lambda n: ins.count_word(n, "угловой", "угловых", "угловых")  # noqa: E731
    if op == ">":
        k = math.floor(t) + 1  # m >= k
        return (f"подавал минимум на {k} {word(k)} больше соперника" if k >= 1 else "подавал угловых не меньше соперника" if k == 0
                else f"уступал по угловым не больше чем на {-k}")
    k = math.ceil(t) - 1  # m <= k
    return (f"уступал по угловым минимум на {-k}" if k <= -1 else "подавал угловых не больше соперника" if k == 0
            else f"подавал больше соперника не больше чем на {k} {word(k)}")


def handicap_condition(spec: dict, side: str) -> tuple[str, float] | None:
    """(op, t) on the club's own difference for a European handicap or a corner handicap outcome."""
    if "eh" in spec:
        k = spec["eh"]
        op = {"h": ">", "d": "=", "a": "<"}[spec["res"]]
        if side == "a":
            op, k = {">": "<", "=": "=", "<": ">"}[op], -k
        return op, k
    if spec.get("hcap"):
        team, line = spec["hcap"]
        if (team == "h") == (side == "h"):
            return ">", -line
        return "<", line
    return None


def side_clause(spec: dict, side: str, name: str) -> str:
    """What the outcome means for one club in its own matches ('h' = the home club, 'a' = the away club, mirrored),
    as a clause with the club's name. The period goes into the title's prefix, not here."""
    mine = lambda value: value if side == "h" else MIRROR.get(value, value)  # noqa: E731
    on = spec.get("on", "FT")
    condition = handicap_condition(spec, side)
    if condition:
        op, t = condition
        return f"{name} {corner_margin_text(op, t) if spec.get('hcap') else goal_margin_text(op, int(t))}"
    if spec.get("first_card") in ("h", "a"):
        return f"{name} первым получал карточку" if spec["first_card"] == side else f"в матчах {name} первую карточку получал соперник"
    parts = []
    if spec.get("first") in ("h", "a"):
        parts.append("забивал первым" if spec["first"] == side else "пропускал первым")
    if spec.get("ht"):
        parts.append({"h": "вёл после первого тайма", "d": "уходил на перерыв при ничьей", "a": "уступал после первого тайма",
                      "hd": "не уступал после первого тайма", "da": "не вёл после первого тайма", "ha": "не уходил на перерыв при ничьей"}[mine(spec["ht"])])
    if spec.get("res"):
        kind = "corners" if on == "corners" else "cards" if on.startswith("cards") else "FT"
        verb = RES_VERB[kind][mine(spec["res"])]
        if spec.get("margin"):
            low, high = spec["margin"]
            verb += f" ровно в {low} {balls(low)}" if high == low else f" в {low} {balls(low)} и больше"
        parts.append(verb)
    if spec.get("only") in ("h", "a"):
        parts.append("забивал, не пропуская" if spec["only"] == side else "не забивал, но пропускал")
    text = " и ".join(parts) if parts else "играл"
    if spec.get("total"):
        text += f" при тотале {'больше' if spec['total'][0] == 'over' else 'меньше'} {ins.fmt_line(spec['total'][1])}"
    if spec.get("btts") is not None:
        text += " (обе команды забивали)" if spec["btts"] else " (одна из команд не забила)"
    return f"{name} {text}"


def neutral_text(spec: dict) -> str:
    """The outcome as a phrase about a match, for outcomes that do not favour one side (no period words)."""
    on = spec.get("on", "FT")
    bits = []
    if spec.get("ht") == "d" and spec.get("res") == "d":
        bits.append("ничья и в перерыве, и в итоге")
    elif spec.get("ht") == "d":
        bits.append("ничья после первого тайма")
    elif spec.get("res") == "d":
        bits.append({"corners": "равенство по угловым", "cards": "поровну карточек", "cards_1H": "поровну карточек"}.get(on, "ничья"))
    if spec.get("res") == "ha":
        bits.append("кто-то побеждал")
    if spec.get("total"):
        side, line = spec["total"]
        unit = f"{ins.fmt_line(line)} карточки" if on.startswith("cards") else ins.goals_phrase(line)
        bits.append(f"{'больше' if side == 'over' else 'меньше'} {unit}")
    if spec.get("count"):
        low, high = spec["count"]
        forms = {"corners": ("угловой", "угловых", "угловых"), "cards": ("карточка", "карточки", "карточек"),
                 "cards_1H": ("карточка", "карточки", "карточек")}.get(on, ("гол", "гола", "голов"))
        if high is None:
            bits.append(f"{low} и больше {forms[2]}")
        elif high == low:
            bits.append("без голов" if (low == 0 and forms[0] == "гол") else f"ровно {low} {ins.count_word(low, *forms)}")
        else:
            bits.append(f"{low}–{high} {forms[2]}")
    if spec.get("btts") is not None:
        bits.append("обе команды забивали" if spec["btts"] else "забивала не больше одной команды")
    if spec.get("btts_halves"):
        first, second = spec["btts_halves"]
        bits.append(f"обе забивали в первом тайме — {'да' if first else 'нет'}, во втором — {'да' if second else 'нет'}")
    if spec.get("halves_total"):
        side, line, want = spec["halves_total"]
        bits.append(f"{'' if want else 'не '}в обоих таймах {'больше' if side == 'over' else 'меньше'} {ins.goals_phrase(line)}")
    if spec.get("first_min"):
        low, high = spec["first_min"]
        bits.append(f"первый гол на {low}–{high} минуте")
    if spec.get("first") == "none":
        bits.append("без голов")
    if spec.get("first_card") == "none":
        bits.append("без карточек")
    return " и ".join(bits) or "так"


def prefix_of(spec: dict) -> str:
    return "Первый тайм: " if spec.get("first_card_by") else PERIOD_PREFIX.get(spec.get("on", "FT"), "")


def pooled_card(rule: str, event: dict, ctx: dict, market: dict, outcome: dict | None, spec: dict | None, sides, *,
                min_rate: float, weight: float = 0.5, tags=None):
    """Test `spec` on both clubs' views; a card when the history beats the price and both clubs back it."""
    if not outcome or not spec or not outcome.get("odds"):
        return None
    home_views, away_views = sides
    home_known = [x for x in (test(spec, v) for v in home_views) if x is not None]
    away_known = [x for x in (test(spec, v) for v in away_views) if x is not None]
    nh, na = len(home_known), len(away_known)
    if nh < eng.FORM_MIN or na < eng.FORM_MIN:
        return None
    hh, ha = sum(home_known), sum(away_known)
    hits, n = hh + ha, nh + na
    if not passes(hits, n, outcome["odds"], min_rate) or min(hh / nh, ha / na) < SIDE_MIN:
        return None
    names = ctx["names"]
    home, away = names[ctx["home"]], names[ctx["away"]]
    prefix = prefix_of(spec)
    if directional(spec):
        title = f"{prefix}{side_clause(spec, 'h', home)} в {hh} из {nh} последних матчей, {side_clause(spec, 'a', away)} — в {ha} из {na}"
    else:
        text = neutral_text(spec)
        text = text if prefix else f"{text[:1].upper()}{text[1:]}"
        title = f"{prefix}{text} — в {hits} из {n} последних матчей {home} и {away} ({home} {hh} из {nh}, {away} {ha} из {na})"
    rows = [v["row"] for v in home_views + away_views]
    label = f"{market_name(market, event)}: {outcome['label']}"
    card = eng.make(rule, title, market, outcome, label, hits=hits, n=n, window="последние матчи обеих команд", sample_rows=rows,
                    weight=weight, tags=[f"{hits} из {n}", *(tags or [])])
    if card and min(hh / nh, ha / na) < STRONG_SIDE and card["score"] >= eng.TIERS[0][0]:
        card = eng.finish({**card, "score": eng.TIERS[0][0] - 1})  # Огонь needs both clubs behind the fact, not one of them
    return card


def club_card(rule: str, event: dict, ctx: dict, market: dict, outcome: dict | None, club: int, rows: list[dict], predicate, title, *,
              min_rate: float, weight: float = 0.5, tags=None):
    """A fact about one club's own recent matches tied to a market about that club."""
    if not outcome or not outcome.get("odds"):
        return None
    known = [x for x in (predicate(r) for r in rows) if x is not None]
    hits, n = sum(known), len(known)
    if n < eng.FORM_MIN or not passes(hits, n, outcome["odds"], min_rate):
        return None
    label = f"{market_name(market, event)}: {outcome['label']}"
    return eng.make(rule, title(ctx["names"][club], hits, n), market, outcome, label, hits=hits, n=n, window=f"последние {n} матчей АПЛ",
                    sample_rows=rows, weight=weight, tags=[f"{hits} из {n}", *(tags or [])])


def markets_by_id(event: dict, *ids: int) -> list[dict]:
    return [m for m in event["markets"] if m["market_id"] in ids and m["outcomes"]]


def bucket_of(outcome: dict) -> tuple[int, int | None] | None:
    return (outcome["bucket"]["min"], outcome["bucket"]["max"]) if outcome.get("bucket") else count_range(outcome.get("label"))


# ----------------------------------------------------------------------------------------------------
# Combos
# ----------------------------------------------------------------------------------------------------

COMBO_RESULT_TOTAL = (1036, 992, 1012)
COMBO_RESULT_BTTS = (64, 65, 67)
COMBO_DC_TOTAL = (1026,)
COMBO_DC_BTTS = (665, 681, 682)


def combo_spec(market: dict, outcome: dict, event: dict) -> tuple[str, dict] | None:
    """(rule, spec) of a combo outcome, or None for a label this engine does not read."""
    mid, label, on = market["market_id"], (outcome.get("label") or "").strip(), market["period"]
    parts = [p.strip() for p in label.split("/")]
    line = number(market.get("param"))
    total = lambda word: ("over" if word.lower().startswith("больше") else "under", line)  # noqa: E731
    if mid in COMBO_RESULT_TOTAL + COMBO_DC_TOTAL and len(parts) == 2 and parts[0] in RES and line is not None:
        return ("combo_dc_total" if mid in COMBO_DC_TOTAL else "combo_result_total"), {"on": on, "res": RES[parts[0]], "total": total(parts[1])}
    if mid in COMBO_RESULT_BTTS + COMBO_DC_BTTS and len(parts) == 2 and parts[0] in RES and parts[1] in ("Да", "Нет"):
        return ("combo_dc_btts" if mid in COMBO_DC_BTTS else "combo_result_btts"), {"on": on, "res": RES[parts[0]], "btts": parts[1] == "Да"}
    if mid == 1040 and len(parts) == 2 and parts[0] in ("Да", "Нет") and line is not None:
        return "combo_btts_total", {"on": "FT", "btts": parts[0] == "Да", "total": total(parts[1])}
    if mid == 392 and len(parts) == 2 and parts[0] in RES and parts[1] in RES:
        return "combo_htft", {"on": "FT", "ht": RES[parts[0]], "res": RES[parts[1]]}
    if mid == 463:
        if label == "Ничья":
            return "combo_margin", {"on": "FT", "res": "d"}
        match = re.match(r"^(П1|П2) в (\d+)( и более)?$", label)
        if match:
            low = int(match.group(2))
            return "combo_margin", {"on": "FT", "res": RES[match.group(1)], "margin": (low, None if match.group(3) else low)}
    if mid == 989 and str(market.get("param")) == "1":
        if label.lower().startswith("нет гол"):
            return "combo_first_goal", {"on": "FT", "count": (0, 0)}
        if len(parts) == 2 and parts[1] in RES:
            team = "h" if parts[0] == event.get("home") else "a" if parts[0] == event.get("away") else None
            if team:
                return "combo_first_goal", {"on": "FT", "first": team, "res": RES[parts[1]]}
    if mid == 679 and len(parts) == 2 and all(p in ("Да", "Нет") for p in parts):
        return "combo_btts_halves", {"on": "FT", "btts_halves": (parts[0] == "Да", parts[1] == "Да")}
    return None


def rule_combos(event, ctx):
    full, halves, first = views(ctx), views(ctx, need="ht"), views(ctx, need="first")
    out = []
    for market in markets_by_id(event, *COMBO_RESULT_TOTAL, *COMBO_RESULT_BTTS, *COMBO_DC_TOTAL, *COMBO_DC_BTTS, 1040, 392, 463, 989, 679):
        for outcome in market["outcomes"]:
            parsed = combo_spec(market, outcome, event)
            if not parsed:
                continue
            rule, spec = parsed
            needs_halves = spec["on"] in ("1H", "2H") or spec.get("ht") or spec.get("btts_halves")
            sides = first if spec.get("first") else halves if needs_halves else full
            if sides:
                out.append(pooled_card(rule, event, ctx, market, outcome, spec, sides, min_rate=0.4))
    return out


# ----------------------------------------------------------------------------------------------------
# Halves
# ----------------------------------------------------------------------------------------------------

def european_start(market: dict) -> int | None:
    """'0:1' -> 1 (the away side starts a goal up), '2:0' -> -2."""
    match = re.match(r"^(\d+):(\d+)$", str(market.get("param") or ""))
    return int(match.group(2)) - int(match.group(1)) if match else None


def rule_halves(event, ctx):
    sides = views(ctx, need="ht")
    if not sides:
        return []
    out = []
    for market in event["markets"]:
        family, on = market["family"], market["period"]
        if on not in ("1H", "2H") or not market["outcomes"]:
            continue
        for outcome in market["outcomes"]:
            spec, rule, min_rate = None, None, 0.5
            if family == "match_result" and market.get("variant") is None and outcome.get("side") in SIDE_RES:
                spec, rule, min_rate = {"on": on, "res": SIDE_RES[outcome["side"]]}, "half_result", 0.4
            elif family == "double_chance" and outcome.get("side") in SIDE_RES:
                spec, rule = {"on": on, "res": SIDE_RES[outcome["side"]]}, "half_double_chance"
            elif family == "btts" and market["market_id"] in (1104, 957) and outcome.get("label") in ("Да", "Нет"):
                spec, rule = {"on": on, "btts": outcome["label"] == "Да"}, "half_btts"
            elif family == "total" and market["scope"] == "match" and on == "2H" and market.get("line") is not None and outcome.get("side") in ("over", "under"):
                spec, rule = {"on": on, "total": (outcome["side"], market["line"])}, "half_total"
            elif family == "goals_count" and market["scope"] == "match" and bucket_of(outcome):
                spec, rule, min_rate = {"on": on, "count": bucket_of(outcome)}, "goal_count", 0.35
            elif family == "handicap_european" and european_start(market) is not None and outcome.get("side") in SIDE_RES:
                spec, rule, min_rate = {"on": on, "eh": european_start(market), "res": SIDE_RES[outcome["side"]]}, "euro_handicap", 0.4
            if spec:
                out.append(pooled_card(rule, event, ctx, market, outcome, spec, sides, min_rate=min_rate))
    for market in markets_by_id(event, 1038, 1039):  # both halves over / under the line
        line = number(market.get("param"))
        for outcome in market["outcomes"]:
            if line is not None and outcome.get("label") in ("Да", "Нет"):
                spec = {"on": "FT", "halves_total": ("over" if market["market_id"] == 1038 else "under", line, outcome["label"] == "Да")}
                out.append(pooled_card("both_halves_total", event, ctx, market, outcome, spec, sides, min_rate=0.5))
    return out


def rule_team_halves(event, ctx):
    """Team totals by half, clean sheets by half, and which half a club scores more in."""
    out = []
    for club, _, side in eng.clubs(ctx):
        rows = eng.recent_rows(ctx, club, need="ht")
        if len(rows) < eng.FORM_MIN:
            continue
        for market in event["markets"]:
            if market["scope"] != side or not market["outcomes"]:
                continue
            on, family = market["period"], market["family"]
            key = "ht" if on == "1H" else "h2"
            where = "в первом тайме" if on == "1H" else "во втором тайме"
            if family == "total" and on in ("1H", "2H") and market.get("line") is not None and not (on == "1H" and market["line"] == 0.5):
                line = market["line"]
                for s, word in (("over", "больше"), ("under", "меньше")):
                    out.append(club_card("team_half_total", event, ctx, market, ins.outcome(market, s), club, rows,
                                         lambda r, s=s, line=line, key=key: (r[key][0] > line) if s == "over" else (r[key][0] < line),
                                         lambda n, h, t, word=word, line=line, where=where: f"{n} забивал {where} {word} {ins.goals_phrase(line)} в {h} из {t} последних матчей",
                                         min_rate=0.5))
            elif family == "clean_sheet" and on in ("1H", "2H"):
                for outcome in market["outcomes"]:
                    if outcome.get("label") in ("Да", "Нет"):
                        yes = outcome["label"] == "Да"
                        out.append(club_card("half_clean_sheet", event, ctx, market, outcome, club, rows,
                                             lambda r, yes=yes, key=key: (r[key][1] == 0) == yes,
                                             lambda n, h, t, yes=yes, where=where: f"{n} {'не пропускал' if yes else 'пропускал'} {where} в {h} из {t} последних матчей",
                                             min_rate=0.5))
            elif family == "halves" and market["market_id"] in (218, 219):
                for outcome in market["outcomes"]:
                    pick = {"В 1-ом тайме": "first", "Во 2-ом тайме": "second", "Равны": "equal"}.get((outcome.get("label") or "").strip())
                    if not pick:
                        continue
                    test_half = {"first": lambda r: r["ht"][0] > r["h2"][0], "second": lambda r: r["h2"][0] > r["ht"][0],
                                 "equal": lambda r: r["h2"][0] == r["ht"][0]}[pick]
                    text = {"first": "забивал в первом тайме больше, чем во втором", "second": "забивал во втором тайме больше, чем в первом",
                            "equal": "забивал в таймах поровну"}[pick]
                    out.append(club_card("team_better_half", event, ctx, market, outcome, club, rows, test_half,
                                         lambda n, h, t, text=text: f"{n} {text} в {h} из {t} последних матчей", min_rate=0.45))
    return out


# ----------------------------------------------------------------------------------------------------
# Goals: counts, European handicap, which team scores, the minute of the first goal, team ranges
# ----------------------------------------------------------------------------------------------------

def rule_goals(event, ctx):
    out = []
    full = views(ctx)
    if full:
        for market in event["markets"]:
            if market["period"] != "FT" or not market["outcomes"]:
                continue
            for outcome in market["outcomes"]:
                if market["family"] == "goals_count" and market["scope"] == "match" and bucket_of(outcome):
                    out.append(pooled_card("goal_count", event, ctx, market, outcome, {"on": "FT", "count": bucket_of(outcome)}, full, min_rate=0.35))
                elif market["family"] == "handicap_european" and european_start(market) is not None and outcome.get("side") in SIDE_RES:
                    spec = {"on": "FT", "eh": european_start(market), "res": SIDE_RES[outcome["side"]]}
                    out.append(pooled_card("euro_handicap", event, ctx, market, outcome, spec, full, min_rate=0.4))
        for market in markets_by_id(event, 166):
            for outcome in market["outcomes"]:
                label = (outcome.get("label") or "").strip()
                spec = ({"on": "FT", "btts": True} if label == "Обе" else {"on": "FT", "count": (0, 0)} if label.lower().startswith("нет")
                        else {"on": "FT", "only": "h"} if label == f"Только {event.get('home')}"
                        else {"on": "FT", "only": "a"} if label == f"Только {event.get('away')}" else None)
                out.append(pooled_card("team_to_score", event, ctx, market, outcome, spec, full, min_rate=0.4))
    first = views(ctx, need="first")
    if first:
        for market in [m for m in ins.find_markets(event, "goal_sequence", variant="interval") if str(m.get("param")) == "1"]:
            for outcome in market["outcomes"]:
                label = (outcome.get("label") or "").strip()
                match = re.match(r"^(\d+)-(\d+)$", label)
                spec = ({"on": "FT", "first_min": (int(match.group(1)), int(match.group(2)))} if match
                        else {"on": "FT", "first": "none"} if label.lower().startswith("нет") else None)
                out.append(pooled_card("goal_interval", event, ctx, market, outcome, spec, first, min_rate=0.3))
    for club, _, side in eng.clubs(ctx):  # a club's own goals in a range ("1-2 голов", "Нет гола")
        rows = eng.recent_rows(ctx, club)
        if len(rows) < eng.FORM_MIN:
            continue
        for market in ins.find_markets(event, "goals_count", scope=side, variant="range"):
            for outcome in market["outcomes"]:
                bounds = bucket_of(outcome)
                if not bounds:
                    continue
                low, high = bounds
                text = ("не забивал" if high == 0 else f"забивал {low}–{high} {ins.count_word(high, 'гол', 'гола', 'голов')}" if high is not None
                        else f"забивал {low} и больше голов")
                out.append(club_card("team_goal_range", event, ctx, market, outcome, club, rows,
                                     lambda r, low=low, high=high: low <= r["gf"] and (high is None or r["gf"] <= high),
                                     lambda n, h, t, text=text: f"{n} {text} в {h} из {t} последних матчей", min_rate=0.4))
    return out


# ----------------------------------------------------------------------------------------------------
# Cards (from the match pages: every card shown counts 1) and corners (full match only)
# ----------------------------------------------------------------------------------------------------

def rule_cards(event, ctx):
    sides = views(ctx, need="cards_ev")
    if not sides:
        return []
    out, tags = [], [CARDS_TAG]
    for market in [m for m in event["markets"] if m["family"] == "cards" and m["outcomes"]]:
        on = "cards_1H" if market["period"] == "1H" else "cards"
        variant, scope = market.get("variant"), market["scope"]
        for outcome in market["outcomes"]:
            label = (outcome.get("label") or "").strip()
            spec, rule = None, None
            if variant == "total" and scope == "match" and market["period"] == "1H" and outcome.get("side") in ("over", "under"):
                spec, rule = {"on": on, "total": (outcome["side"], market["line"])}, "cards_half_total"
            elif variant == "count" and scope == "match" and count_range(label):
                spec, rule = {"on": on, "count": count_range(label)}, "cards_count"
            elif variant == "result" and label in ("1", "X", "2"):
                spec, rule = {"on": on, "res": RES[label]}, "cards_result"
            elif variant == "nth" and str(market.get("param")) == "1":
                pick = {"1": "h", "2": "a"}.get(label) or ("none" if label.lower().startswith("нет") else None)
                if pick:
                    spec, rule = {"on": "cards", "first_card": pick, **({"first_card_by": 45} if market["period"] == "1H" else {})}, "first_card"
            if spec:
                out.append(pooled_card(rule, event, ctx, market, outcome, spec, sides, min_rate=0.35 if rule == "cards_count" else 0.45, tags=tags))
    for club, _, side in eng.clubs(ctx):
        rows = eng.recent_rows(ctx, club, need="cards_ev")
        if len(rows) < eng.FORM_MIN:
            continue
        for market in [m for m in event["markets"] if m["family"] == "cards" and m.get("variant") == "count" and m["scope"] == side]:
            key = "cards_h1" if market["period"] == "1H" else "cards_ev"
            where = " в первом тайме" if market["period"] == "1H" else ""
            for outcome in market["outcomes"]:
                bounds = count_range(outcome.get("label"))
                if not bounds:
                    continue
                low, high = bounds
                text = (f"получал{where} {low}–{high} карточки" if high not in (None, low) else f"получал{where} {low} и больше карточек" if high is None
                        else f"получал{where} ровно {low} {ins.count_word(low, 'карточку', 'карточки', 'карточек')}")
                out.append(club_card("team_cards_count", event, ctx, market, outcome, club, rows,
                                     lambda r, low=low, high=high, key=key: low <= r[key][0] and (high is None or r[key][0] <= high),
                                     lambda n, h, t, text=text: f"{n} {text} в {h} из {t} последних матчей", min_rate=0.35, tags=tags))
    return out


def rule_corners(event, ctx):
    sides = views(ctx, need="corners")
    if not sides:
        return []
    out = []
    for market in [m for m in event["markets"] if m["family"] == "corners" and m["period"] == "FT" and m["outcomes"]]:
        variant, scope = market.get("variant"), market["scope"]
        for outcome in market["outcomes"]:
            label = (outcome.get("label") or "").strip()
            spec, rule = None, None
            if variant == "result" and label in ("1", "X", "2"):
                spec, rule = {"on": "corners", "res": RES[label]}, "corners_result"
            elif variant == "count" and scope == "match" and count_range(label):
                spec, rule = {"on": "corners", "count": count_range(label)}, "corners_count"
            elif variant == "handicap" and outcome.get("line") is not None and outcome.get("side") in ("home", "away"):
                spec, rule = {"on": "corners", "hcap": ("h" if outcome["side"] == "home" else "a", outcome["line"])}, "corners_handicap"
            if spec:
                out.append(pooled_card(rule, event, ctx, market, outcome, spec, sides, min_rate=0.35 if rule == "corners_count" else 0.45))
    for club, _, side in eng.clubs(ctx):
        rows = eng.recent_rows(ctx, club, need="corners")
        if len(rows) < eng.FORM_MIN:
            continue
        for market in [m for m in event["markets"] if m["family"] == "corners" and m.get("variant") == "count" and m["scope"] == side and m["period"] == "FT"]:
            for outcome in market["outcomes"]:
                bounds = count_range(outcome.get("label"))
                if not bounds:
                    continue
                low, high = bounds
                text = (f"подавал {low}–{high} угловых" if high not in (None, low) else f"подавал {low} и больше угловых" if high is None
                        else f"подавал ровно {low} {ins.count_word(low, 'угловой', 'угловых', 'угловых')}")
                out.append(club_card("team_corners_count", event, ctx, market, outcome, club, rows,
                                     lambda r, low=low, high=high: low <= r["corners"][0] and (high is None or r["corners"][0] <= high),
                                     lambda n, h, t, text=text: f"{n} {text} в {h} из {t} последних матчей", min_rate=0.35))
    return out


MARKET_RULES = (rule_combos, rule_halves, rule_team_halves, rule_goals, rule_cards, rule_corners)
