#!/usr/bin/env python3
"""Validate the VCID log exported from the VCID log backend.

Usage: python3 scripts/validate_vcid_log.py data/vcid_log.csv

Checks:
  - The header matches the expected columns, in order.
  - Every row has a batch ID, a UTC timestamp, a name, a prefix (VC, VT or VP), a three-letter
    manufacturer, a two-digit year, a two-digit month and a three-digit model.
  - start and end are unit numbers from 1 to 9999 and end >= start.
  - first_id, last_id and count agree with the other columns, including the Damm check digit.
  - Batch IDs are unique.
  - Batches with the same prefix, manufacturer, year, month and model do not overlap.

Exits with status 1 and lists every problem found, or prints a one-line summary and exits 0.
"""

import csv
import re
import sys
from collections import defaultdict

HEADERS = [
    "batch_id", "timestamp_utc", "name", "prefix", "manufacturer", "year", "month",
    "model", "start", "end", "first_id", "last_id", "count",
]
PREFIXES = {"VC", "VT", "VP"}
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
MANUFACTURER_RE = re.compile(r"^[A-Z]{3}$")

DAMM = [
    [0, 3, 1, 7, 5, 9, 8, 6, 4, 2], [7, 0, 9, 2, 1, 5, 4, 8, 6, 3], [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
    [1, 7, 5, 0, 9, 8, 3, 4, 2, 6], [6, 1, 2, 3, 0, 4, 5, 9, 7, 8], [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
    [5, 8, 6, 9, 7, 2, 0, 1, 3, 4], [8, 9, 4, 5, 3, 6, 2, 0, 1, 7], [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
    [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
]


def damm(digits: str) -> int:
    i = 0
    for ch in digits:
        i = DAMM[i][int(ch)]
    return i


def vcid(r: dict, unit: int) -> str:
    body = f"{r['year']}{r['month']}{r['model']}{unit:04d}"
    return f"{r['prefix']}{r['manufacturer']}{body}{damm(body)}"


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
    ranges: dict[tuple, list[tuple[int, int, str, int]]] = defaultdict(list)

    for line, row in enumerate(rows, start=2):
        if not any(cell.strip() for cell in row):
            continue
        if len(row) != len(HEADERS):
            errors.append(f"Line {line}: expected {len(HEADERS)} columns, found {len(row)}.")
            continue
        r = dict(zip(HEADERS, row))

        if not r["batch_id"]:
            errors.append(f"Line {line}: batch_id is empty.")
        elif r["batch_id"] in seen_ids:
            errors.append(f"Line {line}: duplicate batch_id {r['batch_id']}.")
        seen_ids.add(r["batch_id"])

        if not TIMESTAMP_RE.match(r["timestamp_utc"]):
            errors.append(f"Line {line}: timestamp_utc is not in the form YYYY-MM-DDTHH:MM:SSZ.")
        if not r["name"].strip():
            errors.append(f"Line {line}: name is empty.")

        key_ok = True
        if r["prefix"] not in PREFIXES:
            errors.append(f"Line {line}: prefix must be VC, VT or VP.")
            key_ok = False
        if not MANUFACTURER_RE.match(r["manufacturer"]):
            errors.append(f"Line {line}: manufacturer must be three capital letters.")
            key_ok = False
        if not re.fullmatch(r"\d{2}", r["year"]):
            errors.append(f"Line {line}: year must be two digits.")
            key_ok = False
        if not re.fullmatch(r"\d{2}", r["month"]) or not 1 <= int(r["month"]) <= 12:
            errors.append(f"Line {line}: month must be two digits from 01 to 12.")
            key_ok = False
        if not re.fullmatch(r"\d{3}", r["model"]) or r["model"] == "000":
            errors.append(f"Line {line}: model must be three digits from 001 to 999.")
            key_ok = False

        try:
            start, end, count = int(r["start"]), int(r["end"]), int(r["count"])
        except ValueError:
            errors.append(f"Line {line}: start, end and count must be whole numbers.")
            continue

        if not 1 <= start <= 9999 or not 1 <= end <= 9999 or end < start:
            errors.append(f"Line {line}: start {start} and end {end} must be from 1 to 9999 with end >= start.")
            continue
        if count != end - start + 1:
            errors.append(f"Line {line}: count is {count}; expected {end - start + 1}.")
        if not key_ok:
            continue
        if r["first_id"] != vcid(r, start):
            errors.append(f"Line {line}: first_id {r['first_id']} does not match the other columns ({vcid(r, start)}).")
        if r["last_id"] != vcid(r, end):
            errors.append(f"Line {line}: last_id {r['last_id']} does not match the other columns ({vcid(r, end)}).")

        key = (r["prefix"], r["manufacturer"], r["year"], r["month"], r["model"])
        ranges[key].append((start, end, r["batch_id"], line))

    for key, items in ranges.items():
        items.sort()
        # Compare each batch with the earlier batch that reaches furthest.
        widest = items[0]
        for item in items[1:]:
            s1, e1, id1, l1 = widest
            s2, e2, id2, l2 = item
            if s2 <= e1:
                errors.append(
                    f"Lines {l1} and {l2}: {'/'.join(key)} units {s1}-{e1} ({id1}) and {s2}-{e2} ({id2}) overlap."
                )
            if e2 > e1:
                widest = item

    if not errors:
        total = sum(len(v) for v in ranges.values())
        ids = sum(e - s + 1 for v in ranges.values() for s, e, _, _ in v)
        print(f"{path}: {total} batches, {ids} VCIDs, no problems found.")
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
