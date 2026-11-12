# 거래일 달력 검토본

휴장일/예정된 거래시간을 `exchange_calendars==4.13.2`의 XKRX 및 XNYS 데이터로 생성한다. 애플리케이션에는 생성된 TypeScript 자료만 포함하므로 Python이나 외부 달력 조회를 런타임 의존성으로 추가하지 않는다.

- 생성: 격리된 Python 환경에 고정 패키지를 설치한 뒤 `python scripts/generate-market-calendar.py`.
- 적용 범위: 2025-01-01 ~ 2027-12-31. 2025년 자료는 10개월 필터의 과거 월말 검증에 사용한다. 범위 밖이면 `MARKET_CALENDAR_UNAVAILABLE`로 주문 보류. 2028년 자동매매를 재개하기 전에 달력 갱신과 검증이 필요하다.
- XNYS는 나스닥 정규 주식장 일정의 대용 자료다. 2026년은 Nasdaq 공식 휴장 10일/조기폐장 2일, 2027년은 주말 관측 이동이 있는 휴장(6/18 준틴스 관측, 7/5 독립기념일 관측, 12/24 크리스마스 관측)과 조기폐장 1일(11/26)을 테스트로 대조한다. 선물·옵션·프리마켓/시간외 일정이 아니다.
- 고정 상류 버전에 누락된 휴장을 `closureCorrections`로 별도 보정한다: 2026-06-03(지방선거), 2026-07-17(제헌절), 2027-05-03(노동절 대체공휴일), 2027-07-19(제헌절 대체공휴일). 지방선거일은 상류 최신 소스에도 추가돼 있다. 제헌절 공휴일 지정과 노동절의 공휴일화·토요/일요일 대체공휴일은 같은 인사혁신처 발표(관공서의 공휴일에 관한 규정 개정)를 근거로 한다. 2026-06-03/07-17 시장 휴무는 거래소 공지 재게시/증권사 안내와 대조했다. 상류 버전이 바뀌어도 이 보정 근거를 확인하고 회귀 테스트를 유지한다. 고정 상류 4.13.2는 제헌절을 2007년으로 종료하고 노동절 대체·제헌절 대체를 `manually_added_holidays`에 넣지 않으므로 XKRX는 2027-05-03·2027-07-19를 정규 거래일로 본다. 스냅샷은 2026년과 같이 보정으로 빼되, 교차검증은 그 불일치를 기록한다.
- 국내 2026-11-19와 2027-11-18은 교육부가 확인한 수능일이다. KRX의 당일 거래시간 공지는 아직 독립 확인하지 못했으므로, 그 날짜는 `unverifiedDates`로 명시하고 UNKNOWN/주문 보류로 둔다. 휴장으로 확정한 뜻이 아니다. 거래시간이 확인되면 이 목록에서 제거하고 정확한 시간 및 출처를 반영한다. 고정 상류의 CSAT 지연개장 목록은 2020-12-03이 마지막이라 XKRX는 두 날을 정규 09:00 세션으로 본다.
- 휴장과 조기폐장/지연개장은 구분한다. 정상 영업일의 개장 시각은 포함하고 폐장 시각은 제외한다. 미국 날짜는 뉴욕 시간, 국내 날짜는 서울 시간으로 선택한다.
- 정적 달력은 발표 이후 새로 생긴 임시 휴장/거래정지를 즉시 알 수 없다. 새 거래소 공지마다 스냅샷을 갱신해야 한다. 예정된 세션이 열려도 KIS의 실제 주문 접수·체결을 보장하지 않는다.
- `chk-holiday`는 공식 샘플에서 `opnd_yn`와 가급적 하루 한 번 조회를 설명하지만, VTS 지원을 확인하지 못했다. 실전 키/실전 서버 우회를 추가하지 않는다.
- 데이터 출처와 버전, 범위, 양 시장 당일 시간은 status API에 노출한다. 별도 주문전송 기능은 추가하지 않는다.
- `docs/third-party/exchange-calendars-LICENSE.txt`에 상류 Apache-2.0 라이선스를 포함한다.
- **표시·연구 전용 교차검증:** 수집기 사이드카 `scripts/calendar-crosscheck.py`가 대시보드 스냅샷(거래일/미확인/휴장)을 같은 패키지의 XKRX·XNYS와 과거 30일~이후 90일 구간에서 비교한다. 불일치는 `.data/calendar-crosscheck.json`에 기록되고 점수판·상태 영역에 `calendar mismatch: <date> dashboard=closed, XKRX=open` 형식으로만 경고한다. 패키지 미설치·캘린더 로드 실패는 빈 성공이 아니라 `calendar mismatch: 대조 실패 (미확인)`으로 표시한다. **주문 게이트는 `marketSession` / `isDomesticRegularMarketOpen` / `isUsRegularMarketOpen`을 그대로 쓰며 exchange_calendars로 바꾸지 않는다.**
- `isOpen`은 **지금 정규장 세션 안인지**이지, 그날 거래일 여부가 아니다. 거래일이어도 09:00 전·15:30 이후 KST에는 국내 `isOpen=false`가 맞다. 예: 2026-11-09(월)은 대시보드·XKRX 모두 정규 거래일이며, 장중(예: 10:00 KST) `isOpen=true`, 16:40 KST에는 `isOpen=false`이다.

출처:

- https://github.com/gerrymanoim/exchange_calendars
- https://www.nasdaq.com/market-activity/stock-market-holiday-schedule
- https://www.nasdaqtrader.com/Trader.aspx?id=Calendar
- https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=294&boardSeq=100526&lev=0
- https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=294&boardSeq=103512&lev=0
- https://raw.githubusercontent.com/gerrymanoim/exchange_calendars/master/exchange_calendars/xkrx_holidays.py
- https://openminister.mpm.go.kr/mpm/comm/newsPress/newsPressRelease/?boardId=bbs_0000000000000029&category=&cntId=4250&mode=view&pageIdx=
- https://stock.mk.co.kr/news/disclosure/template/1029043 (거래소 파생/일반상품 휴장 공지 재게시; 주식 전체 일정의 독립 공식 원본 확인과는 구분)
- https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/chk_holiday/chk_holiday.py

검증 완료 후 원본과 대조해 반영해야 한다. 이 문서만으로 운영 반영 완료를 뜻하지 않는다.
