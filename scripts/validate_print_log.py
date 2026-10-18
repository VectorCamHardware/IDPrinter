#!/usr/bin/env python3
"""Validate the printed-sheets log exported from the print log backend.

Usage: python3 scripts/validate_print_log.py data/printed_sheets.csv

Also validates data/synced_sheets.csv, which uses the same columns.

Checks:
  - The header matches the expected columns, in order. A log exported before the
    source and note columns were added (13 columns) is accepted; its rows are prints.
  - Every row has a UTC timestamp, a name, a program and a three-letter prefix.
  - Prints (source "print"): print ID P-XXXXXXXX, start is 8n+1, end is a multiple
    of 8, end >= start + 7, and codes = end - start + 1.
  - Synced sheets (source "sync"): print ID S-XXXXXXXX, 1 <= start <= end, and codes
    at most end - start + 1 (the old sheets skip some numbers).
  - first_code and last_code agree with prefix, start and end.
  - Print IDs are unique.
  - Ranges for the same prefix do not overlap, except:
      - TST ranges (test mode), and
      - two synced sheets, where the later row is marked reprint TRUE (the same
        labels were found in more than one folder of the archive).

Exits with status 1 and lists every problem found, or prints a one-line summary and exits 0.
"""

import csv
import re
import sys
from collections import defaultdict

HEADERS = [
    "print_id", "timestamp_utc", "name", "program", "prefix", "start", "end",
    "first_code", "last_code", "codes", "pages", "paper", "reprint", "source", "note",
]
OLD_HEADERS = HEADERS[:13]
SOURCES = {"print", "sync"}
REPRINT_ALLOWED = {"TST"}
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
PREFIX_RE = re.compile(r"^[A-Z]{3}$")
ID_RE = {"print": re.compile(r"^P-[0-9A-F]{8}$"), "sync": re.compile(r"^S-[0-9A-F]{8}$")}


def code(prefix: str, number: int, end: int) -> str:
    return prefix + str(number).zfill(max(3, len(str(end))))


def validate(path: str) -> list[str]:
    errors: list[str] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            return ["The file is empty."]
        if header not in (HEADERS, OLD_HEADERS):
            return [f"Unexpected header: {','.join(header)}"]
        columns = header
        rows = list(reader)

    seen_ids: set[str] = set()
    ranges: dict[str, list[tuple[int, int, str, int, str, str]]] = defaultdict(list)
    counts = defaultdict(int)

    for line, row in enumerate(rows, start=2):
        if not any(cell.strip() for cell in row):
            continue
        if len(row) != len(columns):
            errors.append(f"Line {line}: expected {len(columns)} columns, found {len(row)}.")
            continue
        r = dict(zip(columns, row))
        source = r.get("source") or "print"
        if source not in SOURCES:
            errors.append(f"Line {line}: source must be print or sync.")
            continue
        counts[source] += 1

        if not ID_RE[source].match(r["print_id"]):
            errors.append(f"Line {line}: print_id {r['print_id']!r} is not in the form "
                          f"{'P' if source == 'print' else 'S'}-XXXXXXXX.")
        elif r["print_id"] in seen_ids:
            errors.append(f"Line {line}: duplicate print_id {r['print_id']}.")
        seen_ids.add(r["print_id"])

        if not TIMESTAMP_RE.match(r["timestamp_utc"]):
            errors.append(f"Line {line}: timestamp_utc is not in the form YYYY-MM-DDTHH:MM:SSZ.")
        if not r["name"].strip():
            errors.append(f"Line {line}: name is empty.")
        if not r["program"].strip():
            errors.append(f"Line {line}: program is empty.")
        if r["reprint"] not in ("TRUE", "FALSE"):
            errors.append(f"Line {line}: reprint must be TRUE or FALSE.")
        if not PREFIX_RE.match(r["prefix"]):
            errors.append(f"Line {line}: prefix must be three capital letters.")
            continue

        try:
            start, end, codes = int(r["start"]), int(r["end"]), int(r["codes"])
        except ValueError:
            errors.append(f"Line {line}: start, end and codes must be whole numbers.")
            continue

        if source == "print":
            if start < 1 or start % 8 != 1:
                errors.append(f"Line {line}: start {start} is not of the form 8n+1.")
            if end % 8 != 0 or end < start + 7:
                errors.append(f"Line {line}: end {end} is not a multiple of 8 at least start + 7.")
            if codes != end - start + 1:
                errors.append(f"Line {line}: codes is {codes}; expected {end - start + 1}.")
        else:
            if start < 1 or end < start:
                errors.append(f"Line {line}: start {start} and end {end} do not form a range.")
            if not 1 <= codes <= end - start + 1:
                errors.append(f"Line {line}: codes is {codes}; expected 1 to {end - start + 1}.")
        if r["first_code"] != code(r["prefix"], start, end):
            errors.append(f"Line {line}: first_code {r['first_code']} does not match prefix and start.")
        if r["last_code"] != code(r["prefix"], end, end):
            errors.append(f"Line {line}: last_code {r['last_code']} does not match prefix and end.")

        ranges[r["prefix"]].append((start, end, r["print_id"], line, source, r["reprint"]))

    for prefix, items in ranges.items():
        if prefix in REPRINT_ALLOWED:
            continue
        for i, (s1, e1, id1, l1, src1, _) in enumerate(items):
            for s2, e2, id2, l2, src2, rep2 in items[i + 1:]:
                if s2 > e1 or s1 > e2:
                    continue
                if src1 == "sync" and src2 == "sync" and rep2 == "TRUE":
                    continue
                errors.append(
                    f"Lines {l1} and {l2}: {prefix} ranges {s1}-{e1} ({id1}) and {s2}-{e2} ({id2}) overlap."
                )

    if not errors:
        print(f"{path}: {counts['print']} printed sheets, {counts['sync']} synced sheets, "
              f"{len(ranges)} prefixes, no problems found.")
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    errors = validate(sys.argv[1])
    for e in errors:
        print(e, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
