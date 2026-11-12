# KIS VTS 모의 자동매매 대시보드

현재 라이브 모의주문 전략은 `trend-breakout-v2-capital30m-unvalidated`입니다
(`src/lib/strategy.ts`의 `STRATEGY_VERSION` / `DECISION_ENGINE_VERSION`).
5관점 점수판, PSR·WTI 참고값, 거래일 달력 교차검증, 집중도·위험기여 패널은 화면·연구 전용이며 주문 방향·수량·제출 여부에 쓰지 않습니다.
수익을 보장하거나 화면 점수를 승률로 해석하지 않습니다.
이번 변경의 매매 규칙·위험 한도·원장 및 검사 방법은
[전략 점검 문서](docs/STRATEGY-REVIEW.md)를 기준으로 확인하세요.

자본 기준은 **30,000,000원**(3,000만 원)입니다
(`PAPER_CAPITAL_KRW` / `INITIAL_ACCOUNT_BALANCE_KRW`).
버전 id의 `capital30m`은 이 3,000만 원 기준을 가리키는 **고정 식별자**이며
3,000,000원(300만 원)이 아닙니다. 이 문자열은 상태·cutover 파일에 저장되어 있어
바꾸지 않습니다. 국내 1회 주문 상한 **3,000,000원**, 미국 1회 **3,000달러**,
하루 신규 매수 합산 **4,500,000원**(`DAILY_BUY_CAP_KRW` = 4,500,000원 고정),
최대 5종목이며 체결가/원장 확인이 안 된 경우 신규 매수가 차단될 수 있습니다.

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
- 일일 매수 한도 **4,500,000원**(원화 절대값, 환율에 연동하지 않음)은 국내 매수와 합산.
  국내 1회 주문 상한 **3,000,000원**, 미국 1회 **3,000달러**.
- 미국 체결의 주가·환차 손익은 체결 시점 USD/KRW를 기록해 표시합니다
  (KIS 해외잔고 환율 필드가 있으면 우선, 없으면 공개 시세, 5분 이상 지난 캐시·조회 실패 시 **미확인**).
  주문 한도·비중 환산은 계속 보수적 **1,400원**입니다.

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

## 원격 접속(휴대폰)과 공유 토큰

시작 스크립트는 기본으로 `0.0.0.0`에 바인딩합니다. 아이폰에서 Tailscale로
같은 주소에 접속하려면 이 기본값을 유지하세요. 바꾸지 않습니다.

원격 API를 쓰려면 **직접** `.env.local`에 아래를 넣고 재시작합니다.
실제 IP·호스트명·토큰은 저장소에 넣지 마세요.

```text
DASHBOARD_TOKEN=
DASHBOARD_ALLOWED_DEV_ORIGINS=
```

- `DASHBOARD_TOKEN` — `/api/*` 공유 토큰. Next.js 16 요청 게이트(`src/proxy.ts`,
  기존 middleware)가 `Authorization: Bearer <token>` 또는 화면의 토큰 입력
  (한국어)이 설정하는 HttpOnly 쿠키를 constant-time으로 비교합니다.
- `DASHBOARD_ALLOWED_DEV_ORIGINS` — `next dev`가 원격 브라우저에서 스크립트를
  내려주게 하는 호스트 목록(콤마 구분, 프로토콜 없음). Tailscale IP, MagicDNS
  이름, LAN IP는 **본인 `.env.local`에만** 적습니다.

설정하지 않으면:

- **localhost** 는 기존처럼 열립니다. 화면과 로그에 원격이 보호되지 않는다는
  경고가 뜹니다.
- **원격** `/api/*` 는 `DASHBOARD_TOKEN_REQUIRED` 로 거부됩니다. Host 헤더를
  localhost로 보내는 것만으로는 인증되지 않습니다.
- `POST /api/settings/safety-lock` 과 `POST /api/agent/stop` 은 토큰 없이
  동작합니다(패닉 버튼).
- 키 저장·무장·시작은 토큰과 별도로 PC localhost 검사도 유지합니다.

바인딩 선택:

- **기본 유지:** `npm run dashboard` (`0.0.0.0` + 토큰). 아이폰 브라우저에서
  토큰을 한 번 입력하면 쿠키로 유지됩니다.
- **또는** Tailscale Serve로 HTTPS 앞단을 두고 앱은 localhost만 열 수 있습니다.
  이 경우에도 `DASHBOARD_TOKEN` 을 설정하세요.

토큰과 허용 호스트는 코드나 로그에 출력하지 않습니다.

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

에이전트는 **60초마다** 국내·미국 관심종목을 다시 조회합니다. 추세·돌파 신호는
분봉이 아니라 KIS **완료 일봉**만 사용합니다(`completedBars`가 해당 시장 날짜의
형성 중인 봉을 제외). 1분 루프가 당일 미완료 봉을 신호로 확정하는 것이 아니라,
전일까지 닫힌 일봉 규칙을 매 주기 다시 평가합니다. 같은 완료 일자의 매수 신호는
한 번만 사용합니다. 장중 현재가는 신호 종가 ±2% 괴리 검사와 손절·익절에 씁니다.
매수는 한국 날짜 기준 **하루 4,500,000원**(국내+미국 합산, 원화 절대값)까지이며,
미국 주문 한도·비중 환산은 1 USD=1,400원입니다. 국내 1회는 기준가×수량
**3,000,000원 이하**, 미국 1회 **3,000달러 이하**입니다. 같은 시장·종목의 미체결 주문이나 자동매매 소유
수량이 있으면 중복 매수하지 않습니다. 매도 전에는 KIS 체결조회로 이 앱의
주문번호가 체결됐는지 확인합니다.

## 상태 확인

```bash
curl -H "Authorization: Bearer <DASHBOARD_TOKEN>" http://localhost:3939/api/system/local-health
curl -H "Authorization: Bearer <DASHBOARD_TOKEN>" http://localhost:3939/api/agent/status
curl -H "Authorization: Bearer <DASHBOARD_TOKEN>" http://localhost:3939/api/vts-orders
```

`DASHBOARD_TOKEN` 이 비어 있으면 위 조회는 localhost에서만 됩니다.

실전 서버 호출 여부는 대시보드의 `Real fallback=false`와
`KIS server=VTS`로 확인합니다. 소스 코드의 모든 KIS fetch는
`VTS_BASE_URL`만 사용합니다.

## API

| Method | Path | 역할 |
|---|---|---|
| GET/POST | `/api/auth` | 토큰 필요 여부 조회 / HttpOnly 쿠키 설정 |
| GET | `/api/system/local-health` | 런타임·DB·KIS·안전 상태 |
| GET | `/api/agent/status` | 사이클 카운터·진단·원장 |
| POST | `/api/agent/start` | 무장된 VTS 모의 자동매매 시작 |
| POST | `/api/agent/stop` | 분석 에이전트 중지 (토큰 없이 가능) |
| GET/POST | `/api/kis/save-config` | boolean 상태 조회 / 암호화 저장 |
| POST | `/api/kis/test-connection` | VTS token/price/candle/balance 진단 |
| POST | `/api/settings/safety-lock` | 즉시 SAFE_LOCKED (토큰 없이 가능) |
| POST | `/api/settings/vts-paper-arm` | PREPARE / ARM |
| GET/POST | `/api/system/cleanup-trade-history` | 기록 수 확인 / 제한 cleanup |
| GET/POST | `/api/watchlist` | 관심종목 |
| GET | `/api/vts-orders` | VTS 주문·에이전트 소유 수량·제한 |

ARM 요청:

```bash
curl -X POST http://localhost:3939/api/settings/vts-paper-arm \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer <DASHBOARD_TOKEN>' \
  -d '{"action":"ARM","confirm":"ARM_VTS_AUTO_ONLY"}'
```

Cleanup은 아래 확인문이 정확히 일치할 때 `TradeHistory`와 `AgentLog`만
삭제합니다.

```bash
curl -X POST http://localhost:3939/api/system/cleanup-trade-history \
  -H 'content-type: application/json' \
  -d '{"confirm":"RESET_TRADE_AND_LOG_HISTORY"}'
```

`Position`, VTS 주문, 자동매매 소유 수량, KIS 설정, 안전 설정, 관심종목은
삭제하지 않습니다.

## 연구 데이터 수집 (주문 없음)

점수판·달력 교차검증·위험기여 JSON은 git에 넣지 않는 `.data/`에만 씁니다.

```bash
python3 -m venv .venv-data
.venv-data/bin/pip install -r scripts/requirements-data.txt
.venv-data/bin/python scripts/scorecard-collect.py
```

추가 패키지: `exchange_calendars==4.13.2`(Apache-2.0, 휴장일 대조), `skfolio`(BSD-3-Clause, 위험기여).
주문 게이트는 이 패키지를 쓰지 않습니다. 네트워크 없이 논리 확인:

```bash
.venv-data/bin/python scripts/calendar-crosscheck.py --self-check
.venv-data/bin/python scripts/risk-contribution.py --self-check
```

문서: [점수판](docs/scorecard.md), [거래일 달력](docs/market-calendar.md), [집중도·위험기여](docs/risk-contribution.md).

## 설계 문서

소스 분석, 재사용/폐기 기준, 안전 불변식은
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)에 기록했습니다.
