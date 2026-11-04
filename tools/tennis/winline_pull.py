#!/usr/bin/env python3
"""Copy the Winline tennis line the server recorded (D1 hoh-data-core) into local tennis.sqlite.

Only SELECT reaches D1, in pages, through the local wrangler login. Repeat runs fetch what is new.
Then wta_plates.py works on the fresh prices.

    python tools/tennis/winline_pull.py
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEFAULT_DB = ROOT / "local-data" / "tennis" / "tennis.sqlite"
D1_NAME = "hoh-data-core"
PAGE = 2000
# local table -> (server table, ordering column, the rest of the stable order)
TABLES = {
    "winline_fetch": ("tennis_winline_fetch", "taken_at", "taken_at"),
    "winline_event": ("tennis_winline_event", "last_seen", "last_seen, wl_id"),
    "winline_line": ("tennis_winline_line", "taken_at", "taken_at, wl_id, market, value_key"),
}


def d1_select(sql: str) -> list[dict]:
    cmd = f'npx wrangler d1 execute {D1_NAME} --remote --json --command "{sql}"'
    done = subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, encoding="utf-8", timeout=180)
    if done.returncode != 0:
        raise RuntimeError(f"wrangler failed: {done.stdout[-400:]} {done.stderr[-400:]}")
    return json.loads(done.stdout)[0]["results"]


def store(db: sqlite3.Connection, table: str, rows: list[dict]) -> None:
    columns = [row[1] for row in db.execute(f"PRAGMA table_info({table})")]
    db.executemany(f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
                   [[row.get(c) for c in columns] for row in rows])


def pull(db: sqlite3.Connection, table: str, select=d1_select) -> int:
    server, column, order = TABLES[table]
    since = db.execute(f"SELECT COALESCE(MAX({column}), '') FROM {table}").fetchone()[0]
    copied = offset = 0
    while True:
        rows = select(f"SELECT * FROM {server} WHERE {column} > '{since}' ORDER BY {order} LIMIT {PAGE} OFFSET {offset}")
        store(db, table, rows)
        db.commit()
        copied += len(rows)
        if len(rows) < PAGE:
            return copied
        offset += PAGE


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()
    db = sqlite3.connect(args.db, timeout=60)
    db.executescript((HERE / "schema.sql").read_text(encoding="utf-8"))
    for table in ("winline_event", "winline_line", "winline_fetch"):
        print(f"{table}: {pull(db, table)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
