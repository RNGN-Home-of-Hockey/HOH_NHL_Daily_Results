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
import epl_text as T  # noqa: E402

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


PERIOD_IN = {"1H": "В первом тайме ", "2H": "Во втором тайме ", "cards_1H": "В первом тайме "}
PERIOD_SHORT = {"1H": "В 1-м тайме ", "2H": "Во 2-м тайме ", "cards_1H": "В 1-м тайме "}
PERIOD_SUFFIX = {"1H": " в первом тайме", "2H": " во втором тайме", "cards_1H": " в первом тайме"}
PERIOD_BET = {"1H": "1-й тайм: ", "2H": "2-й тайм: ", "cards_1H": "1-й тайм: "}
# an outcome in one club's own matches ("Эвертон — без поражений в 7 из 8") and as a bet on that club ("не проиграет")
RES_NOUN = {"FT": {"h": "победы", "d": "ничьи", "a": "поражения", "hd": "без поражений", "da": "без побед", "ha": "без ничьих"},
            "corners": {"h": "больше угловых, чем у соперника", "d": "поровну угловых с соперником", "a": "меньше угловых, чем у соперника",
                        "hd": "не меньше угловых, чем у соперника", "da": "не больше угловых, чем у соперника", "ha": "не поровну угловых"},
            "cards": {"h": "больше карточек, чем у соперника", "d": "поровну карточек с соперником", "a": "меньше карточек, чем у соперника",
                      "hd": "не меньше карточек, чем у соперника", "da": "не больше карточек, чем у соперника", "ha": "не поровну карточек"}}
RES_VERB = {"h": "побеждал", "d": "играл вничью", "a": "проигрывал", "hd": "не проигрывал", "da": "не побеждал", "ha": "не играл вничью"}
RES_BET = {"FT": {"h": "победит", "d": "ничья", "a": "проиграет", "hd": "не проиграет", "da": "не победит", "ha": "без ничьей"},
           "corners": {"h": "больше угловых", "d": "поровну угловых", "a": "меньше угловых", "hd": "не меньше угловых", "da": "не больше угловых",
                       "ha": "не поровну угловых"},
           "cards": {"h": "больше карточек", "d": "поровну карточек", "a": "меньше карточек", "hd": "не меньше карточек", "da": "не больше карточек",
                     "ha": "не поровну карточек"}}
HT_NOUN = {"h": "впереди после первого тайма", "d": "ничья после первого тайма", "a": "позади после первого тайма",
           "hd": "не позади после первого тайма", "da": "не впереди после первого тайма", "ha": "без ничьей к перерыву"}
HT_WORD = {"h": "победа", "d": "ничья", "a": "поражение", "hd": "не проиграет", "da": "не победит", "ha": "без ничьей"}


def period_of(spec: dict) -> str:
    return "cards_1H" if spec.get("first_card_by") else spec.get("on", "FT")


def kind_of(on: str) -> str:
    return "corners" if on == "corners" else "cards" if on.startswith("cards") else "FT"


def unit_of(on: str) -> str:
    return "corner" if on == "corners" else "card" if on.startswith("cards") else "goal"


def margin_noun(op: str, t: int) -> str:
    """The club's own goal difference m against t ('>' / '=' / '<') over its matches (European handicap)."""
    balls = lambda k: f"{k}+ {T.word(k, 'ball')}"  # noqa: E731
    if op == "=":
        return f"победы ровно в {T.count(t, 'ball')}" if t > 0 else "ничьи" if t == 0 else f"поражения ровно в {T.count(-t, 'ball')}"
    if op == ">":
        k = t + 1  # m >= k
        return f"победы в {balls(k)}" if k >= 2 else "победы" if k == 1 else "без поражений" if k == 0 else f"без поражений в {balls(1 - k)}"
    k = t - 1  # m <= k
    return f"поражения в {balls(-k)}" if k <= -2 else "поражения" if k == -1 else "без побед" if k == 0 else f"без побед в {balls(k + 1)}"


def margin_bet(op: str, t: int) -> str:
    """The same condition as a bet on the club: 'не проиграет', 'победит в 2+ мяча', 'фора +1,5'."""
    if op == "=":
        return f"победит ровно в {T.count(t, 'ball')}" if t > 0 else "ничья" if t == 0 else f"проиграет ровно в {T.count(-t, 'ball')}"
    if op == ">":
        k = t + 1
        return f"победит в {k}+ {T.word(k, 'ball')}" if k >= 2 else "победит" if k == 1 else "не проиграет" if k == 0 else f"фора +{T.line(0.5 - k)}"
    k = t - 1
    return f"проиграет в {-k}+ {T.word(-k, 'ball')}" if k <= -2 else "проиграет" if k == -1 else "не победит" if k == 0 else f"фора -{T.line(k + 0.5)}"


def corner_noun(op: str, t: float) -> str:
    """The club's own corner difference m against a half line t ('>' or '<') over its matches (corner handicap)."""
    if op == ">":
        k = math.floor(t) + 1  # m >= k
        return (f"на {k}+ угловых больше соперника" if k >= 2 else "больше угловых, чем у соперника" if k == 1
                else "не меньше угловых, чем у соперника" if k == 0 else f"отставание по угловым не больше {-k}")
    k = math.ceil(t) - 1  # m <= k
    return (f"на {-k}+ угловых меньше соперника" if k <= -2 else "меньше угловых, чем у соперника" if k == -1
            else "не больше угловых, чем у соперника" if k == 0 else f"перевес по угловым не больше {k}")


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


def favoured(spec: dict) -> str | None:
    """The side ('h' / 'a') a directional outcome is a bet on, None when it favours neither."""
    if "eh" in spec:
        res, k = spec["res"], spec["eh"]
        return "h" if res == "h" else "a" if res == "a" else ("h" if k > 0 else "a" if k < 0 else None)
    for key in ("hcap", "first_card", "first", "only"):
        value = spec.get(key)
        if isinstance(value, tuple):
            return value[0]
        if value in ("h", "a"):
            return value
    res = spec.get("res") or spec.get("ht")
    return "h" if res in ("h", "hd") else "a" if res in ("a", "da") else None


def club_view(spec: dict, side: str) -> str:
    """What the outcome means in one club's own matches ('h' = the home club, 'a' = the away club, mirrored), as a short
    phrase after the club's name: 'без поражений', 'без побед и 4+ гола', 'первым получал карточку'. No period words."""
    mine = lambda value: value if side == "h" else MIRROR.get(value, value)  # noqa: E731
    on = spec.get("on", "FT")
    condition = handicap_condition(spec, side)
    if condition:
        op, t = condition
        return corner_noun(op, t) if spec.get("hcap") else margin_noun(op, int(t))
    if spec.get("first_card") in ("h", "a"):
        return "первым получал карточку" if spec["first_card"] == side else "первую карточку получал соперник"
    parts = []
    if spec.get("first") in ("h", "a"):
        parts.append("открывал счёт" if spec["first"] == side else "пропускал первым")
    if spec.get("ht"):
        parts.append(HT_NOUN[mine(spec["ht"])])
    if spec.get("res"):
        if spec.get("first") in ("h", "a"):
            parts.append(RES_VERB[mine(spec["res"])])
        else:
            noun = RES_NOUN[kind_of(on)][mine(spec["res"])]
            if spec.get("margin"):
                low, high = spec["margin"]
                noun += f" ровно в {T.count(low, 'ball')}" if high == low else f" в {low}+ {T.word(low, 'ball')}"
            parts.append(noun)
    if spec.get("only") in ("h", "a"):
        parts.append("забивал, не пропуская" if spec["only"] == side else "пропускал, не забивая")
    if spec.get("total"):
        parts.append(T.total(*spec["total"], unit=unit_of(on)))
    if spec.get("btts") is not None:
        parts.append("обе забивали" if spec["btts"] else "хотя бы одна команда не забила")
    return " и ".join(parts) or "так"


def club_bet(spec: dict, side: str) -> str:
    """The outcome as a bet on the club `side` for the plate: 'не проиграет', '2-й тайм: не проиграет',
    'не проиграет и тотал больше 3,5', 'угловые: фора +0,5', 'забьёт первым и победит'."""
    mine = lambda value: value if side == "h" else MIRROR.get(value, value)  # noqa: E731
    on = spec.get("on", "FT")
    prefix = PERIOD_BET.get(period_of(spec), "")
    condition = handicap_condition(spec, side)
    if spec.get("hcap"):
        return f"угловые: фора {T.signed(spec['hcap'][1])}"
    if condition:
        return prefix + margin_bet(condition[0], int(condition[1]))
    if spec.get("first_card") in ("h", "a"):
        return prefix + "получит первую карточку"
    parts = []
    if spec.get("first") in ("h", "a"):
        parts.append("забьёт первым" if spec["first"] == side else "пропустит первым")
    if spec.get("ht") and spec.get("res"):
        parts.append(f"{HT_WORD[mine(spec['ht'])]} в перерыве, {HT_WORD[mine(spec['res'])]} в матче")
    elif spec.get("ht"):
        parts.append(f"1-й тайм: {RES_BET['FT'][mine(spec['ht'])]}")
    elif spec.get("res"):
        text = RES_BET[kind_of(on)][mine(spec["res"])]
        if spec.get("margin"):
            low, high = spec["margin"]
            text += f" ровно в {T.count(low, 'ball')}" if high == low else f" в {low}+ {T.word(low, 'ball')}"
        parts.append(text)
    if spec.get("only") in ("h", "a"):
        parts.append("победит всухую" if spec["only"] == side else "проиграет всухую")
    if spec.get("total"):
        side_word, value = spec["total"]
        parts.append(f"тотал {'больше' if side_word == 'over' else 'меньше'} {T.line(value)}")
    if spec.get("btts") is not None:
        parts.append("обе забьют" if spec["btts"] else "обе забьют — нет")
    return prefix + " и ".join(parts)


def match_fact(spec: dict) -> str:
    """The outcome as a fact about a match, for outcomes that favour neither side, with its period:
    'ничья во втором тайме', 'ровно 2 карточки в первом тайме', 'ничья и не больше 4 голов'."""
    on = spec.get("on", "FT")
    unit = unit_of(on)
    bits = []
    if spec.get("ht") == "d" and spec.get("res") == "d":
        bits.append("ничья и в перерыве, и в итоге")
    elif spec.get("ht") == "d":
        bits.append("ничья к перерыву")
    elif spec.get("res") == "d":
        bits.append({"corners": "поровну угловых", "cards": "поровну карточек", "cards_1H": "поровну карточек"}.get(on, "ничья"))
    if spec.get("res") == "ha":
        bits.append("без ничьей")
    if spec.get("total"):
        bits.append(T.total(*spec["total"], unit=unit))
    if spec.get("count"):
        bits.append(T.between(*spec["count"], unit=unit))
    if spec.get("btts") is not None:
        bits.append("обе команды забили" if spec["btts"] else "хотя бы одна команда не забила")
    if spec.get("btts_halves"):
        first, second = spec["btts_halves"]
        bits.append({(True, True): "обе команды забивали в каждом тайме", (True, False): "обе забивали в первом тайме, но не во втором",
                     (False, True): "обе забивали во втором тайме, но не в первом",
                     (False, False): "ни в одном тайме не забили обе"}[(first, second)])
    if spec.get("halves_total"):
        side, value, want = spec["halves_total"]
        bits.append(f"{'' if want else 'не '}в каждом тайме {T.total(side, value)}")
    if spec.get("first_min"):
        low, high = spec["first_min"]
        bits.append(f"первый гол на {low}–{high}-й минуте")
    if spec.get("first") == "none":
        bits.append("без голов")
    if spec.get("first_card") == "none":
        bits.append("без карточек")
    return " и ".join(bits) + PERIOD_SUFFIX.get(period_of(spec), "") if bits else "так"


def match_bet(spec: dict) -> str | None:
    """A bet on the match for the plate ('ничья и тотал меньше 4,5', '1-й тайм: ровно 2 карточки'); None = use the label."""
    on = spec.get("on", "FT")
    unit = unit_of(on)
    bits = []
    if spec.get("btts_halves"):
        return None
    if spec.get("ht") == "d" and spec.get("res") == "d":
        bits.append("ничья в перерыве и в матче")
    elif spec.get("ht") == "d":
        bits.append("ничья в перерыве")
    elif spec.get("res") == "d":
        bits.append({"corners": "поровну угловых", "cards": "поровну карточек", "cards_1H": "поровну карточек"}.get(on, "ничья"))
    if spec.get("res") == "ha":
        bits.append("кто-то победит")
    if spec.get("total"):
        side, value = spec["total"]
        noun = {"goal": "тотал", "corner": "угловых", "card": "карточек"}[unit]
        bits.append(f"{noun} {'больше' if side == 'over' else 'меньше'} {T.line(value)}")
    if spec.get("count"):
        bits.append(T.between(*spec["count"], unit=unit))
    if spec.get("btts") is not None:
        bits.append("обе забьют" if spec["btts"] else "обе забьют — нет")
    if spec.get("halves_total"):
        side, value, want = spec["halves_total"]
        bits.append(f"{'' if want else 'не '}в каждом тайме {T.total(side, value)}")
    if spec.get("first_min"):
        low, high = spec["first_min"]
        bits.append(f"первый гол на {low}–{high}-й минуте")
    if spec.get("first") == "none":
        bits.append("без голов")
    if spec.get("first_card") == "none":
        bits.append("без карточек")
    return PERIOD_BET.get(period_of(spec), "") + " и ".join(bits) if bits else None


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
    period = period_of(spec)
    if directional(spec):
        th, ta = T.agree(home, club_view(spec, "h")), T.agree(away, club_view(spec, "a"))
        title = T.sides_title(PERIOD_IN.get(period, ""), home, th, hh, nh, away, ta, ha, na)
        team = favoured(spec)
        plate = {"crest": {"h": "home", "a": "away"}.get(team, "match"), "bet": club_bet(spec, team) if team else match_bet(spec),
                 "headline": T.sides_headline(PERIOD_SHORT.get(period, ""), home, th, hh, nh, away, ta, ha, na, prefer=team)}
    else:
        fact = match_fact(spec)
        title = T.pooled_title(fact, home, away, hh, nh, ha, na)
        plate = {"crest": "match", "bet": match_bet(spec), "headline": T.pooled_headline(fact, home, away, hh, nh, ha, na)}
    rows = [v["row"] for v in home_views + away_views]
    label = f"{market_name(market, event)}: {outcome['label']}"
    card = eng.make(rule, title, market, outcome, label, hits=hits, n=n, window="последние матчи обеих команд", sample_rows=rows,
                    weight=weight, tags=[f"{hits} из {n}", *(tags or [])], plate=plate)
    if card and min(hh / nh, ha / na) < STRONG_SIDE and card["score"] >= eng.TIERS[0][0]:
        card = eng.finish({**card, "score": eng.TIERS[0][0] - 1})  # Огонь needs both clubs behind the fact, not one of them
    return card


def club_card(rule: str, event: dict, ctx: dict, market: dict, outcome: dict | None, club: int, rows: list[dict], predicate, title, *,
              min_rate: float, weight: float = 0.5, tags=None, bet: str | None = None, headline=None):
    """A fact about one club's own recent matches tied to a market about that club; `bet` is the plate's bet line,
    `headline(name, hits, n)` its own short plate line when the title shortened would not read well."""
    if not outcome or not outcome.get("odds"):
        return None
    known = [x for x in (predicate(r) for r in rows) if x is not None]
    hits, n = sum(known), len(known)
    if n < eng.FORM_MIN or not passes(hits, n, outcome["odds"], min_rate):
        return None
    label = f"{market_name(market, event)}: {outcome['label']}"
    name = ctx["names"][club]
    return eng.make(rule, T.agree(name, title(name, hits, n)), market, outcome, label, hits=hits, n=n, window=f"последние {n} матчей АПЛ",
                    sample_rows=rows, weight=weight, tags=[f"{hits} из {n}", *(tags or [])],
                    plate={"crest": "home" if club == ctx["home"] else "away", "bet": bet,
                           **({"headline": T.agree(name, headline(name, hits, n))} if headline else {})})


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
            half = "в 1-м тайме" if on == "1H" else "во 2-м тайме"
            if family == "total" and on in ("1H", "2H") and market.get("line") is not None and not (on == "1H" and market["line"] == 0.5):
                line = market["line"]
                for s, word in (("over", "больше"), ("under", "меньше")):
                    fact = (("забивал " if s == "over" else "не забивал ") + where) if line == 0.5 else f"забивал {where} {T.total(s, line)}"
                    bet = (("забьёт " if s == "over" else "не забьёт ") + half) if line == 0.5 else f"{PERIOD_BET[on]}инд. тотал {word} {T.line(line)}"
                    out.append(club_card("team_half_total", event, ctx, market, ins.outcome(market, s), club, rows,
                                         lambda r, s=s, line=line, key=key: (r[key][0] > line) if s == "over" else (r[key][0] < line),
                                         lambda n, h, t, fact=fact: f"{n} {fact} в {h} из {t} последних матчей", min_rate=0.5, bet=bet))
            elif family == "clean_sheet" and on in ("1H", "2H"):
                for outcome in market["outcomes"]:
                    if outcome.get("label") in ("Да", "Нет"):
                        yes = outcome["label"] == "Да"
                        out.append(club_card("half_clean_sheet", event, ctx, market, outcome, club, rows,
                                             lambda r, yes=yes, key=key: (r[key][1] == 0) == yes,
                                             lambda n, h, t, yes=yes, where=where: f"{n} {'не пропускал' if yes else 'пропускал'} {where} в {h} из {t} последних матчей",
                                             min_rate=0.5, bet=f"{PERIOD_BET[on]}{'не пропустит' if yes else 'пропустит'}"))
            elif family == "halves" and market["market_id"] in (218, 219):
                for outcome in market["outcomes"]:
                    pick = {"В 1-ом тайме": "first", "Во 2-ом тайме": "second", "Равны": "equal"}.get((outcome.get("label") or "").strip())
                    if not pick:
                        continue
                    test_half = {"first": lambda r: r["ht"][0] > r["h2"][0], "second": lambda r: r["h2"][0] > r["ht"][0],
                                 "equal": lambda r: r["h2"][0] == r["ht"][0]}[pick]
                    text = {"first": "забивал в первом тайме больше, чем во втором,", "second": "забивал во втором тайме больше, чем в первом,",
                            "equal": "забивал в таймах поровну"}[pick]
                    bet = {"first": "забьёт больше в 1-м тайме", "second": "забьёт больше во 2-м тайме", "equal": "забьёт поровну в таймах"}[pick]
                    short = {"first": "больше голов в 1-м тайме", "second": "больше голов во 2-м тайме", "equal": "поровну голов в таймах"}[pick]
                    out.append(club_card("team_better_half", event, ctx, market, outcome, club, rows, test_half,
                                         lambda n, h, t, text=text: f"{n} {text} в {h} из {t} последних матчей", min_rate=0.45, bet=bet,
                                         headline=lambda n, h, t, short=short: T.first_fit((f"{n}: {short} в {h} из {t} матчей", f"{n}: {short}, {h} из {t}"))))
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
                text = "не забивал" if high == 0 else f"забивал {T.between(low, high)}"
                bet = "не забьёт" if high == 0 else f"забьёт {T.between(low, high)}"
                out.append(club_card("team_goal_range", event, ctx, market, outcome, club, rows,
                                     lambda r, low=low, high=high: low <= r["gf"] and (high is None or r["gf"] <= high),
                                     lambda n, h, t, text=text: f"{n} {text} в {h} из {t} последних матчей", min_rate=0.4, bet=bet))
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
                text = (f"не получал карточек{where}" if high == 0 else f"получал{where} ровно одну карточку" if low == high == 1
                        else f"получал{where} {T.between(low, high, 'card')}")
                bet = ("1-й тайм: " if market["period"] == "1H" else "") + T.between(low, high, "card")
                out.append(club_card("team_cards_count", event, ctx, market, outcome, club, rows,
                                     lambda r, low=low, high=high, key=key: low <= r[key][0] and (high is None or r[key][0] <= high),
                                     lambda n, h, t, text=text: f"{n} {text} в {h} из {t} последних матчей", min_rate=0.35, tags=tags, bet=bet))
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
            elif variant == "handicap" and outcome.get("line") is not None and abs(outcome["line"]) < 1 and outcome.get("side") in ("home", "away"):
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
                text = "не подавал угловых" if high == 0 else f"подавал {T.between(low, high, 'corner')}"
                out.append(club_card("team_corners_count", event, ctx, market, outcome, club, rows,
                                     lambda r, low=low, high=high: low <= r["corners"][0] and (high is None or r["corners"][0] <= high),
                                     lambda n, h, t, text=text: f"{n} {text} в {h} из {t} последних матчей", min_rate=0.35,
                                     bet=T.between(low, high, "corner")))
    return out


MARKET_RULES = (rule_combos, rule_halves, rule_team_halves, rule_goals, rule_cards, rule_corners)
