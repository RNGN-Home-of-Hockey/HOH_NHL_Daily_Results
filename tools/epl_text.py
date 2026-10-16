#!/usr/bin/env python3
"""Russian wording of the EPL cards and the Winline plates.

Club names in cases ("встреч Эвертона и Челси", "против Ливерпуля", "с Арсеналом") and in gender ("Астон Вилла не
проигрывала"), counts in whole numbers instead of betting lines ("меньше 2,5" -> "не больше 2 голов", "больше 2,5" ->
"3+ гола"), and the three short texts of a plate (headline, team, bet) sized to what fits on it.

Plate sizes were measured with the plate's own font (PF DIN Text Compressed Pro, the designer's sizes, -0.01 em):
the orange headline takes 52 characters at full size (825 px at 40 px), the team line 19 (300 px at 40 px), the bet
line 28 (300 px at 29.45 px). Up to HEADLINE_MAX / TEAM_MAX / BET_MAX the renderer shrinks the font a little; longer
text gets too small for the air, so the texts here are built to stay inside the full-size numbers where possible.
"""
from __future__ import annotations

import math
import re

HEADLINE_FULL, HEADLINE_MAX = 52, 60
TEAM_FULL, TEAM_MAX = 19, 24
BET_FULL, BET_MAX = 28, 34

# genitive, dative, instrumental of the current clubs (the rest follow the rules in `cases`)
CASES = {
    "Арсенал": ("Арсенала", "Арсеналу", "Арсеналом"),
    "Астон Вилла": ("Астон Виллы", "Астон Вилле", "Астон Виллой"),
    "Борнмут": ("Борнмута", "Борнмуту", "Борнмутом"),
    "Брайтон": ("Брайтона", "Брайтону", "Брайтоном"),
    "Брентфорд": ("Брентфорда", "Брентфорду", "Брентфордом"),
    "Ипсвич": ("Ипсвича", "Ипсвичу", "Ипсвичем"),
    "Ливерпуль": ("Ливерпуля", "Ливерпулю", "Ливерпулем"),
    "Лидс": ("Лидса", "Лидсу", "Лидсом"),
    "Ньюкасл": ("Ньюкасла", "Ньюкаслу", "Ньюкаслом"),
    "Сандерленд": ("Сандерленда", "Сандерленду", "Сандерлендом"),
    "Тоттенхэм": ("Тоттенхэма", "Тоттенхэму", "Тоттенхэмом"),
    "Фулхэм": ("Фулхэма", "Фулхэму", "Фулхэмом"),
    "Халл": ("Халла", "Халлу", "Халлом"),
    "Эвертон": ("Эвертона", "Эвертону", "Эвертоном"),
}
FEMININE = {"Астон Вилла"}
INDECLINABLE_TAILS = ("Сити", "Юнайтед", "Форест", "Пэлас", "Таун", "Альбион", "Хотспур", "Уондерерс", "Каунти")
SHORT = {"Манчестер Сити": "Ман Сити", "Манчестер Юнайтед": "Ман Юнайтед", "Ноттингем Форест": "Ноттингем"}


def cases(name: str) -> tuple[str, str, str]:
    """(genitive, dative, instrumental) of a club name; names ending in a vowel or in Сити/Юнайтед/... do not change."""
    if name in CASES:
        return CASES[name]
    words = name.split()
    head, last = " ".join(words[:-1]), words[-1] if words else ""
    if not last or last in INDECLINABLE_TAILS or last[-1] in "иоуеэюыяё":
        return name, name, name
    join = lambda stem, a, b, c: tuple(f"{head} {w}".strip() for w in (stem + a, stem + b, stem + c))  # noqa: E731
    if last.endswith(("ь", "й")):
        return join(last[:-1], "я", "ю", "ем")
    if last.endswith("а"):
        return join(last[:-1], "и" if last[-2:-1] in tuple("гкхжшчщ") else "ы", "е", "ой")
    if last[-1] in "жшчщц":
        return join(last, "а", "у", "ем")
    return join(last, "а", "у", "ом")


def gen(name: str) -> str:
    return cases(name)[0]


def dat(name: str) -> str:
    return cases(name)[1]


def ins(name: str) -> str:
    return cases(name)[2]


# past-tense verbs of the card texts: "Астон Вилла не пропускала", not "не пропускал"
VERBS = ("забивал", "пропускал", "выигрывал", "проигрывал", "побеждал", "подавал", "получал", "уступал", "открывал", "играл",
         "выиграл", "проиграл", "уходил", "бил", "создавал", "вёл", "отставал")
_VERB_RE = re.compile(r"(?<![А-Яа-яЁё])(" + "|".join(VERBS) + r")(?![А-Яа-яЁё])")


def agree(name: str, text: str) -> str:
    """The verbs of `text` in the gender of the club `name` (only a few clubs are feminine)."""
    if name not in FEMININE:
        return text
    return _VERB_RE.sub(lambda m: "вела" if m.group(1) == "вёл" else m.group(1) + "а", text)


def agree_title(title: str, names) -> str:
    """Feminine verbs after every feminine club name of the title, up to the next comma, dash or semicolon."""
    for name in names:
        if name in FEMININE and name in title:
            title = re.sub(re.escape(name) + r"[^,—;]*", lambda m, name=name: agree(name, m.group(0)), title)
    return title


# ---------- numbers and counts ----------

UNITS = {  # one, few (2-4), many (5+, also the genitive plural), genitive singular (after "не больше 1")
    "goal": ("гол", "гола", "голов", "гола"),
    "corner": ("угловой", "угловых", "угловых", "углового"),
    "card": ("карточка", "карточки", "карточек", "карточки"),
    "ball": ("мяч", "мяча", "мячей", "мяча"),
    "match": ("матч", "матча", "матчей", "матча"),
    "shot": ("удар", "удара", "ударов", "удара"),
}
NONE = {"goal": "без голов", "corner": "без угловых", "card": "без карточек", "ball": "без мячей"}
ONE_PLUS = {"goal": "хотя бы один гол", "corner": "хотя бы один угловой", "card": "хотя бы одна карточка", "ball": "хотя бы один мяч"}


def word(n: float, unit: str) -> str:
    """The noun after a number: 1 гол, 2 гола, 5 голов, 2,5 гола (a fraction takes the genitive singular)."""
    one, few, many, gen_one = UNITS[unit]
    if not float(n).is_integer():
        return gen_one
    n = abs(int(n))
    n100, n10 = n % 100, n % 10
    return one if n10 == 1 and n100 != 11 else few if 2 <= n10 <= 4 and not 12 <= n100 <= 14 else many


def count(n: int, unit: str) -> str:
    return f"{n} {word(n, unit)}"


def num(value: float, digits: int = 1) -> str:
    """8.5 -> '8,5', 12.0 -> '12', 0.534 (digits=2) -> '0,53'."""
    text = f"{value:.{digits}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text.replace(".", ",")


def line(value: float) -> str:
    return f"{value:g}".replace(".", ",")


def signed(value: float) -> str:
    return f"+{line(value)}" if value > 0 else f"-{line(abs(value))}" if value < 0 else "0"


def at_most(n: int, unit: str = "goal") -> str:
    if n <= 0:
        return NONE[unit]
    _, _, many, gen_one = UNITS[unit]
    return f"не больше {n} {gen_one if n % 10 == 1 and n % 100 != 11 else many}"


def at_least(n: int, unit: str = "goal") -> str:
    if n <= 1:
        return ONE_PLUS[unit]
    return f"{n}+ {word(n, unit)}"


def exactly(n: int, unit: str = "goal") -> str:
    return NONE[unit] if n == 0 else f"ровно {count(n, unit)}"


def between(low: int, high: int | None, unit: str = "goal") -> str:
    """A count range in words: (2, 3) -> '2–3 гола', (0, 3) -> 'не больше 3 голов', (4, None) -> '4+ гола'."""
    if high is None:
        return at_least(low, unit)
    if low == high:
        return exactly(low, unit)
    if low == 0:
        return at_most(high, unit)
    return f"{low}–{high} {word(high, unit)}"


def margin_verb(k: int) -> str:
    """A club's goal difference of at least k over its matches (a goal handicap): 'не проигрывал', 'выигрывал с разницей
    в 2+ мяча', 'не проигрывал крупнее чем в 1 мяч'."""
    if k >= 2:
        return f"выигрывал с разницей в {k}+ {word(k, 'ball')}"
    if k == 1:
        return "выигрывал"
    if k == 0:
        return "не проигрывал"
    return f"не проигрывал крупнее чем в {count(-k, 'ball')}"


def total(side: str, value: float, unit: str = "goal") -> str:
    """What an over/under line means in whole numbers (a whole line's exact hit is a refund, not a win):
    under 2,5 and under 3 -> 'не больше 2 голов', over 2,5 -> '3+ гола', over 3 -> '4+ гола'."""
    if side == "under":
        return at_most(math.ceil(value) - 1, unit)
    return at_least(math.floor(value) + 1, unit)


# ---------- two clubs' records ----------

def cap(text: str) -> str:
    return f"{text[:1].upper()}{text[1:]}"


def pooled_title(fact: str, home: str, away: str, hh: int, nh: int, ha: int, na: int) -> str:
    """A fact about the kind of match, seen in both clubs' own recent matches:
    'Ничья во втором тайме — в 5 из 8 последних матчей Эвертона и в 3 из 8 у Челси'."""
    return f"{cap(fact)} — в {hh} из {nh} последних матчей {gen(home)} и в {ha} из {na} у {gen(away)}"


def short_periods(text: str) -> str:
    return text.replace("в первом тайме", "в 1-м тайме").replace("во втором тайме", "во 2-м тайме")


def first_fit(candidates) -> str:
    """The first candidate (in the order of preference) that fits at full size, else the shortest one (the font shrinks)."""
    candidates = list(candidates)
    for candidate in candidates:
        if len(candidate) <= HEADLINE_FULL:
            return candidate
    return min(candidates, key=len)


def compact(text: str) -> str:
    """Shorter words for the plate line (the card keeps the full ones)."""
    text = short_periods(text)
    for long, short in (("хотя бы одна команда не забила", "одна из команд без гола"), ("обе команды забили", "обе забили"),
                        ("обе команды забивали", "обе забивали")):
        text = text.replace(long, short)
    return text


def pooled_headline(fact: str, home: str, away: str, hh: int, nh: int, ha: int, na: int) -> str:
    """'Ничья во 2-м тайме — 5 из 8 у Эвертона, 3 из 8 у Челси', or the clubs in the nominative, or the total of both."""
    fact = cap(compact(fact))
    per_club = (f"{fact} — {hh} из {nh} у {gen(home)}, {ha} из {na} у {gen(away)}", f"{fact}: {home} {hh} из {nh}, {away} {ha} из {na}",
                f"{fact}: {SHORT.get(home, home)} {hh} из {nh}, {SHORT.get(away, away)} {ha} из {na}")
    if any(len(text) <= HEADLINE_MAX for text in per_club):  # each club's own count reads better than the sum, even a bit smaller
        return first_fit(per_club)
    return first_fit((f"{fact} — {hh + ha} из {nh + na} их матчей", f"{fact}: {hh + ha} из {nh + na}"))


def clause(text: str) -> str:
    """A phrase with its own comma ('не меньше угловых, чем у соперника') is closed by a comma before 'в 6 из 8'."""
    return f"{text}," if "," in text else text


def sides_title(prefix: str, home: str, home_text: str, hh: int, nh: int, away: str, away_text: str, ha: int, na: int) -> str:
    """The same bet read from each club's side: 'Во втором тайме Эвертон — без поражений в 7 из 8 последних матчей,
    Челси — без побед в 6 из 8'."""
    return f"{prefix}{home} — {clause(home_text)} в {hh} из {nh} последних матчей, {away} — {clause(away_text)} в {ha} из {na}"


def sides_headline(prefix: str, home: str, home_text: str, hh: int, nh: int, away: str, away_text: str, ha: int, na: int,
                   prefer: str | None = None) -> str:
    """The plate line: both clubs if they fit, else the club the bet is on (`prefer` 'h' / 'a'), else the stronger record."""
    home_text, away_text = compact(home_text), compact(away_text)
    both = f"{prefix}{home} — {clause(home_text)} {hh} из {nh}, {away} — {clause(away_text)} {ha} из {na}"
    if len(both) <= HEADLINE_FULL:
        return both
    pick_home = prefer == "h" if prefer in ("h", "a") else hh / nh >= ha / na
    club, text, h, n = (home, home_text, hh, nh) if pick_home else (away, away_text, ha, na)
    return first_fit((f"{prefix}{club} — {clause(text)} в {h} из {n} последних матчей", f"{prefix}{club} — {clause(text)} в {h} из {n} матчей",
                      f"{prefix}{club}: {text}, {h} из {n}"))


# ---------- plates ----------

def pair(home: str, away: str) -> str:
    full = f"{home} – {away}"
    return full if len(full) <= TEAM_FULL else f"{SHORT.get(home, home)} – {SHORT.get(away, away)}"


def headline(title: str) -> str:
    """The orange line of the plate from a card's title: no brackets, then without 'последних', then the first clause."""
    text = re.sub(r"\s*\([^)]*\)", "", title).strip()
    first = re.split(r",\s(?=[А-ЯЁ])|;\s", text)[0].strip()
    short = short_periods(text)
    return first_fit((text, short, short.replace(" последних", ""), short_periods(first), short_periods(first).replace(" последних", "")))


def fits(plate: dict) -> dict:
    """How the plate's texts fit: 'ok' (full size), 'small' (the font shrinks) or 'long' (too small for the air)."""
    def level(text, full, most):
        n = len(text or "")
        return "ok" if n <= full else "small" if n <= most else "long"
    return {"headline": level(plate.get("headline"), HEADLINE_FULL, HEADLINE_MAX), "team": level(plate.get("team"), TEAM_FULL, TEAM_MAX),
            "bet": level(plate.get("bet"), BET_FULL, BET_MAX)}
