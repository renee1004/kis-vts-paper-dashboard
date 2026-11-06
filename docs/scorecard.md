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
3. 포트폴리오 점검: 보유 종목 수(최대 5), 종목 비중(국내 10%·미국 15%, `marketRiskLimits`), 레버리지·인버스는 기존대로 매수 금지(3~5% 한도보다 엄격하게 유지).
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
