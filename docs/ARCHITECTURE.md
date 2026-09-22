# 아키텍처 결정 기록

현재 변경 사항은 [전략 점검 문서](STRATEGY-REVIEW.md)를 참조하세요.
아래는 초기 설계 기록이며, 현재 매매 규칙과 검증 상태는 해당 문서가 우선합니다.

## 분석한 소스

- `Trading_Agent`: private GitHub 인증이 없어 이 실행 환경에서는 직접 읽지 못했다.
- `trading_agent_v1`: KIS 조회·진단·상태 카운터 개념만 참고했다.
- `mock-trade-agent-dev`: 안전 게이트, 잔고 필드 매핑, cleanup 원칙을 참고했다.
- `/tmp/kis-official` 해외주식 LLM 예제: TR ID·endpoint·파라미터 계약.

세 저장소의 파일을 복사하거나 패치를 병합하지 않고 독립 앱으로 작성했다.

## 재사용한 개념

- KIS 응답에서 `rt_cd`, `msg_cd`, `msg1`만 추출하는 진단 구조
- 가격·캔들·잔고를 분리한 성공/실패 카운터
- Position은 KIS 잔고만 원장으로 인정하는 규칙
- TradeHistory와 AgentLog만 지우는 cleanup 계약
- Strategy → Rule → VTS Mock Execution 계층 분리
- 해외주식 VTS TR ID (`VTTT1002U`/`VTTT1001U`, `VTTS3012R`, `VTTS3035R`) 및
  시세 TR (`HHDFS00000300`, `HHDFS76240000`)

## 사용하지 않은 로직

- 실전 서버 URL 및 VTS→실전 fallback
- 실전 TR ID (`TTTT*`, `TTTS*` — `V` 접두 모의 TR만 허용)
- TradeHistory로 Position을 복원하는 코드
- 샘플 체결, 가짜 잔고, 강제 BUY 신호
- 기존 대시보드의 대형 단일 페이지
- 미국 장외·프리/애프터마켓 주문

## 안전 불변식

1. `KisVtsClient`의 서버 주소는 `VTS_BASE_URL` 상수 하나뿐이다.
2. 저장 API는 VTS URL과 정확히 일치하지 않으면 거부한다.
3. 앱 부팅 중 REAL/LIVE/실전 플래그를 발견하면 `REAL_BLOCKED`로 잠근다.
4. 서버를 재시작하면 항상 `SAFE_LOCKED`로 돌아간다. 무장 상태는 영속화하지 않는다.
5. 실전 주문 함수는 transport 없이 `REAL_ORDER_DISABLED`만 throw한다.
6. 국내 KIS 주문은 VTS URL과 `VTTC0011U`/`VTTC0012U`만 사용한다.
7. 미국 KIS 주문은 VTS URL과 `VTTT1002U`(매수)/`VTTT1001U`(매도) **지정가(00)** 만 사용한다.
8. 자동매도 수량은 market+symbol별 `AgentOwnedPosition`을 초과할 수 없다.
   국내는 `VTTC0081R`, 미국은 `VTTS3035R`로 이 앱 주문번호의 체결을 확인한다.
9. 기존 KIS 잔고(국내·해외)는 화면용 Position일 뿐 자동매도 가능 수량으로 사용하지 않는다.
10. 일일 매수 한도(300만 원)는 국내(KRW)와 미국(USD×1,500 보수 환율) 합산이다.
11. 미국 주문은 미국 동부시간(ET) 평일 09:30–16:00 정규장에만 Rule Engine이 허용한다.
    한국시간(KST) 오전 9:30이 아니다. KST는 서머타임에 따라 보통 22:30–05:00 또는 23:30–06:00이다.
12. 키·시크릿·토큰·계좌번호는 API와 로그에 원문·일부 형태로도 반환하지 않는다.

## 데이터 흐름

```text
KIS VTS API
  ├─ token
  ├─ domestic price / candle / balance (VTTC8434R)
  ├─ overseas price (HHDFS00000300) / candle (HHDFS76240000) / balance (VTTS3012R)
  ├─ domestic executions (VTTC0081R) ── 국내 앱 주문 체결 확인
  ├─ overseas executions (VTTS3035R) ── 미국 앱 주문 체결 확인
  ├─ domestic cash order (VTTC0011U/VTTC0012U)
  └─ overseas limit order (VTTT1002U/VTTT1001U, NASD/USD)

Strategy Engine ── Signal (국내 watchlist + US NASDAQ watchlist)
                    │
Rule Engine ────────┤ (시장별 gate + NY regular hours for US)
                    ▼
VTS Mock Execution ── VtsOrder(SUBMITTED/FILLED/BLOCKED, market/currency)
                    └─ AgentOwnedPosition(market+symbol, 앱 체결분만)
```

## 상태 마이그레이션

`.data/state.json`에 `market`/`currency`/`usWatchlist`/`overseasPositions` 필드가
없으면 부팅 시 다음을 적용한다.

- 기존 `watchlist`·`vtsOrders`·`agentOwnedPositions` → `market: DOMESTIC`, `currency: KRW`
- 티커 형식(`AAPL` 등) 주문 → `market: US_NASDAQ`, `currency: USD`, `orderType: LIMIT`
- `usWatchlist` 없음 → AAPL/NVDA/AMD/AMZN/MSFT 기본 목록 생성
- 재시작 시 무장·실행 상태는 여전히 초기화(SAFE_LOCKED)

## 데이터 계층

Prisma 스키마에는 PostgreSQL용 필수 모델을 모두 정의했다. 첫 실행은 별도 DB
없이 확인할 수 있도록 `.data/`의 암호화 로컬 fallback을 사용한다. 민감정보는
AES-256-GCM으로 저장되고 키 파일과 상태 파일은 git에서 제외된다.

현재 런타임 repository는 로컬 fallback이다. PostgreSQL repository 전환은
후속 작업이며, `local-health.database.postgresqlActive=false`로 사실 그대로
표시한다.
