#!/usr/bin/env python3
"""Concentration / risk-contribution snapshot (skfolio, BSD-3-Clause).

Display/research only. Never places orders, never reads .env or account numbers.
Weights use KIS evaluation amounts; USD is converted with the same fixed 1,500 KRW
rate the dashboard uses for combined limits (FIXED_1500_NOT_ACTUAL_FX).

Writes $DATA_DIR/risk-contribution.json (default ./.data).

Usage:
  .venv-data/bin/python scripts/risk-contribution.py
  .venv-data/bin/python scripts/risk-contribution.py --self-check
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import sys
import tempfile
from pathlib import Path

USD_KRW = 1500
THEME = {
    "005930": "반도체", "000660": "반도체", "003160": "반도체",
    "NVDA": "반도체", "AMD": "반도체", "TSM": "반도체", "AVGO": "반도체",
    "SOXX": "반도체", "SMH": "반도체", "SOXL": "반도체", "SOXS": "반도체",
    "AAPL": "정보기술", "MSFT": "정보기술", "AMZN": "경기소비재",
    "GOOGL": "커뮤니케이션", "META": "커뮤니케이션", "TSLA": "경기소비재",
    "069500": "시장지수", "SPY": "시장지수", "QQQ": "시장지수",
}
YF_SECTOR_KO = {
    "Technology": "정보기술", "Consumer Cyclical": "경기소비재",
    "Communication Services": "커뮤니케이션", "Financial Services": "금융",
    "Healthcare": "헬스케어", "Energy": "에너지", "Industrials": "산업재",
    "Basic Materials": "소재", "Real Estate": "부동산", "Utilities": "유틸리티",
    "Consumer Defensive": "필수소비재",
}


def data_dir() -> Path:
    return Path(os.environ.get("DATA_DIR") or (Path.cwd() / ".data"))


def fin(v):
    try:
        v = float(v)
        return v if v == v and abs(v) != float("inf") else None
    except Exception:  # noqa: BLE001
        return None


def atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".")
    with os.fdopen(fd, "w", encoding="utf8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_json(name: str):
    path = data_dir() / name
    try:
        with path.open(encoding="utf8") as handle:
            return json.load(handle)
    except Exception:  # noqa: BLE001
        return None


def theme_for(code: str, yf_sector: str | None = None) -> str | None:
    if code in THEME:
        return THEME[code]
    if yf_sector:
        return YF_SECTOR_KO.get(yf_sector) or yf_sector
    return None


def holdings_from_file(raw) -> tuple[list[dict], float, list[str]]:
    errors = []
    if not raw or not isinstance(raw, dict):
        return [], USD_KRW, ["research-holdings.json missing"]
    usd = fin(raw.get("usdKrw")) or USD_KRW
    out = []
    for row in raw.get("holdings") or []:
        if not isinstance(row, dict):
            continue
        market, code = row.get("market"), str(row.get("stockCode") or "")
        if market not in ("DOMESTIC", "US_NASDAQ") or not code:
            continue
        krw = fin(row.get("evaluationKrw"))
        if krw is None:
            ev = fin(row.get("evaluation"))
            if ev is None or ev <= 0:
                continue
            krw = ev if row.get("currency") != "USD" else ev * usd
        if krw is None or krw <= 0:
            continue
        out.append({
            "market": market, "stockCode": code, "stockName": row.get("stockName") or code,
            "evaluationKrw": krw, "currency": "USD" if market == "US_NASDAQ" else "KRW",
            "theme": theme_for(code),
        })
    if not out:
        errors.append("no positive-evaluation holdings")
    return out, usd, errors


def bars_map_from_scorecard(raw) -> dict[str, dict[str, float]]:
    out = {}
    if not raw or not isinstance(raw, dict):
        return out
    for key, row in (raw.get("symbols") or {}).items():
        series = {}
        for bar in (row or {}).get("bars") or []:
            date, close = str(bar.get("date") or ""), fin(bar.get("close"))
            if len(date) == 8 and close and close > 0:
                series[date] = close
        if series:
            out[key] = series
    return out


def fetch_bars(market: str, code: str) -> dict[str, float]:
    try:
        import FinanceDataReader as fdr
    except Exception:  # noqa: BLE001
        return {}
    today = dt.date.today()
    start = (today - dt.timedelta(days=400)).isoformat()
    try:
        df = fdr.DataReader(code, start)
        df = df[df.index.date < today]
        series = {}
        for idx, row in df.tail(260).iterrows():
            close = fin(row.get("Close"))
            if close and close > 0:
                series[idx.strftime("%Y%m%d")] = close
        return series
    except Exception:  # noqa: BLE001
        return {}


def aligned_returns(series_by_key: dict[str, dict[str, float]]) -> tuple[list[str], list[list[float]]]:
    if len(series_by_key) < 1:
        return [], []
    common = None
    for series in series_by_key.values():
        keys = set(series)
        common = keys if common is None else common & keys
    dates = sorted(common or [])
    if len(dates) < 22:
        return [], []
    cols = []
    for key in series_by_key:
        closes = [series_by_key[key][d] for d in dates]
        cols.append([(closes[i] / closes[i - 1] - 1) for i in range(1, len(closes))])
    return dates[1:], cols


def _vol_pct(col: list[float]) -> float | None:
    if len(col) < 2:
        return None
    mean = sum(col) / len(col)
    var = sum((x - mean) ** 2 for x in col) / (len(col) - 1)
    return math.sqrt(var) * math.sqrt(252) * 100


def python_rc(weights: list[float], returns_cols: list[list[float]]) -> list[float]:
    n_obs, n = len(returns_cols[0]), len(weights)
    means = [sum(col) / n_obs for col in returns_cols]
    cov = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            cov[i][j] = sum((returns_cols[i][t] - means[i]) * (returns_cols[j][t] - means[j]) for t in range(n_obs)) / (n_obs - 1)
    total_w = sum(weights) or 1.0
    w = [x / total_w for x in weights]
    sigma_w = [sum(cov[i][j] * w[j] for j in range(n)) for i in range(n)]
    port_var = sum(w[i] * sigma_w[i] for i in range(n))
    if port_var == 0:
        return [0.0 for _ in w]
    return [w[i] * sigma_w[i] / port_var * 100 for i in range(n)]


def risk_percents(weights: list[float], returns_cols: list[list[float]]) -> tuple[list[float | None], list[float | None], str | None]:
    """Percent of portfolio variance. Prefer skfolio; fall back to a local covariance formula."""
    if not weights or not returns_cols or len(weights) != len(returns_cols):
        return [None] * len(weights), [None] * len(weights), None
    if len(returns_cols[0]) < 21:
        return [None] * len(weights), [None] * len(weights), "not enough overlapping daily closes"
    vol = [_vol_pct(col) for col in returns_cols]
    try:
        import numpy as np
        import pandas as pd
        from skfolio import RiskMeasure
        from skfolio.portfolio import Portfolio
        matrix = np.array(returns_cols, dtype=float).T
        names = [f"a{i}" for i in range(len(weights))]
        frame = pd.DataFrame(matrix, columns=names)
        w = np.array(weights, dtype=float)
        w = w / w.sum()
        port = Portfolio(X=frame, weights=w)
        contrib = port.contribution(measure=RiskMeasure.VARIANCE)
        total = float(np.sum(contrib))
        rc = [None if total == 0 else float(x) / total * 100 for x in contrib]
        return rc, vol, "skfolio"
    except Exception:  # noqa: BLE001
        try:
            rc = python_rc(weights, returns_cols)
            return rc, vol, "python-covariance"
        except Exception as exc:  # noqa: BLE001
            return [None] * len(weights), vol, f"risk failed: {type(exc).__name__}: {str(exc)[:120]}"


def enrich_themes(holdings: list[dict], allow_network: bool) -> None:
    if not allow_network:
        return
    try:
        import yfinance as yf
    except Exception:  # noqa: BLE001
        return
    for row in holdings:
        if row.get("theme"):
            continue
        symbol = row["stockCode"] if row["market"] == "US_NASDAQ" else f"{row['stockCode']}.KS"
        try:
            sector = (yf.Ticker(symbol).info or {}).get("sector")
        except Exception:  # noqa: BLE001
            sector = None
        row["theme"] = theme_for(row["stockCode"], sector if isinstance(sector, str) else None)


def compute(holdings: list[dict], prices: dict[str, dict[str, float]]) -> dict:
    total = sum(h["evaluationKrw"] for h in holdings)
    keys = [f"{h['market']}:{h['stockCode']}" for h in holdings]
    weights = [h["evaluationKrw"] / total for h in holdings] if total else []
    series = {k: prices.get(k) or {} for k in keys}
    usable = {k: v for k, v in series.items() if len(v) >= 22}
    rc = vol = [None] * len(holdings)
    source = None
    if len(usable) == len(holdings) and holdings:
        _dates, cols = aligned_returns({k: series[k] for k in keys})
        if cols:
            rc, vol, source = risk_percents(weights, cols)
    rows = []
    for i, h in enumerate(holdings):
        rows.append({
            "market": h["market"], "stockCode": h["stockCode"], "stockName": h["stockName"],
            "evaluationKrw": round(h["evaluationKrw"], 2), "weightPct": round(weights[i] * 100, 4) if weights else None,
            "volatilityPct": None if vol[i] is None else round(vol[i], 4),
            "riskContributionPct": None if rc[i] is None else round(rc[i], 4),
            "theme": h.get("theme"), "bars": len(series[keys[i]]),
        })
    groups: dict[str, dict] = {}
    for row in rows:
        label = row["theme"] or "미확인"
        g = groups.setdefault(label, {"theme": label, "weightPct": 0.0, "riskContributionPct": 0.0, "knownRc": True})
        g["weightPct"] += row["weightPct"] or 0.0
        if row["riskContributionPct"] is None:
            g["knownRc"] = False
        else:
            g["riskContributionPct"] += row["riskContributionPct"]
    group_list = []
    for g in groups.values():
        group_list.append({
            "theme": g["theme"], "weightPct": round(g["weightPct"], 4),
            "riskContributionPct": None if not g["knownRc"] else round(g["riskContributionPct"], 4),
        })
    group_list.sort(key=lambda x: x["weightPct"], reverse=True)
    semi = next((g for g in group_list if g["theme"] == "반도체"), None)
    return {
        "holdings": rows, "groups": group_list,
        "semiconductorWeightPct": None if semi is None else semi["weightPct"],
        "semiconductorRiskContributionPct": None if semi is None else semi["riskContributionPct"],
        "riskSource": source, "holdingCount": len(rows), "totalEvaluationKrw": round(total, 2) if total else 0,
    }


def empty_payload(errors: list[str], usd_krw: float = USD_KRW) -> dict:
    return {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "displayOnly": True,
        "doesNotAffectOrders": True,
        "source": "skfolio",
        "license": "BSD-3-Clause",
        "usdKrw": usd_krw,
        "fxSource": "FIXED_1500_NOT_ACTUAL_FX",
        "holdings": [], "groups": [],
        "semiconductorWeightPct": None, "semiconductorRiskContributionPct": None,
        "riskSource": None, "holdingCount": 0, "totalEvaluationKrw": 0,
        "errors": errors[:50],
        "summary": {"holdingCount": 0, "status": "미확인"},
    }


def main(write: bool = True, allow_network: bool = True) -> dict:
    holdings, usd, errors = holdings_from_file(load_json("research-holdings.json"))
    if not holdings:
        payload = empty_payload(errors or ["미확인"], usd)
        if write:
            atomic_write(data_dir() / "risk-contribution.json", payload)
        return payload
    enrich_themes(holdings, allow_network=allow_network)
    prices = bars_map_from_scorecard(load_json("scorecard-data.json"))
    if allow_network:
        for h in holdings:
            key = f"{h['market']}:{h['stockCode']}"
            if len(prices.get(key) or {}) < 22:
                fetched = fetch_bars(h["market"], h["stockCode"])
                if fetched:
                    prices[key] = fetched
    computed = compute(holdings, prices)
    payload = empty_payload(errors, usd)
    payload.update(computed)
    payload["summary"] = {
        "holdingCount": computed["holdingCount"],
        "semiconductorWeightPct": computed["semiconductorWeightPct"],
        "riskSource": computed["riskSource"],
        "status": "ok" if computed["holdings"] else "미확인",
    }
    if write:
        atomic_write(data_dir() / "risk-contribution.json", payload)
    return payload


def self_check() -> int:
    n = 80
    a = [0.01 * ((i % 5) - 2) / 2 for i in range(n)]
    b = [0.4 * a[i] + 0.002 * ((i % 3) - 1) for i in range(n)]
    pa, pb, sa, sb = [100.0], [50.0], 100.0, 50.0
    for i in range(n):
        sa *= 1 + a[i]; sb *= 1 + b[i]; pa.append(sa); pb.append(sb)
    dates = [(dt.date(2025, 1, 2) + dt.timedelta(days=i)).strftime("%Y%m%d") for i in range(n + 1)]
    holdings = [
        {"market": "DOMESTIC", "stockCode": "005930", "stockName": "삼성전자", "evaluationKrw": 700_000, "theme": "반도체"},
        {"market": "US_NASDAQ", "stockCode": "AAPL", "stockName": "Apple", "evaluationKrw": 300_000, "theme": "정보기술"},
    ]
    prices = {
        "DOMESTIC:005930": dict(zip(dates, pa)),
        "US_NASDAQ:AAPL": dict(zip(dates, pb)),
    }
    out = compute(holdings, prices)
    assert out["holdingCount"] == 2
    assert abs(out["holdings"][0]["weightPct"] - 70) < 0.01
    assert out["holdings"][0]["theme"] == "반도체"
    assert out["semiconductorWeightPct"] == out["holdings"][0]["weightPct"]
    _dates, cols = aligned_returns(prices)
    expected = python_rc([0.7, 0.3], cols)
    got = [h["riskContributionPct"] for h in out["holdings"]]
    assert got[0] is not None and got[1] is not None, out
    assert abs(sum(got) - 100) < 0.05
    assert abs(got[0] - expected[0]) < 1.5
    missing = compute(holdings, {})
    assert all(h["riskContributionPct"] is None for h in missing["holdings"])
    print(json.dumps({"ok": True, "riskSource": out["riskSource"], "weights": [h["weightPct"] for h in out["holdings"]],
                      "riskContributionPct": got, "semiconductorWeightPct": out["semiconductorWeightPct"]},
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        raise SystemExit(self_check())
    out = main()
    print(json.dumps(out.get("summary") or {"status": "미확인"}, ensure_ascii=False, indent=1))
