#!/usr/bin/env python3
"""Open DART (Korean FSS) fundamentals + earnings disclosures (OpenDartReader, MIT).

Display/research only. Does not place orders, does not read KIS/broker keys,
and does not change SAFE_LOCKED / VTS arm / live order flags.

Reads DART_API_KEY from the process environment, or from a DART_API_KEY= line in
the repo .env / .env.local (that line only — the rest of .env is not loaded).
Never prints, logs, or writes the key. Error text is redacted.

Writes $DATA_DIR/dart-fundamentals.json (default ./.data). Cached per KST calendar
day to respect Open DART rate limits. Stale files are not presented as fresh.

Usage:
  .venv-data/bin/python scripts/opendart-fundamentals.py
  .venv-data/bin/python scripts/opendart-fundamentals.py DOMESTIC:005930
  .venv-data/bin/python scripts/opendart-fundamentals.py --force
  .venv-data/bin/python scripts/opendart-fundamentals.py --self-check
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

REQUEST_SLEEP_SEC = 0.3
CACHE_NAME = "dart-fundamentals.json"
KST = dt.timezone(dt.timedelta(hours=9))
# Fiscal period end: annual (Dec 31) is later than that year's Q3.
REPRT = (
    ("11011", "사업보고서", 12, 31),
    ("11014", "3분기보고서", 9, 30),
    ("11012", "반기보고서", 6, 30),
    ("11013", "1분기보고서", 3, 31),
)
ETF_NAME = ("ETF", "KODEX", "TIGER", "KBSTAR", "HANARO", "ACE", "SOL", "RISE", "TIMEFOLIO")
EARNINGS_KEYS = ("잠정", "영업실적", "매출액또는손익", "연결재무제표 결정", "연결재무제표결정",
                 "분기보고서", "반기보고서", "사업보고서")
EARNINGS_SKIP = ("감사보고서", "내부회계", "지배구조", "지속가능", "주주총회", "대규모내부거래")
ACCOUNT_NAMES = {
    "revenue": ("매출액", "수익(매출액)", "영업수익"),
    "operatingIncome": ("영업이익", "영업이익(손실)"),
    "netIncome": ("당기순이익", "당기순이익(손실)", "연결당기순이익",
                  "분기순이익", "분기순이익(손실)", "반기순이익", "반기순이익(손실)"),
    "liabilities": ("부채총계",),
    "equity": ("자본총계",),
}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR") or (Path.cwd() / ".data"))


def now_kst() -> dt.datetime:
    return dt.datetime.now(KST)


def today_kst(now: dt.datetime | None = None) -> dt.date:
    return (now or now_kst()).date()


def ymd(day: dt.date) -> str:
    return day.strftime("%Y%m%d")


def parse_ymd(value: str) -> dt.date | None:
    if not value or not re.fullmatch(r"\d{8}", value):
        return None
    try:
        return dt.date(int(value[:4]), int(value[4:6]), int(value[6:8]))
    except ValueError:
        return None


def fin(value):
    try:
        if value is None or value == "":
            return None
        if isinstance(value, str):
            value = value.replace(",", "").replace("원", "").strip()
            if value in ("-", "N/A", "nan", "None"):
                return None
        number = float(value)
        return number if number == number and abs(number) != float("inf") else None
    except Exception:  # noqa: BLE001
        return None


def redact(text: str, key: str | None) -> str:
    out = str(text or "")
    out = re.sub(r"(crtfc_key|api[_-]?key|DART_API_KEY)\s*[=:]\s*[^&\s'\"\\]+",
                 r"\1=[REDACTED]", out, flags=re.I)
    if key:
        out = out.replace(key, "[REDACTED]")
    return out[:240]


def dart_api_key() -> str | None:
    env = (os.environ.get("DART_API_KEY") or "").strip()
    if env:
        return env
    for name in (".env", ".env.local"):
        path = repo_root() / name
        if not path.is_file():
            continue
        try:
            for raw in path.read_text(encoding="utf8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                left, right = line.split("=", 1)
                if left.strip() != "DART_API_KEY":
                    continue
                value = right.strip().strip("'").strip('"')
                if value:
                    return value
        except Exception:  # noqa: BLE001
            continue
    return None


def atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".")
    with os.fdopen(fd, "w", encoding="utf8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def load_json(path: Path):
    try:
        with path.open(encoding="utf8") as handle:
            return json.load(handle)
    except Exception:  # noqa: BLE001
        return None


def universe(argv: list[str] | None = None) -> list[dict]:
    args = [a for a in (argv if argv is not None else sys.argv[1:]) if not a.startswith("-")]
    if args:
        rows = []
        for item in args:
            if ":" not in item:
                continue
            market, code = item.split(":", 1)
            rows.append({"market": market, "stockCode": code, "stockName": code})
        return rows
    raw = load_json(data_dir() / "scorecard-universe.json")
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    return []


def is_etf(code: str, name: str) -> bool:
    text = f"{code} {name}".upper()
    return any(token in text for token in ETF_NAME)


def records(frame) -> list[dict]:
    if frame is None:
        return []
    if isinstance(frame, list):
        return [row for row in frame if isinstance(row, dict)]
    if hasattr(frame, "empty") and getattr(frame, "empty"):
        return []
    if hasattr(frame, "to_dict"):
        try:
            return frame.to_dict("records")
        except Exception:  # noqa: BLE001
            return []
    return []


def norm_account(name) -> str:
    return re.sub(r"\s+", "", str(name or ""))


def pick_account(rows: list[dict], names: tuple[str, ...]) -> dict | None:
    wanted = {norm_account(name) for name in names}
    cfs = [row for row in rows if str(row.get("fs_div") or "").upper() == "CFS"]
    pool = cfs or rows
    for row in pool:
        if norm_account(row.get("account_nm")) in wanted:
            return row
    for row in pool:
        acc = norm_account(row.get("account_nm"))
        if any(token in acc for token in wanted):
            return row
    return None


def yoy(current, prior) -> float | None:
    cur, prev = fin(current), fin(prior)
    if cur is None or prev is None or prev == 0:
        return None
    return (cur - prev) / abs(prev) * 100


def ratio_pct(num, den) -> float | None:
    top, bottom = fin(num), fin(den)
    if top is None or bottom is None or bottom == 0:
        return None
    return top / bottom * 100


def add_days(day: dt.date, count: int) -> dt.date:
    out = day + dt.timedelta(days=count)
    while out.weekday() >= 5:
        out += dt.timedelta(days=1)
    return out


def financials_from_rows(rows: list[dict]) -> dict:
    picked = {key: pick_account(rows, names) for key, names in ACCOUNT_NAMES.items()}
    revenue = picked["revenue"]
    operating = picked["operatingIncome"]
    net = picked["netIncome"]
    liab = picked["liabilities"]
    equity = picked["equity"]
    revenue_amt = fin((revenue or {}).get("thstrm_amount"))
    op_amt = fin((operating or {}).get("thstrm_amount"))
    ni_amt = fin((net or {}).get("thstrm_amount"))
    liab_amt = fin((liab or {}).get("thstrm_amount"))
    equity_amt = fin((equity or {}).get("thstrm_amount"))
    fs = None
    for row in (revenue, operating, net, liab, equity):
        if row and row.get("fs_div"):
            fs = str(row.get("fs_div"))
            break
    as_of = None
    for row in (revenue, operating, net):
        if not row:
            continue
        period = str(row.get("thstrm_dt") or "")
        digits = re.sub(r"\D", "", period)
        if len(digits) >= 8:
            as_of = digits[:8]
            break
    return {
        "revenue": revenue_amt,
        "operatingIncome": op_amt,
        "netIncome": ni_amt,
        "revenueYoyPct": yoy(revenue_amt, (revenue or {}).get("frmtrm_amount")),
        "operatingIncomeYoyPct": yoy(op_amt, (operating or {}).get("frmtrm_amount")),
        "netIncomeYoyPct": yoy(ni_amt, (net or {}).get("frmtrm_amount")),
        "debtRatioPct": ratio_pct(liab_amt, equity_amt),
        "roePct": ratio_pct(ni_amt, equity_amt),
        "fsDiv": fs,
        "asOf": as_of,
    }


def has_financials(row: dict) -> bool:
    keys = ("revenue", "operatingIncome", "netIncome", "revenueYoyPct",
            "operatingIncomeYoyPct", "netIncomeYoyPct", "debtRatioPct", "roePct")
    return sum(1 for key in keys if fin(row.get(key)) is not None) >= 2


def is_earnings_report(title: str) -> bool:
    name = str(title or "")
    if any(skip in name for skip in EARNINGS_SKIP):
        return False
    return any(token in name for token in EARNINGS_KEYS)


def disclosure_date(row: dict) -> str | None:
    raw = str(row.get("rcept_dt") or row.get("receiptDate") or "").replace("-", "")
    return raw if parse_ymd(raw) else None


def earnings_from_list(rows: list[dict], today: dt.date) -> dict:
    dates, recent = [], []
    for row in rows:
        title = str(row.get("report_nm") or row.get("reportName") or "")
        if not is_earnings_report(title):
            continue
        day = disclosure_date(row)
        if not day:
            continue
        if day not in dates:
            dates.append(day)
        if len(recent) < 8:
            recent.append({"date": day, "title": title[:80]})
    dates.sort()
    past = [d for d in dates if d <= ymd(today)]
    estimated = None
    if past:
        last = parse_ymd(past[-1])
        if last:
            nxt = add_days(last, 90)
            while nxt <= today:
                nxt = add_days(nxt, 90)
            estimated = ymd(nxt)
    coverage = estimated or (ymd(add_days(parse_ymd(past[-1]), 90)) if past and parse_ymd(past[-1]) else None)
    return {
        "earningsDates": dates[-8:],
        "estimatedNextDate": estimated,
        "verifiedThrough": coverage,
        "recentDisclosures": recent[:8],
    }


def report_candidates(today: dt.date) -> list[tuple[int, str, str]]:
    """Newest completed reporting period first (annual beats that year's Q3)."""
    cands = []
    for year in (today.year, today.year - 1, today.year - 2):
        for code, label, month, day in REPRT:
            end = dt.date(year, month, day)
            if end > today:
                continue
            cands.append((end, year, code, label))
    cands.sort(key=lambda row: row[0], reverse=True)
    return [(year, code, label) for _end, year, code, label in cands]


def ok_count(symbols: dict) -> int:
    return sum(1 for row in symbols.values() if row.get("ok"))


def result_payload(today: dt.date, symbols: dict, errors: list[str], key: str | None) -> dict:
    """File-level 미확인 when the API failed every symbol — not a fake 'ok' cache."""
    if errors and ok_count(symbols) == 0:
        reason = redact(errors[0], key) if errors else "DART 조회 실패"
        payload = payload_shell(today, "미확인", reason, errors, symbols)
        payload["summary"]["okCount"] = 0
        return payload
    payload = payload_shell(today, "ok", None, errors, symbols)
    payload["summary"]["okCount"] = ok_count(symbols)
    return payload


def empty_symbol(code: str, reason: str) -> dict:
    return {
        "stockCode": code, "ok": False, "reason": reason,
        "revenue": None, "operatingIncome": None, "netIncome": None,
        "revenueYoyPct": None, "operatingIncomeYoyPct": None, "netIncomeYoyPct": None,
        "debtRatioPct": None, "roePct": None, "asOf": None, "reportName": None,
        "source": "OPENDART", "earningsDates": [], "estimatedNextDate": None,
        "verifiedThrough": None, "recentDisclosures": [],
    }


def payload_shell(today: dt.date, status: str, reason: str | None, errors: list[str],
                  symbols: dict | None = None) -> dict:
    return {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "cacheDate": today.isoformat(),
        "displayOnly": True,
        "doesNotAffectOrders": True,
        "source": "opendartreader",
        "license": "MIT",
        "status": status,
        "reason": reason,
        "symbols": symbols or {},
        "errors": errors[:50],
        "summary": {
            "status": status,
            "reason": reason,
            "symbolCount": len(symbols or {}),
            "cacheDate": today.isoformat(),
        },
    }


def today_cache(today: dt.date, keys: list[str], force: bool) -> dict | None:
    if force:
        return None
    raw = load_json(data_dir() / CACHE_NAME)
    if not isinstance(raw, dict) or raw.get("cacheDate") != today.isoformat():
        return None
    if raw.get("status") != "ok":
        return None
    symbols = raw.get("symbols") if isinstance(raw.get("symbols"), dict) else {}
    if keys and not all(key in symbols for key in keys):
        return None
    return raw


class RateLimitedDart:
    def __init__(self, client, key: str, errors: list[str]):
        self.client = client
        self.key = key
        self.errors = errors
        self._last = 0.0

    def _wait(self) -> None:
        wait = REQUEST_SLEEP_SEC - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def call(self, where: str, fn, *args, **kwargs):
        self._wait()
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            self.errors.append(redact(f"{where}: {type(exc).__name__}: {exc}", self.key))
            return None


def fetch_symbol(dart: RateLimitedDart, code: str, name: str, today: dt.date) -> dict:
    if is_etf(code, name):
        return empty_symbol(code, "ETF는 DART 펀더멘털 대상이 아님")
    financial, report_name, year, reprt = None, None, None, None
    for cand_year, cand_code, cand_label in report_candidates(today):
        frame = dart.call(f"finstate {code} {cand_year} {cand_code}",
                          dart.client.finstate, code, cand_year, reprt_code=cand_code)
        rows = records(frame)
        parsed = financials_from_rows(rows) if rows else None
        if parsed and has_financials(parsed):
            financial, report_name, year, reprt = parsed, cand_label, cand_year, cand_code
            break
    start = (today - dt.timedelta(days=400)).isoformat()
    listed = records(dart.call(f"list {code}", dart.client.list, code, start=start) if hasattr(dart.client, "list") else None)
    earnings = earnings_from_list(listed, today)
    if not financial:
        row = empty_symbol(code, "DART 재무제표 없음")
        row.update(earnings)
        return row
    row = empty_symbol(code, None)
    row.update(financial)
    row.update(earnings)
    row.update({
        "ok": True, "reason": None, "reportName": report_name,
        "reportYear": year, "reprtCode": reprt, "source": "OPENDART",
    })
    return row


def opendart_client_class(imported):
    """Constructor for both OpenDartReader import shapes.

    opendartreader 0.3.3 does `sys.modules['OpenDartReader'] = dart.OpenDartReader`,
    so `import OpenDartReader` binds the class itself and `.OpenDartReader` is missing.
    Other layouts leave a module with an OpenDartReader attribute.
    """
    cls = getattr(imported, "OpenDartReader", imported)
    if not callable(cls):
        raise TypeError(f"OpenDartReader import is not callable ({type(imported).__name__})")
    return cls


def make_opendart_client(imported, key: str):
    return opendart_client_class(imported)(key)


def collect(targets: list[dict], today: dt.date, key: str) -> tuple[dict, list[str]]:
    errors: list[str] = []
    try:
        import OpenDartReader  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return {}, [redact(f"import OpenDartReader: {type(exc).__name__}: {exc}", key)]
    try:
        client = make_opendart_client(OpenDartReader, key)
    except Exception as exc:  # noqa: BLE001
        return {}, [redact(f"OpenDartReader(): {type(exc).__name__}: {exc}", key)]
    dart = RateLimitedDart(client, key, errors)
    symbols = {}
    for target in targets:
        market, code = target.get("market"), str(target.get("stockCode") or "")
        if market != "DOMESTIC" or not re.fullmatch(r"\d{6}", code):
            continue
        name = str(target.get("stockName") or code)
        symbols[f"DOMESTIC:{code}"] = fetch_symbol(dart, code, name, today)
    return symbols, errors


def main(argv: list[str] | None = None, write: bool = True) -> dict:
    argv = argv if argv is not None else sys.argv[1:]
    force = "--force" in argv
    today = today_kst()
    key = dart_api_key()
    targets = universe(argv)
    keys = [f"DOMESTIC:{row['stockCode']}" for row in targets
            if row.get("market") == "DOMESTIC" and re.fullmatch(r"\d{6}", str(row.get("stockCode") or ""))]
    cached = today_cache(today, keys, force)
    if cached:
        cached = dict(cached)
        cached["summary"] = {
            "status": cached.get("status") or "ok",
            "reason": "today-cache",
            "symbolCount": len(cached.get("symbols") or {}),
            "cacheDate": today.isoformat(),
        }
        return cached
    if not key:
        payload = payload_shell(today, "미확인", "DART_API_KEY 없음", [])
        if write:
            atomic_write(data_dir() / CACHE_NAME, payload)
        return payload
    if not keys:
        payload = payload_shell(today, "ok", "국내 관심종목 없음", [])
        if write:
            atomic_write(data_dir() / CACHE_NAME, payload)
        return payload
    symbols, errors = collect(targets, today, key)
    payload = result_payload(today, symbols, errors, key)
    if write:
        atomic_write(data_dir() / CACHE_NAME, payload)
    return payload


def self_check() -> int:
    key = "super-secret-dart-key"
    assert "[REDACTED]" in redact(f"crtfc_key={key} boom", key)
    assert key not in redact(f"failed {key}", key)
    rows = [
        {"account_nm": "매출액", "fs_div": "CFS", "thstrm_amount": "120", "frmtrm_amount": "100", "thstrm_dt": "2025.12.31"},
        {"account_nm": "영업이익", "fs_div": "CFS", "thstrm_amount": "30", "frmtrm_amount": "20"},
        {"account_nm": "당기순이익", "fs_div": "CFS", "thstrm_amount": "18", "frmtrm_amount": "12"},
        {"account_nm": "부채총계", "fs_div": "CFS", "thstrm_amount": "40"},
        {"account_nm": "자본총계", "fs_div": "CFS", "thstrm_amount": "80"},
        {"account_nm": "매출액", "fs_div": "OFS", "thstrm_amount": "1", "frmtrm_amount": "1"},
    ]
    parsed = financials_from_rows(rows)
    assert parsed["revenue"] == 120
    assert abs(parsed["revenueYoyPct"] - 20) < 1e-9
    assert abs(parsed["operatingIncomeYoyPct"] - 50) < 1e-9
    assert abs(parsed["debtRatioPct"] - 50) < 1e-9
    assert abs(parsed["roePct"] - 22.5) < 1e-9
    assert parsed["fsDiv"] == "CFS"
    assert has_financials(parsed)
    listed = [
        {"report_nm": "분기보고서", "rcept_dt": "20260515"},
        {"report_nm": "[기재정정]연결재무제표 기준 영업(잠정)실적(공정공시)", "rcept_dt": "20260730"},
        {"report_nm": "감사보고서", "rcept_dt": "20260331"},
        {"report_nm": "사업보고서", "rcept_dt": "20260312"},
    ]
    earn = earnings_from_list(listed, dt.date(2026, 11, 12))
    assert "20260730" in earn["earningsDates"]
    assert "20260331" not in earn["earningsDates"]
    assert earn["estimatedNextDate"] == "20270126"
    assert is_etf("069500", "KODEX 200")
    assert not is_etf("005930", "삼성전자")
    missing = empty_symbol("005930", "DART_API_KEY 없음")
    assert missing["ok"] is False and missing["revenue"] is None
    april = report_candidates(dt.date(2026, 4, 10))
    assert april[0] == (2026, "11013", "1분기보고서")
    assert april[1] == (2025, "11011", "사업보고서")
    q3 = next(i for i, row in enumerate(april) if row[0] == 2025 and row[1] == "11014")
    annual = next(i for i, row in enumerate(april) if row[0] == 2025 and row[1] == "11011")
    assert annual < q3
    nov = report_candidates(dt.date(2026, 11, 12))
    assert nov[0] == (2026, "11014", "3분기보고서")
    failed = result_payload(dt.date(2026, 11, 12), {"DOMESTIC:005930": empty_symbol("005930", "DART 재무제표 없음")},
                            ["finstate 005930: HTTPError: 401 crtfc_key=super-secret-dart-key"], key)
    assert failed["status"] == "미확인"
    assert "REDACTED" in failed["reason"]
    assert key not in failed["reason"]
    assert failed["symbols"]["DOMESTIC:005930"]["ok"] is False
    mixed = result_payload(dt.date(2026, 11, 12), {"DOMESTIC:005930": {**empty_symbol("005930", None), "ok": True}},
                           ["finstate 000660: Timeout"], key)
    assert mixed["status"] == "ok"

    class OpenDartReader:  # 0.3.3: import binds the class; nested .OpenDartReader is absent
        def __init__(self, api_key):
            self.api_key = api_key

    try:
        OpenDartReader.OpenDartReader(key)  # type: ignore[attr-defined]
        raise AssertionError("0.3.3 class import must not expose nested OpenDartReader")
    except AttributeError:
        pass
    class_client = make_opendart_client(OpenDartReader, key)
    assert class_client.api_key == key
    assert key not in repr(opendart_client_class(OpenDartReader))

    class _ModuleShape:
        pass

    module_shape = _ModuleShape()
    module_shape.OpenDartReader = OpenDartReader
    module_client = make_opendart_client(module_shape, key)
    assert isinstance(module_client, OpenDartReader)
    assert module_client.api_key == key
    assert opendart_client_class(module_shape) is OpenDartReader

    installed_shape = None
    try:
        import OpenDartReader as _installed  # type: ignore
    except Exception:  # noqa: BLE001
        _installed = None
    if _installed is not None:
        real_cls = opendart_client_class(_installed)
        assert callable(real_cls)
        installed_shape = "class" if isinstance(_installed, type) else "module"

    print(json.dumps({"ok": True, "revenueYoyPct": parsed["revenueYoyPct"],
                      "estimatedNextDate": earn["estimatedNextDate"],
                      "aprilFirst": april[0], "novFirst": nov[0],
                      "clientShapes": ["class", "module"],
                      "installedShape": installed_shape}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        raise SystemExit(self_check())
    out = main()
    print(json.dumps(out.get("summary") or {"status": "미확인"}, ensure_ascii=False, indent=1))
