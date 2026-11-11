#!/usr/bin/env python3
"""Scorecard data collector (research data only; never places orders, never reads .env).

Writes $DATA_DIR/scorecard-data.json (default ./.data) consumed by src/lib/scorecard-data.ts,
and auto earnings dates into data/event-calendar.json (manual entries are never overwritten).
Source priority (each value records its source):
 KR valuation/flows: [KIS Open API, fetched by the app at runtime] > Naver mobile JSON (cached 6h, 1 req/s) > pykrx (needs KRX login)
 US valuation: yfinance (trailingPE, priceToBook, marketCap). US flows: not collected (no honest free proxy) -> unknown.
 KR/US PSR (reference-only, not scored): same sources; US uses yfinance priceToSalesTrailing12Months. Missing => psrSource "unknown".
 Bars/macro: FinanceDataReader. Crude oil WTI (reference-only KOSPI lag hypothesis): FDR then yfinance CL=F.
 Earnings dates: yfinance calendar (US, KR .KS/.KQ); ETFs have none.
Anything that fails is written as null so the TS side scores it as 'unknown' (never 0).
PSR and crudeOil are stored for display only; the TS scoring schema strips them and does not use them.

Usage: .venv-data/bin/python scripts/scorecard-collect.py [DOMESTIC:005930 US_NASDAQ:AAPL ...]
Without args, reads $DATA_DIR/scorecard-universe.json written by the dashboard agent.
Also runs display-only sidecars: calendar-crosscheck.py (exchange_calendars) and
risk-contribution.py (skfolio). Those never place orders and never read .env.
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
import io, contextlib
try:
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

def attach_psr(fund, psr, source):
    """PSR is reference-only. Record source per value; 'unknown' when missing."""
    if not fund: return fund
    if psr is not None:
        fund["psr"], fund["psrSource"] = psr, source
    else:
        fund["psr"], fund["psrSource"] = None, "unknown"
    return fund

def pick_psr(vals, num):
    if not vals: return None
    for key, value in vals.items():
        if str(key).lower() == "psr":
            v = num(value)
            if v is not None: return v
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

import time, urllib.request
NAVER_UA = {"User-Agent": "Mozilla/5.0 (kis-vts-paper-dashboard personal research; <=1 req/s)"}
_last = [0.0]
def naver_json(path):
    cache_dir = os.path.join(root, "naver-cache"); os.makedirs(cache_dir, mode=0o700, exist_ok=True)
    cf = os.path.join(cache_dir, path.replace("/", "_").replace("?", "_") + ".json")
    if os.path.exists(cf) and time.time() - os.path.getmtime(cf) < 6 * 3600:
        with open(cf, encoding="utf8") as f: return json.load(f)
    wait = 1.0 - (time.time() - _last[0])
    if wait > 0: time.sleep(wait)
    _last[0] = time.time()
    with urllib.request.urlopen(urllib.request.Request("https://m.stock.naver.com/api/stock/" + path, headers=NAVER_UA), timeout=10) as r:
        data = json.loads(r.read().decode("utf8"))
    with open(cf, "w", encoding="utf8") as f: json.dump(data, f, ensure_ascii=False)
    return data

def korean_amount(text):
    """'1,103조 1,928억' -> KRW"""
    if not text: return None
    total, found = 0.0, False
    for num, unit in __import__("re").findall(r"([\d,.]+)\s*(조|억|만)?", text):
        n = fin(num.replace(",", ""))
        if n is None: continue
        total += n * {"조": 1e12, "억": 1e8, "만": 1e4}.get(unit, 1); found = True
    return total if found else None

def naver_kr(code):
    fundamentals = flows = None; is_etf = False
    try:
        info = naver_json(f"{code}/integration")
        is_etf = str(info.get("stockEndType", "")).lower() == "etf"
        vals = {x.get("code"): x.get("value") for x in info.get("totalInfos", [])}
        num = lambda v: fin(str(v).replace(",", "").replace("배", "").replace("원", "").replace("%", "")) if v not in (None, "", "N/A", "-") else None
        if not is_etf:
            fundamentals = attach_psr({"per": num(vals.get("per")), "pbr": num(vals.get("pbr")),
                            "marketCapKrw": korean_amount(vals.get("marketValue")), "asOf": today.isoformat(), "source": "NAVER"},
                            pick_psr(vals, num), "NAVER")
    except Exception as e:  # noqa: BLE001
        note(f"naver integration {code}", e)
    try:
        rows = naver_json(f"{code}/trend?pageSize=5")[:5]
        q = lambda v: fin(str(v).replace(",", "").replace("+", ""))
        f = [q(r["foreignerPureBuyQuant"]) * q(r["closePrice"]) for r in rows]
        o = [q(r["organPureBuyQuant"]) * q(r["closePrice"]) for r in rows]
        if rows and all(v is not None for v in f + o):
            flows = {"foreignNetKrw": sum(f), "institutionNetKrw": sum(o), "days": len(rows), "asOf": rows[0]["bizdate"],
                     "source": "NAVER(수량×종가 근사)"}
    except Exception as e:  # noqa: BLE001
        note(f"naver trend {code}", e)
    return fundamentals, flows, is_etf

def pykrx_kr(code):
    if not krx: return None, None
    end = ymd(today - dt.timedelta(days=1)); begin = ymd(today - dt.timedelta(days=21))
    fundamentals = flows = None
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            f = krx.get_market_fundamental(begin, end, code); c = krx.get_market_cap(begin, end, code)
        if len(f) and len(c):
            psr_col = next((col for col in f.columns if str(col).upper() == "PSR"), None)
            fundamentals = attach_psr({"per": fin(f["PER"].iloc[-1]) or None, "pbr": fin(f["PBR"].iloc[-1]) or None,
                            "marketCapKrw": fin(c["시가총액"].iloc[-1]), "asOf": f.index[-1].strftime("%Y%m%d"), "source": "PYKRX"},
                            fin(f[psr_col].iloc[-1]) if psr_col is not None else None, "PYKRX")
    except Exception as e:  # noqa: BLE001
        note(f"pykrx fundamentals {code}", e)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            t = krx.get_market_trading_value_by_date(begin, end, code).tail(5)
        if len(t) and "기관합계" in t.columns and "외국인합계" in t.columns:
            flows = {"foreignNetKrw": fin(t["외국인합계"].sum()), "institutionNetKrw": fin(t["기관합계"].sum()),
                     "days": int(len(t)), "asOf": t.index[-1].strftime("%Y%m%d"), "source": "PYKRX"}
    except Exception as e:  # noqa: BLE001
        note(f"pykrx flows {code}", e)
    return fundamentals, flows

try:
    import yfinance as yf
except Exception as e:  # noqa: BLE001
    yf = None; note("import yfinance", e)

def yf_fundamentals(symbol, fx):
    if not yf: return None
    try:
        i = yf.Ticker(symbol).info
        cap = fin(i.get("marketCap"))
        return attach_psr({"per": fin(i.get("trailingPE")), "pbr": fin(i.get("priceToBook")),
                "marketCapKrw": cap * fx if cap and fx else None, "asOf": today.isoformat(), "source": "YFINANCE"},
                fin(i.get("priceToSalesTrailing12Months")), "YFINANCE")
    except Exception as e:  # noqa: BLE001
        note(f"yfinance info {symbol}", e); return None

def yf_next_earnings(symbols):
    if not yf: return None, None
    for sym in symbols:
        try:
            cal = yf.Ticker(sym).calendar or {}
            dates = [d for d in cal.get("Earnings Date", []) if hasattr(d, "strftime")]
            future = sorted(d for d in dates if d >= today)
            if future: return [d.strftime("%Y%m%d") for d in future], sym
        except Exception as e:  # noqa: BLE001
            note(f"yfinance calendar {sym}", e)
    return None, None

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

UNKNOWN_OIL = {"lastClose": None, "ma20": None, "ma60": None, "trend": None, "laggedChange40dPct": None,
               "lagTradingDays": 40, "asOf": None, "source": "unknown", "symbol": None}

def oil_bars():
    """Completed WTI bars. FDR first (same family as other macro series), then yfinance CL=F."""
    if fdr:
        for sym in ("CL=F", "CL", "WTI"):
            try:
                rows = bars_for(sym)
                if len(rows) >= 20: return rows, "FDR", sym
            except Exception as e:  # noqa: BLE001
                note(f"crudeOil FDR {sym}", e)
    if yf:
        try:
            hist = yf.Ticker("CL=F").history(start=start, end=today.isoformat(), auto_adjust=False)
            out = []
            for idx, row in hist.iterrows():
                c = fin(row.get("Close"))
                if c and c > 0:
                    d = idx.strftime("%Y%m%d") if hasattr(idx, "strftime") else None
                    if d: out.append({"date": d, "close": c})
            if len(out) >= 20: return out, "YFINANCE", "CL=F"
        except Exception as e:  # noqa: BLE001
            note("crudeOil yfinance CL=F", e)
    return [], "unknown", None

def crude_oil():
    """20/60-day trend and ~40-trading-day change. Reference-only (unvalidated KOSPI lead claim). Same formula as src/lib/scorecard.ts crudeOilFromBars."""
    rows, source, symbol = oil_bars()
    if not rows: return dict(UNKNOWN_OIL)
    closes = [b["close"] for b in rows]
    last, n = closes[-1], len(closes)
    ma20 = sum(closes[-20:]) / 20 if n >= 20 else None
    ma60 = sum(closes[-60:]) / 60 if n >= 60 else None
    trend = None
    if ma20 is not None and ma60 is not None:
        trend = "상승" if last > ma20 > ma60 else "하락" if last < ma20 and ma20 < ma60 else "혼조"
    lagged = (last / closes[-41] - 1) * 100 if n >= 41 else None
    return {"lastClose": last, "ma20": fin(ma20), "ma60": fin(ma60), "trend": trend,
            "laggedChange40dPct": fin(lagged), "lagTradingDays": 40, "asOf": rows[-1]["date"],
            "source": source, "symbol": symbol}

try: m = macro()
except Exception as e: m = None; note("macro", e)  # noqa: BLE001
try: oil = crude_oil()
except Exception as e: oil = dict(UNKNOWN_OIL); note("crudeOil", e)  # noqa: BLE001
fx_now = None
try:
    fx_now = fin(fdr.DataReader("USD/KRW", (today - dt.timedelta(days=10)).isoformat())["Close"].dropna().iloc[-1]) if fdr else None
except Exception as e: note("fx", e)  # noqa: BLE001

symbols, earnings_auto = {}, {}
for t in universe():
    market, code = t.get("market"), t.get("stockCode")
    if market not in ("DOMESTIC", "US_NASDAQ") or not code: continue
    row = {"bars": [], "fundamentals": None, "flows": None, "isEtf": False}
    try: row["bars"] = bars_for(code)
    except Exception as e: note(f"bars {code}", e)  # noqa: BLE001
    key = f"{market}:{code}"
    if market == "DOMESTIC":
        row["fundamentals"], row["flows"], row["isEtf"] = naver_kr(code)
        if (row["fundamentals"] is None and not row["isEtf"]) or row["flows"] is None:
            pf, pl = pykrx_kr(code)
            if row["fundamentals"] is None and not row["isEtf"]: row["fundamentals"] = pf
            elif row["fundamentals"] and row["fundamentals"].get("psr") is None and pf and pf.get("psr") is not None:
                row["fundamentals"]["psr"], row["fundamentals"]["psrSource"] = pf["psr"], pf.get("psrSource") or "PYKRX"
            if row["flows"] is None: row["flows"] = pl
        if row["isEtf"]:
            earnings_auto[key] = {"dates": [], "verifiedThrough": ymd(today + dt.timedelta(days=30)), "source": "auto:ETF(실적발표 없음)"}
        else:
            dates, sym = yf_next_earnings([f"{code}.KS", f"{code}.KQ"])
            if dates: earnings_auto[key] = {"dates": dates, "verifiedThrough": dates[0], "source": f"auto:yfinance({sym}, 추정일 포함)"}
    else:
        row["fundamentals"] = yf_fundamentals(code, fx_now)
        dates, sym = yf_next_earnings([code])
        if dates: earnings_auto[key] = {"dates": dates, "verifiedThrough": dates[0], "source": f"auto:yfinance({sym})"}
    symbols[key] = row

# Auto earnings go to an ignored runtime file ($DATA_DIR/event-calendar-auto.json) so the tracked
# data/event-calendar.json (FOMC + manual entries) never gets a git diff. Manual entries win at read time.
earnings_missing = [k for k in symbols if k not in earnings_auto]
try:
    os.makedirs(root, mode=0o700, exist_ok=True)
    fd2, tmp2 = tempfile.mkstemp(dir=root, prefix=".event-calendar-auto.")
    with os.fdopen(fd2, "w", encoding="utf8") as f:
        json.dump({"generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "earnings": earnings_auto}, f, ensure_ascii=False, indent=1)
    os.replace(tmp2, os.path.join(root, "event-calendar-auto.json"))
except Exception as e:  # noqa: BLE001
    note("event-calendar-auto write", e)

out = {"version": 1, "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
       "symbols": symbols, "macro": m, "crudeOil": oil, "errors": errors[:50]}
os.makedirs(root, mode=0o700, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=root, prefix=".scorecard-data.")
with os.fdopen(fd, "w", encoding="utf8") as f: json.dump(out, f, ensure_ascii=False)
os.replace(tmp, os.path.join(root, "scorecard-data.json"))

def run_sidecar(filename):
    """Display/research sidecars (calendar cross-check, risk contribution). Never place orders."""
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    spec = importlib.util.spec_from_file_location(filename.replace(".py", "").replace("-", "_"), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main() if hasattr(mod, "main") else None

sidecars = {}
for name in ("calendar-crosscheck.py", "risk-contribution.py"):
    try:
        payload = run_sidecar(name)
        sidecars[name] = (payload or {}).get("summary") if isinstance(payload, dict) else True
    except Exception as e:  # noqa: BLE001
        note(name, e); sidecars[name] = {"status": "미확인"}

summary = {k: {"bars": len(v["bars"]), "fundamentals": (v["fundamentals"] or {}).get("source"), "flows": (v["flows"] or {}).get("source"), "etf": v["isEtf"], "earnings": earnings_auto.get(k, {}).get("dates", ["미확인"])[:1]} for k, v in symbols.items()}
print(json.dumps({"symbols": summary, "macro": m, "crudeOil": oil, "earningsMissing": earnings_missing,
                  "research": sidecars, "errors": errors[:15]}, ensure_ascii=False, indent=1))
