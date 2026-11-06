#!/usr/bin/env python3
"""Scorecard data collector (research data only; never places orders, never reads .env).

Writes $DATA_DIR/scorecard-data.json (default ./.data) consumed by src/lib/scorecard-data.ts.
 - FinanceDataReader: daily bars (for 20/60/200-day MA, 52-week high/low), macro (USD/KRW, US10Y, VIX)
 - pykrx: foreign/institution net buying (5 trading days), PER/PBR, market cap (KRX stocks only)
Anything that fails is written as null so the TS side scores it as 'unknown' (never 0).

Usage: .venv-data/bin/python scripts/scorecard-collect.py [DOMESTIC:005930 US_NASDAQ:AAPL ...]
Without args, reads $DATA_DIR/scorecard-universe.json written by the dashboard agent.
"""
import datetime as dt, json, os, sys, tempfile, traceback

root = os.environ.get("DATA_DIR") or os.path.join(os.getcwd(), ".data")
errors = []
def note(where, exc):
    errors.append(f"{where}: {type(exc).__name__}: {str(exc)[:160]}")

try:
    import FinanceDataReader as fdr
except Exception as e:  # noqa: BLE001
    fdr = None; note("import FinanceDataReader", e)
try:
    import io, contextlib
    with contextlib.redirect_stdout(io.StringIO()):
        from pykrx import stock as krx
except Exception as e:  # noqa: BLE001
    krx = None; note("import pykrx", e)

def universe():
    if len(sys.argv) > 1:
        return [dict(zip(("market", "stockCode"), a.split(":", 1))) for a in sys.argv[1:]]
    try:
        with open(os.path.join(root, "scorecard-universe.json"), encoding="utf8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        note("universe", e); return []

today = dt.date.today()
start = (today - dt.timedelta(days=420)).isoformat()
ymd = lambda d: d.strftime("%Y%m%d")

def fin(v):
    try:
        v = float(v)
        return v if v == v and abs(v) != float("inf") else None
    except Exception:  # noqa: BLE001
        return None

def bars_for(code):
    if not fdr: return []
    df = fdr.DataReader(code, start)
    df = df[df.index.date < today]  # completed bars only
    out = []
    for idx, row in df.tail(300).iterrows():
        c = fin(row.get("Close")); lo = fin(row.get("Low"))
        if c and c > 0:
            b = {"date": idx.strftime("%Y%m%d"), "close": c}
            if lo and lo > 0: b["low"] = lo
            out.append(b)
    return out

def krx_data(code):
    if not krx: return None, None
    end = ymd(today - dt.timedelta(days=1)); begin = ymd(today - dt.timedelta(days=21))
    fundamentals = flows = None
    try:
        f = krx.get_market_fundamental(begin, end, code); c = krx.get_market_cap(begin, end, code)
        if len(f) and len(c):
            fundamentals = {"per": fin(f["PER"].iloc[-1]), "pbr": fin(f["PBR"].iloc[-1]),
                            "marketCapKrw": fin(c["시가총액"].iloc[-1]), "asOf": f.index[-1].strftime("%Y%m%d")}
            if fundamentals["per"] == 0: fundamentals["per"] = None  # pykrx uses 0 for N/A
            if fundamentals["pbr"] == 0: fundamentals["pbr"] = None
    except Exception as e:  # noqa: BLE001
        note(f"fundamentals {code}", e)
    try:
        t = krx.get_market_trading_value_by_date(begin, end, code).tail(5)
        if len(t):
            inst = "기관합계" if "기관합계" in t.columns else None
            frg = "외국인합계" if "외국인합계" in t.columns else ("외국인" if "외국인" in t.columns else None)
            if inst and frg:
                flows = {"foreignNetKrw": fin(t[frg].sum()), "institutionNetKrw": fin(t[inst].sum()),
                         "days": int(len(t)), "asOf": t.index[-1].strftime("%Y%m%d")}
    except Exception as e:  # noqa: BLE001
        note(f"flows {code}", e)
    return fundamentals, flows

def series(candidates):
    for sym in candidates:
        try:
            df = fdr.DataReader(sym, (today - dt.timedelta(days=60)).isoformat())
            s = df["Close"].dropna()
            if len(s) >= 21: return s
        except Exception as e:  # noqa: BLE001
            note(f"macro {sym}", e)
    return None

def macro():
    if not fdr: return None
    vix, fx, ust = series(["VIX", "^VIX"]), series(["USD/KRW"]), series(["US10YT", "^TNX"])
    return {"vix": fin(vix.iloc[-1]) if vix is not None else None,
            "usdKrwChange20dPct": fin((fx.iloc[-1] / fx.iloc[-21] - 1) * 100) if fx is not None else None,
            "us10yChange20dBp": fin((ust.iloc[-1] - ust.iloc[-21]) * 100) if ust is not None else None,
            "asOf": today.isoformat()}

symbols = {}
for t in universe():
    market, code = t.get("market"), t.get("stockCode")
    if market not in ("DOMESTIC", "US_NASDAQ") or not code: continue
    row = {"bars": [], "fundamentals": None, "flows": None}
    try: row["bars"] = bars_for(code)
    except Exception as e: note(f"bars {code}", e)  # noqa: BLE001
    if market == "DOMESTIC":
        row["fundamentals"], row["flows"] = krx_data(code)
    symbols[f"{market}:{code}"] = row

try: m = macro()
except Exception as e: m = None; note("macro", e)  # noqa: BLE001

out = {"version": 1, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
       "symbols": symbols, "macro": m, "errors": errors[:50]}
os.makedirs(root, mode=0o700, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=root, prefix=".scorecard-data.")
with os.fdopen(fd, "w", encoding="utf8") as f: json.dump(out, f, ensure_ascii=False)
os.replace(tmp, os.path.join(root, "scorecard-data.json"))
summary = {k: {"bars": len(v["bars"]), "fundamentals": v["fundamentals"] is not None, "flows": v["flows"] is not None} for k, v in symbols.items()}
print(json.dumps({"symbols": summary, "macro": m, "errors": errors[:10]}, ensure_ascii=False, indent=1))
