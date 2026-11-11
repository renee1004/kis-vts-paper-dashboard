# 집중도·위험기여 (표시·연구 전용)

보유 평가금액 비중, 종목 변동성, 포트폴리오 분산 기여를 보여 주는 연구 패널입니다.
**주문 방향·수량·제출 여부·손절·장 시간 게이트에 쓰지 않습니다.**

- 계산: `skfolio` (BSD-3-Clause) `Portfolio.contribution(RiskMeasure.VARIANCE)`. skfolio가 없으면 같은 분산 기여 공식을 로컬에서 계산하고 `riskSource`는 `python-covariance`가 됩니다.
- 입력: 앱이 기록한 `.data/research-holdings.json` (평가금액만, 계좌번호 없음)와 수집기가 만든 약 1년 일봉
- 환율: 앱과 같은 `USD_KRW_SAFETY_RATE` 1,500원 가정 (`FIXED_1500_NOT_ACTUAL_FX`)
- 출력: `.data/risk-contribution.json` (git 제외)
- 화면: `RiskContributionPanel`, 점수판 옆. 값 없음·오래된 파일·일봉 부족은 **미확인**
- 업종/테마: 내장 맵(반도체 등) + 있으면 yfinance sector. 없으면 미확인. 반도체 비중은 테마 합산

수집은 점수판 수집기와 같이 실행됩니다.

```bash
python3 -m venv .venv-data
.venv-data/bin/pip install -r scripts/requirements-data.txt
.venv-data/bin/python scripts/scorecard-collect.py
.venv-data/bin/python scripts/risk-contribution.py --self-check   # 네트워크 없음
```

라이선스 고지: `docs/third-party/skfolio-LICENSE.txt`.
