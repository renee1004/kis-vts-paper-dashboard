# KIS VTS 모의 자동매매 대시보드

현재 전략은 `trend-breakout-v1-unvalidated` 모의 검증 후보입니다.
수익을 보장하거나 화면 점수를 승률로 해석하지 않습니다.
이번 변경의 매매 규칙·위험 한도·원장 및 검사 방법은
[전략 점검 문서](docs/STRATEGY-REVIEW.md)를 기준으로 확인하세요.
전략 배정 예산 300만 원, 1회 기준금액 30만 원, 최대 5종목이며
체결가/원장 확인이 안 된 경우 신규 매수가 차단될 수 있습니다.

한국투자증권 모의투자(VTS)의 국내·미국(NASDAQ) 시세·캔들·잔고를 조회하고,
전략 신호가 안전 규칙을 통과하면 KIS VTS 모의계좌에 주문을 제출하는
대시보드입니다.

> 실전 도메인과 실전 TR ID는 지원하지 않습니다. 매도는 이 시스템이 매수하고
> KIS 체결조회(국내 `VTTC0081R`, 미국 `VTTS3035R`)로 확인한 수량까지만
> 허용하므로 기존 계좌 보유분은 자동매도하지 않습니다.

## 미국(NASDAQ) 모의 자동매매

- 관심종목: **AAPL, NVDA, AMD, AMZN, MSFT**
- 시세: `HHDFS00000300` · 일봉: `HHDFS76240000`
- 잔고: `VTTS3012R` (NASD/USD)
- 주문: **지정가만** — 매수 `VTTT1002U`, 매도 `VTTT1001U`
- 체결 동기화: `VTTS3035R`
- 주문 가능 시간: **미국 동부시간(ET) 평일 09:30–16:00** 정규장.
  한국 오전 9:30이 아닙니다. 한국시간은 서머타임이면 보통 **22:30–다음날 05:00**,
  표준시면 **23:30–다음날 06:00**입니다.
- 일일 매수 한도 **300만 원**은 국내 매수와 합산 (미국은 **1 USD = 1,500 KRW**
  보수 환율로 환산). 1회 주문 상한 **30만 원** 동일.

## 안전 기본값

```text
TRADING_MODE=DEMO
ORDER_EXECUTION_MODE=VTS_MOCK
KIS server=VTS
effectiveSafetyMode=SAFE_LOCKED
killSwitchEnabled=true
autoDomesticOrderEnabled=false
autoOverseasOrderEnabled=false
allowRealFallback=false
canPlaceDomesticOrderNow=false
canPlaceOverseasOrderNow=false
```

서버 재시작 시 무장 상태는 저장되지 않고 항상 `SAFE_LOCKED`로 복귀합니다.

## 내 PC(WSL Ubuntu)에서 실행

저장소 최상위에서 실행합니다.

```bash
npm run dashboard
```

브라우저:

```text
http://localhost:3939
```

포트를 바꾸려면 `PORT=4000 npm run dashboard`를 사용합니다. 기존
`trading_agent_v1` 화면은 `npm run dev:legacy`이며 이 앱과 다릅니다.

PostgreSQL 없이도 `.data/`의 암호화 로컬 저장소로 시작됩니다. PostgreSQL
모델은 `prisma/schema.prisma`에 준비되어 있습니다.

## KIS 설정

한 번만 설정하고 다시 입력하지 않으려면 아래 명령을 사용합니다.

```bash
npm run kis:setup
```

App Key, App Secret, 계좌 8자리, 상품코드를 물어본 뒤 `.env.local`에 권한
`600`으로 저장합니다. 이후에는 실행할 때마다 자동으로 읽으므로 화면 입력이
필요 없습니다. `.env.local`은 git에서 제외됩니다.

화면에서 직접 넣어도 되며, 이때는 `.data/kis-config.enc`에 암호화되어 저장되고
재시작 후에도 유지됩니다. 두 곳에 모두 있으면 `.env.local`이 우선합니다.
현재 어디서 읽는지는 KIS API 설정 카드의 `저장 위치`에 표시됩니다.

화면 입력 시 필요한 값은 다음과 같습니다.

- 모의투자 `KIS_APP_KEY`
- 모의투자 `KIS_APP_SECRET`
- 계좌번호 8자리 `KIS_ACCOUNT_NO` — **KIS Developers > 나의 신청내역**에서 해당 App Key 행에 묶인 모의투자계좌입니다. 모의투자 웹(상시대회)의 계좌와 숫자가 다를 수 있습니다. 시세는 되고 잔고만 `OPSQ2000` / `INVALID_CHECK_ACNO`이면 거의 항상 이 불일치입니다.
- 상품코드 2자리 `KIS_ACCOUNT_PRODUCT_CODE` (국내주식 모의는 보통 `01`)

Base URL은 VTS로 고정되어 수정할 수 없습니다. 저장 후에는
`appKeyLoaded=true` 같은 boolean만 표시하고 원문·일부 마스킹 값은 반환하지
않습니다.

민감정보는 `.data/kis-config.enc`에 AES-256-GCM으로 저장되며 `.data/` 전체는
git에서 제외됩니다.

## 사용 순서

1. KIS 설정 저장
2. `VTS 연결 테스트`
3. `VTS 자동주문 준비` — 연결을 다시 검증하고 `VTS_AUTO_READY`
4. `VTS 모의 자동주문 활성화` — 명시적 확인값과 함께 `VTS_AUTO_ARMED`
5. 에이전트 시작

에이전트는 1분마다 국내·미국 관심종목을 분석합니다. 매수는 한국 날짜 기준
**하루 300만 원**(국내+미국 합산, 미국은 1 USD=1,500원 환산)까지이며, 1회
주문은 기준가×수량 **30만 원 이하**입니다. 같은 시장·종목의 미체결 주문이나
자동매매 소유 수량이 있으면 중복 매수하지 않습니다. 매도 전에는 KIS
체결조회로 이 앱의 주문번호가 체결됐는지 확인합니다.

## 상태 확인

```bash
curl http://localhost:3000/api/system/local-health
curl http://localhost:3000/api/agent/status
curl http://localhost:3000/api/vts-orders
```

실전 서버 호출 여부는 대시보드의 `Real fallback=false`와
`KIS server=VTS`로 확인합니다. 소스 코드의 모든 KIS fetch는
`VTS_BASE_URL`만 사용합니다.

## API

| Method | Path | 역할 |
|---|---|---|
| GET | `/api/system/local-health` | 런타임·DB·KIS·안전 상태 |
| GET | `/api/agent/status` | 사이클 카운터·진단·원장 |
| POST | `/api/agent/start` | 무장된 VTS 모의 자동매매 시작 |
| POST | `/api/agent/stop` | 분석 에이전트 중지 |
| GET/POST | `/api/kis/save-config` | boolean 상태 조회 / 암호화 저장 |
| POST | `/api/kis/test-connection` | VTS token/price/candle/balance 진단 |
| POST | `/api/settings/safety-lock` | 즉시 SAFE_LOCKED |
| POST | `/api/settings/vts-paper-arm` | PREPARE / ARM |
| GET/POST | `/api/system/cleanup-trade-history` | 기록 수 확인 / 제한 cleanup |
| GET/POST | `/api/watchlist` | 관심종목 |
| GET | `/api/vts-orders` | VTS 주문·에이전트 소유 수량·제한 |

ARM 요청:

```bash
curl -X POST http://localhost:3000/api/settings/vts-paper-arm \
  -H 'content-type: application/json' \
  -d '{"action":"ARM","confirm":"ARM_VTS_AUTO_ONLY"}'
```

Cleanup은 아래 확인문이 정확히 일치할 때 `TradeHistory`와 `AgentLog`만
삭제합니다.

```bash
curl -X POST http://localhost:3000/api/system/cleanup-trade-history \
  -H 'content-type: application/json' \
  -d '{"confirm":"RESET_TRADE_AND_LOG_HISTORY"}'
```

`Position`, VTS 주문, 자동매매 소유 수량, KIS 설정, 안전 설정, 관심종목은
삭제하지 않습니다.

## 설계 문서

소스 분석, 재사용/폐기 기준, 안전 불변식은
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)에 기록했습니다.
