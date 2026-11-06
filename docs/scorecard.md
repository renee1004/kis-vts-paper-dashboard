# 5관점 점수판 (모의주문 판단 엔진 v3)

- 버전: `scorecard-5view-v3-paper-unvalidated` (`src/lib/scorecard.ts` `DECISION_ENGINE_VERSION`)
- 이전 엔진: `trend-breakout-v2-capital30m-unvalidated` (`STRATEGY_VERSION`, 이제 백테스트·A/B 그림자 비교 기준선 전용)
- 범위: **모의투자(VTS) 주문 판단만**. 실전 주문·자동매매 켜기 없음. 모든 주문은 기존 `rule-engine` → `safety`(SAFE_LOCKED·킬스위치·장 시간·잔고 신선도·한도) → `submitOrder` 최종 게이트를 그대로 거칩니다. 손절·익절 `enforceRiskExits`도 그대로입니다.
- 검증 상태: 미검증 가설. 수익을 보장하지 않습니다.

## 절차 (TradingAgents의 절차만 참고, 코드 미사용)

1. **관점별 점수** (+1 / 0 / −1 / 미확인). 데이터가 없으면 0이 아니라 `미확인`.
   | 관점 | 입력 | +1 | −1 |
   |---|---|---|---|
   | 펀더멘털 | pykrx PER·PBR·시가총액 | PER 0~15, PBR ≤1.5 | 적자·PER>40·PBR>5·시총<1,000억 |
   | 수급 | pykrx 외국인·기관 5일 순매수 | 둘 다 순매수 | 둘 다 순매도 |
   | 기술적 | 완료 일봉 ≥200 (FDR 캐시 우선, 없으면 KIS) | 종가>20>60>200일선, 52주 고점 15% 이내 | 종가·20일선 < 60일선 |
   | 뉴스 | **헤드라인·수집 신선도만** (`researchHeadlinesFor` → `scoreNews`) | 직접 긍정 제목만 | 직접 부정 제목만 |
   | 거시 | FDR VIX·원달러 20일 변화·미 10년물 20일 변화 | VIX<20, 환율<+1%, 금리<+15bp | VIX≥30 또는 환율≥+3% 또는 금리≥+40bp |
   뉴스 관점은 구조적으로 가격 입력이 없습니다. `newsOnly()`가 헤드라인·신선도 외 필드를 버립니다 (지난 리뷰: 뉴스 판단 17건 중 15건이 가격 신호 복사).
2. 매수할 이유 / 안 할 이유 한 줄씩 (`bullCase`, `bearCase`).
3. 포트폴리오 점검: 보유 종목 수(최대 5), 종목 비중(국내 10%·미국 15%, `marketRiskLimits`). 레버리지·인버스는 (renee 승인으로) 전면 금지 대신 **합계 노출 ≤ 평가자산(원금+전략 손익)의 5%** 안에서만 허용합니다. `LEVERED_EXPOSURE_CAP_PCT`로 3~5% 범위 안에서만 조정되고(범위 밖 값은 3 또는 5로 고정), 한 주문이 한도를 넘기면 수량을 줄이고 1주도 못 사면 `LEVERED_EXPOSURE_CAP`으로 차단합니다. 판별: 이름(인버스·곱버스·레버리지·2X·3X·Ultra·Inverse·Leveraged·Bear) 또는 대표 미국 티커(TQQQ, SQQQ, SOXL 등). 나머지 게이트는 모두 그대로입니다.
4. 규칙 필터 (점수보다 우선):
   - 미확인 관점 2개 이상 → 보류
   - FOMC 당일(미국: 회의 이틀, 국내: 발표 다음 날 KST) → 보류. 달력 범위 밖은 미확인 → 보류
   - 실적 발표 전날·당일 → 보류. 종목별 실적일이 `data/event-calendar.json`에 없으면 미확인 → 신규 매수 보류
   - 추격 매수(현재가 > 전일 종가 +3% 또는 20일선 +8%) → 관망
   - 물타기(평균단가 아래 추가매수) → 보유
   - 보호선은 **완료 종가** 기준: 종가 ≤ 평균단가×(1−손절폭) → 전량매도
5. 결론: 매수검토, 조건부매수, 보유, 추가매수, 일부매도, 전량매도, 관망, 보류 + 진입가·손절선·틀렸다는 신호.

## 결론 → 모의주문 매핑 (보수적)
| 결론 | 모의주문 |
|---|---|
| 매수검토 | BUY 후보 (안전 게이트 통과 시에만) |
| 전량매도 | SELL 후보 (에이전트가 산 수량만) |
| 조건부매수·추가매수·일부매도·보유·관망·보류 | 주문 없음 (추가매수는 기존 무피라미딩 규칙, 일부매도는 부분청산 미지원) |

## 데이터 수집
```bash
python3 -m venv .venv-data && .venv-data/bin/pip install finance-datareader pykrx
.venv-data/bin/python scripts/scorecard-collect.py            # .data/scorecard-universe.json(에이전트가 기록) 사용
.venv-data/bin/python scripts/scorecard-collect.py DOMESTIC:005930 US_NASDAQ:AAPL
```
결과: `.data/scorecard-data.json`. 4일 넘게 오래되면 전부 미확인 처리. 미국 종목은 pykrx 대상이 아니라 펀더멘털·수급이 미확인 → 항상 보류(의도된 보수 동작). ETF도 PER·수급이 없으면 보류. 하루 1회(장 마감 후) 실행 권장.

## A/B/C 비교 원장과 교체 시점
- 첫 점수판 사이클이 `.data/decision-engine-cutover.json`에 `{version, cutoverAt, previousVersion}`을 **한 번만** 기록합니다(덮어쓰지 않음).
- 교체 이후 모의주문의 `strategyVersion`과 성과 기록(`performanceHistory`)은 `scorecard-5view-v3-...`로 저장되어 이전 v2 기록과 자동 분리됩니다 (7일 성과는 같은 버전끼리만 계산).
- 시장지수 필터 A/B/C 그림자 비교(`market-comparison-v1`)는 계속 v2 추세 신호 기준선으로 돌아가며, 실제 주문과 섞이지 않습니다. `/api/strategy-comparison` 응답의 `liveDecisionEngine`에 교체 시점이 표시됩니다. 교체 시점 이전/이후 실제 모의주문 비교는 `cutoverAt` 기준으로 나눠서 보세요.

## 화면
`ScorecardPanel`: 종목별 5관점 점수·결론·필터, 선택 시 이유/진입가/손절선/틀렸다는 신호와 종가+20·60·200일선 차트(TradingView Lightweight Charts, Apache-2.0, 로고 표기 유지).

## 데이터 출처 우선순위 (v3.1)
| 값 | 1순위 | 2순위 | 3순위 | 비고 |
|---|---|---|---|---|
| 국내 PER·PBR·시총 | KIS `inquire-price`(FHKST01010100) 응답의 `per`·`pbr`·`hts_avls` — 앱이 이미 하는 현재가 호출에서 같이 저장(추가 호출 없음) | 네이버 모바일 JSON `m.stock.naver.com/api/stock/{code}/integration` | pykrx (KRX 로그인 필요, 현재 실패) | 이유 문구에 `[KIS]`/`[NAVER]`/`[PYKRX]` 표시 |
| 국내 외국인·기관 순매수 | KIS `inquire-investor`(FHKST01010900), 6시간 캐시, 실패 시 6시간 재시도 안 함 | 네이버 `.../{code}/trend?pageSize=5` (순매수 **수량×종가** 근사, 원) | pykrx | KIS는 백만원 단위 거래대금 |
| 미국 PER·PBR·시총 | yfinance `info`(trailingPE, priceToBook, marketCap×원달러) | — | — | |
| 미국 수급 | 수집 안 함 → 미확인 | | | 기관 보유 변화는 분기 13F 기준이라 시차가 커서 정직한 단기 수급 대용이 아님 |
| ETF 펀더멘털 | 미확인(ETF는 PER·PBR 의미 없음) | | | 수급은 네이버로 채움 |
| 일봉·거시 | FinanceDataReader | KIS 일봉(200개 미만이면 기술적 미확인) | | |
| 실적 발표일 | 수동 항목(`data/event-calendar.json`, git 관리) — 자동 수집분은 `.data/event-calendar-auto.json`(git 제외)에 저장, 읽을 때 수동이 우선 | yfinance calendar (미국, 국내 `.KS`/`.KQ`) | ETF는 실적 없음(30일 유효) | 다음 발표일까지를 확인 범위로 봄. 못 찾으면 미확인 → 신규 매수 보류 |

한계:
- KIS 값은 **서버 재시작 후** 실행 사이클에서만 채워집니다. VTS에서 `inquire-investor`가 지원되는지는 아직 실제 호출로 확인하지 않았습니다(키 보호를 위해 별도 테스트 호출을 하지 않음). 실패하면 자동으로 네이버 캐시를 씁니다.
- 네이버는 비공식 JSON이라 형식이 바뀌면 조용히 미확인이 됩니다. 1초 1회, 6시간 캐시(`.data/naver-cache/`). 수급은 당일 장중이 아닌 전일까지 값이며, 거래대금이 아니라 수량×종가 근사입니다.
- yfinance 국내 실적일은 추정일일 수 있습니다(예: 잠정실적 공시일과 다를 수 있음). 중요한 종목은 수동 항목으로 덮어쓰세요:
  `"DOMESTIC:005930": {"dates": ["20270108"], "verifiedThrough": "20270331", "source": "manual"}`
- 판단 예시 재현: `NEWS_DATA_DIR=<뉴스 원장 폴더> node scripts/scorecard-examples.cjs DOMESTIC:005930 US_NASDAQ:MSFT` (주문·KIS 호출 없음, 가격은 마지막 완료 종가)

## 매일 수집 (cron)
평일 16:40 KST: `crontab -l` 의 `scorecard-collect` 줄 참고. 로그 `.data/collect.log`. 수집은 git 추적 파일을 바꾸지 않습니다.
