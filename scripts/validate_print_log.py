#!/usr/bin/env python3
"""Validate the printed-sheets log exported from the print log backend.

Usage: python3 scripts/validate_print_log.py data/printed_sheets.csv

Checks:
  - The header matches the expected columns, in order.
  - Every row has a print ID, a UTC timestamp, a name, a program and a three-letter prefix.
  - start is 8n+1, end is a multiple of 8, and end >= start + 7.
  - first_code, last_code and codes agree with prefix, start and end.
  - Print IDs are unique.
  - Ranges for the same prefix do not overlap, except for prefixes in REPRINT_ALLOWED.

Exits with status 1 and lists every problem found, or prints a one-line summary and exits 0.
"""

import csv
import re
import sys
from collections import defaultdict

HEADERS = [
    "print_id", "timestamp_utc", "name", "program", "prefix", "start", "end",
    "first_code", "last_code", "codes", "pages", "paper", "reprint",
]
REPRINT_ALLOWED = {"TST"}
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
PREFIX_RE = re.compile(r"^[A-Z]{3}$")


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
        if header != HEADERS:
            return [f"Unexpected header: {','.join(header)}"]
        rows = list(reader)

    seen_ids: set[str] = set()
    ranges: dict[str, list[tuple[int, int, str, int]]] = defaultdict(list)

    for line, row in enumerate(rows, start=2):
        if not any(cell.strip() for cell in row):
            continue
        if len(row) != len(HEADERS):
            errors.append(f"Line {line}: expected {len(HEADERS)} columns, found {len(row)}.")
            continue
        r = dict(zip(HEADERS, row))

        if not r["print_id"]:
            errors.append(f"Line {line}: print_id is empty.")
        elif r["print_id"] in seen_ids:
            errors.append(f"Line {line}: duplicate print_id {r['print_id']}.")
        seen_ids.add(r["print_id"])

        if not TIMESTAMP_RE.match(r["timestamp_utc"]):
            errors.append(f"Line {line}: timestamp_utc is not in the form YYYY-MM-DDTHH:MM:SSZ.")
        if not r["name"].strip():
            errors.append(f"Line {line}: name is empty.")
        if not r["program"].strip():
            errors.append(f"Line {line}: program is empty.")
        if not PREFIX_RE.match(r["prefix"]):
            errors.append(f"Line {line}: prefix must be three capital letters.")
            continue

        try:
            start, end, codes = int(r["start"]), int(r["end"]), int(r["codes"])
        except ValueError:
            errors.append(f"Line {line}: start, end and codes must be whole numbers.")
            continue

        if start < 1 or start % 8 != 1:
            errors.append(f"Line {line}: start {start} is not of the form 8n+1.")
        if end % 8 != 0 or end < start + 7:
            errors.append(f"Line {line}: end {end} is not a multiple of 8 at least start + 7.")
        if codes != end - start + 1:
            errors.append(f"Line {line}: codes is {codes}; expected {end - start + 1}.")
        if r["first_code"] != code(r["prefix"], start, end):
            errors.append(f"Line {line}: first_code {r['first_code']} does not match prefix and start.")
        if r["last_code"] != code(r["prefix"], end, end):
            errors.append(f"Line {line}: last_code {r['last_code']} does not match prefix and end.")

        ranges[r["prefix"]].append((start, end, r["print_id"], line))

    for prefix, items in ranges.items():
        if prefix in REPRINT_ALLOWED:
            continue
        items.sort()
        # Compare each range with the earlier range that reaches furthest.
        widest = items[0]
        for item in items[1:]:
            s1, e1, id1, l1 = widest
            s2, e2, id2, l2 = item
            if s2 <= e1:
                errors.append(
                    f"Lines {l1} and {l2}: {prefix} ranges {s1}-{e1} ({id1}) and {s2}-{e2} ({id2}) overlap."
                )
            if e2 > e1:
                widest = item

    if not errors:
        total = sum(len(v) for v in ranges.values())
        print(f"{path}: {total} printed sheets, {len(ranges)} prefixes, no problems found.")
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
