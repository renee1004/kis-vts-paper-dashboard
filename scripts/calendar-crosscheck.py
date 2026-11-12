#!/usr/bin/env python3
"""Holiday/session cross-check: dashboard snapshot vs exchange_calendars (Apache-2.0).

Display/research only. Does not change order gating, market-hours used for orders,
or allowRealDomesticOrder / allowRealOverseasOrder. Never reads .env or broker keys.

Writes $DATA_DIR/calendar-crosscheck.json (default ./.data).

Usage:
  .venv-data/bin/python scripts/calendar-crosscheck.py
  .venv-data/bin/python scripts/calendar-crosscheck.py --self-check
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path

MARKETS = (("DOMESTIC", "XKRX"), ("US_NASDAQ", "XNYS"))
LOOKBACK_DAYS = 30
LOOKAHEAD_DAYS = 90
SPOT_DATES = ("2026-11-09",)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR") or (Path.cwd() / ".data"))


def load_dashboard_calendar(root: Path | None = None) -> dict:
    text = (root or repo_root()).joinpath("src/lib/market-calendar-data.ts").read_text(encoding="utf8")
    start, end = text.find("{"), text.rfind("}") + 1
    if start < 0 or end <= start:
        raise ValueError("MARKET_CALENDAR JSON not found")
    return json.loads(text[start:end])


def dashboard_status(calendar: dict, market: str, ymd: str) -> str:
    if ymd < calendar["from"] or ymd > calendar["through"]:
        return "unknown"
    if ymd in calendar.get("unverifiedDates", {}).get(market, []):
        return "unknown"
    return "open" if ymd in calendar.get("markets", {}).get(market, {}) else "closed"


def format_mismatch(date_iso: str, dashboard: str, calendar_code: str, reference: str) -> str:
    return f"calendar mismatch: {date_iso} dashboard={dashboard}, {calendar_code}={reference}"


def ymd_of(day: dt.date) -> str:
    return day.strftime("%Y%m%d")


def parse_as_of(raw: str | None) -> dt.date:
    if not raw:
        return dt.date.today()
    return dt.date.fromisoformat(raw[:10])


def xcals_status(cal, day: dt.date) -> str | None:
    try:
        import pandas as pd
        return "open" if bool(cal.is_session(pd.Timestamp(day))) else "closed"
    except Exception:  # noqa: BLE001
        return None


def atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".")
    with os.fdopen(fd, "w", encoding="utf8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def compare(calendar: dict, as_of: dt.date, xcals_cals: dict) -> dict:
    start, end = as_of - dt.timedelta(days=LOOKBACK_DAYS), as_of + dt.timedelta(days=LOOKAHEAD_DAYS)
    mismatches, errors = [], []
    for _market, code in MARKETS:
        if xcals_cals.get(code) is None:
            errors.append(f"{code} reference calendar unavailable")
    day = start
    while day <= end:
        ymd, iso = ymd_of(day), day.isoformat()
        for market, code in MARKETS:
            if xcals_cals.get(code) is None:
                continue
            dash = dashboard_status(calendar, market, ymd)
            ref = xcals_status(xcals_cals.get(code), day)
            if ref is None:
                continue
            if dash != ref:
                row = {
                    "date": iso, "ymd": ymd, "market": market, "calendar": code,
                    "dashboard": dash, "reference": ref,
                    "message": format_mismatch(iso, dash, code, ref),
                }
                mismatches.append(row)
        day += dt.timedelta(days=1)
    through = calendar.get("through") or ""
    mismatches.sort(key=lambda row: (1 if row["ymd"] > through else 0, row["date"], row["market"]))
    spots = {}
    for iso in SPOT_DATES:
        day = dt.date.fromisoformat(iso)
        ymd = ymd_of(day)
        spots[iso] = {}
        for market, code in MARKETS:
            dash = dashboard_status(calendar, market, ymd)
            session = (calendar.get("markets", {}).get(market, {}) or {}).get(ymd)
            spots[iso][market] = {
                "dashboardTradingDay": dash,
                "reference": xcals_status(xcals_cals.get(code), day),
                "calendar": code,
                "session": session,
                "note": "dashboard isOpen is the current regular session clock, not the trading-day flag.",
            }
    return {
        "mismatches": mismatches,
        "spotChecks": spots,
        "window": {"from": start.isoformat(), "through": end.isoformat()},
        "errors": errors[:40],
    }


def load_xcals():
    cals, errors, version = {}, [], None
    try:
        import exchange_calendars as xcals
        import importlib.metadata
        version = importlib.metadata.version("exchange_calendars")
        for _market, code in MARKETS:
            try:
                cals[code] = xcals.get_calendar(code)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"get_calendar {code}: {type(exc).__name__}: {str(exc)[:160]}")
                cals[code] = None
    except Exception as exc:  # noqa: BLE001
        errors.append(f"import exchange_calendars: {type(exc).__name__}: {str(exc)[:160]}")
    return cals, version, errors


def main(as_of: dt.date | None = None, write: bool = True) -> dict:
    as_of = as_of or parse_as_of(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--as-of=")), None))
    calendar = load_dashboard_calendar()
    xcals_cals, xcals_version, import_errors = load_xcals()
    compared = compare(calendar, as_of, xcals_cals)
    payload = {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "displayOnly": True,
        "doesNotAffectOrders": True,
        "source": "exchange_calendars",
        "license": "Apache-2.0",
        "xcalsVersion": xcals_version,
        "dashboardCalendarVersion": calendar.get("version"),
        "dashboardFrom": calendar.get("from"),
        "dashboardThrough": calendar.get("through"),
        "asOf": as_of.isoformat(),
        "window": compared["window"],
        "mismatches": compared["mismatches"],
        "spotChecks": compared["spotChecks"],
        "errors": (import_errors + compared["errors"])[:50],
        "summary": {"mismatchCount": len(compared["mismatches"]), "window": compared["window"]},
    }
    if write:
        atomic_write(data_dir() / "calendar-crosscheck.json", payload)
    return payload


def self_check() -> int:
    calendar = load_dashboard_calendar()
    assert dashboard_status(calendar, "DOMESTIC", "20261109") == "open"
    assert dashboard_status(calendar, "DOMESTIC", "20261009") == "closed"
    assert dashboard_status(calendar, "DOMESTIC", "20261119") == "unknown"
    assert dashboard_status(calendar, "DOMESTIC", "20270104") == "unknown"
    assert format_mismatch("2026-11-19", "unknown", "XKRX", "open") == (
        "calendar mismatch: 2026-11-19 dashboard=unknown, XKRX=open"
    )
    payload = compare(calendar, dt.date(2026, 11, 11), {})
    assert payload["spotChecks"]["2026-11-09"]["DOMESTIC"]["dashboardTradingDay"] == "open"
    xcals_cals, version, errors = load_xcals()
    if xcals_cals.get("XKRX") is None:
        print(json.dumps({"ok": True, "xcals": False, "errors": errors}, ensure_ascii=False))
        return 0
    full = compare(calendar, dt.date(2026, 11, 11), xcals_cals)
    kr = full["spotChecks"]["2026-11-09"]["DOMESTIC"]
    assert kr["reference"] == "open", kr
    hangul = xcals_status(xcals_cals["XKRX"], dt.date(2026, 10, 9))
    assert hangul == "closed", hangul
    print(json.dumps({
        "ok": True, "xcals": True, "xcalsVersion": version,
        "nov9": kr, "mismatchCount": len(full["mismatches"]),
        "sample": [m["message"] for m in full["mismatches"][:5]],
    }, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        raise SystemExit(self_check())
    out = main()
    print(json.dumps({"mismatchCount": len(out["mismatches"]), "window": out["window"],
                      "nov9": out["spotChecks"].get("2026-11-09"), "errors": out["errors"][:8]},
                     ensure_ascii=False, indent=1))
