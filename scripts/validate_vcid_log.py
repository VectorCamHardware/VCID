#!/usr/bin/env python3
"""Validate the VCID log exported from the VCID log backend.

Usage: python3 scripts/validate_vcid_log.py data/vcid_log.csv

The log has one row per device. Checks:
  - The header matches the expected columns, in order.
  - Every row has a batch ID, a UTC timestamp, a name, a prefix (VC, VT or VP), a three-letter
    manufacturer, a two-digit year, a two-digit month, a three-digit model and a four-digit unit.
  - The VCID agrees with the other columns, including the Damm check digit.
  - Each VCID appears once.
  - The rows of a batch share one timestamp, name, prefix, manufacturer, year, month and model.

Exits with status 1 and lists every problem found, or prints a one-line summary and exits 0.
"""

import csv
import re
import sys

HEADERS = [
    "vcid", "batch_id", "timestamp_utc", "name", "prefix", "manufacturer", "year", "month",
    "model", "unit",
]
PREFIXES = {"VC", "VT", "VP"}
BATCH_FIELDS = ["timestamp_utc", "name", "prefix", "manufacturer", "year", "month", "model"]
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
BATCH_RE = re.compile(r"^B-[0-9A-F]{8}$")

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


def expected_vcid(r: dict) -> str:
    body = f"{r['year']}{r['month']}{r['model']}{r['unit']}"
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

    seen: dict[str, int] = {}
    batches: dict[str, tuple[dict, int]] = {}
    count = 0

    for line, row in enumerate(rows, start=2):
        if not any(cell.strip() for cell in row):
            continue
        if len(row) != len(HEADERS):
            errors.append(f"Line {line}: expected {len(HEADERS)} columns, found {len(row)}.")
            continue
        r = dict(zip(HEADERS, row))
        count += 1

        if not BATCH_RE.match(r["batch_id"]):
            errors.append(f"Line {line}: batch_id {r['batch_id']!r} is not in the form B-XXXXXXXX.")
        if not TIMESTAMP_RE.match(r["timestamp_utc"]):
            errors.append(f"Line {line}: timestamp_utc is not in the form YYYY-MM-DDTHH:MM:SSZ.")
        if not r["name"].strip():
            errors.append(f"Line {line}: name is empty.")

        fields_ok = True
        checks = [
            (r["prefix"] in PREFIXES, "prefix must be VC, VT or VP"),
            (re.fullmatch(r"[A-Z]{3}", r["manufacturer"]), "manufacturer must be three capital letters"),
            (re.fullmatch(r"\d{2}", r["year"]), "year must be two digits"),
            (re.fullmatch(r"\d{2}", r["month"]) and 1 <= int(r["month"]) <= 12, "month must be from 01 to 12"),
            (re.fullmatch(r"\d{3}", r["model"]) and r["model"] != "000", "model must be from 001 to 999"),
            (re.fullmatch(r"\d{4}", r["unit"]) and r["unit"] != "0000", "unit must be from 0001 to 9999"),
        ]
        for ok, message in checks:
            if not ok:
                errors.append(f"Line {line}: {message}.")
                fields_ok = False

        if fields_ok and r["vcid"] != expected_vcid(r):
            errors.append(f"Line {line}: vcid {r['vcid']} does not match the other columns ({expected_vcid(r)}).")

        if r["vcid"] in seen:
            errors.append(f"Line {line}: VCID {r['vcid']} already appears on line {seen[r['vcid']]}.")
        else:
            seen[r["vcid"]] = line

        if r["batch_id"] in batches:
            first, first_line = batches[r["batch_id"]]
            for field in BATCH_FIELDS:
                if r[field] != first[field]:
                    errors.append(
                        f"Line {line}: {field} differs from line {first_line} of batch {r['batch_id']}."
                    )
        else:
            batches[r["batch_id"]] = (r, line)

    if not errors:
        print(f"{path}: {count} VCIDs in {len(batches)} batches, no problems found.")
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
