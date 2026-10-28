# 거래일 달력 검토본

휴장일/예정된 거래시간을 `exchange_calendars==4.13.2`의 XKRX 및 XNYS 데이터로 생성한다. 애플리케이션에는 생성된 TypeScript 자료만 포함하므로 Python이나 외부 달력 조회를 런타임 의존성으로 추가하지 않는다.

- 생성: 격리된 Python 환경에 고정 패키지를 설치한 뒤 `python scripts/generate-market-calendar.py`.
- 적용 범위: 2025-01-01 ~ 2026-12-31. 2025년 자료는 10개월 필터의 과거 월말 검증에 사용한다. 범위 밖이면 `MARKET_CALENDAR_UNAVAILABLE`로 주문 보류. 2027년 자동매매를 재개하기 전에 달력 갱신과 검증이 필요하다.
- XNYS는 나스닥 정규 주식장 일정의 대용 자료다. 2026년은 Nasdaq 공식 휴장 10일/조기폐장 2일을 테스트로 대조한다. 선물·옵션·프리마켓/시간외 일정이 아니다.
- 고정 상류 버전에 누락된 2026-06-03(지방선거)와 2026-07-17(제헌절)을 `closureCorrections`로 별도 보정한다. 지방선거일은 상류 최신 소스에도 추가돼 있다. 제헌절 공휴일 지정은 인사혁신처 발표, 양일 시장 휴무는 거래소 공지 재게시/증권사 안내와 대조했다. 상류 버전이 바뀌어도 이 보정 근거를 확인하고 회귀 테스트를 유지한다.
- 국내 2026-11-19는 교육부가 확인한 수능일이다. KRX의 당일 거래시간 공지는 아직 독립 확인하지 못했으므로, 그 날짜는 `unverifiedDates`로 명시하고 UNKNOWN/주문 보류로 둔다. 휴장으로 확정한 뜻이 아니다. 거래시간이 확인되면 이 목록에서 제거하고 정확한 시간 및 출처를 반영한다.
- 휴장과 조기폐장/지연개장은 구분한다. 정상 영업일의 개장 시각은 포함하고 폐장 시각은 제외한다. 미국 날짜는 뉴욕 시간, 국내 날짜는 서울 시간으로 선택한다.
- 정적 달력은 발표 이후 새로 생긴 임시 휴장/거래정지를 즉시 알 수 없다. 새 거래소 공지마다 스냅샷을 갱신해야 한다. 예정된 세션이 열려도 KIS의 실제 주문 접수·체결을 보장하지 않는다.
- `chk-holiday`는 공식 샘플에서 `opnd_yn`와 가급적 하루 한 번 조회를 설명하지만, VTS 지원을 확인하지 못했다. 실전 키/실전 서버 우회를 추가하지 않는다.
- 데이터 출처와 버전, 범위, 양 시장 당일 시간은 status API에 노출한다. 별도 주문전송 기능은 추가하지 않는다.
- `docs/third-party/exchange-calendars-LICENSE.txt`에 상류 Apache-2.0 라이선스를 포함한다.

출처:

- https://github.com/gerrymanoim/exchange_calendars
- https://www.nasdaq.com/market-activity/stock-market-holiday-schedule
- https://www.nasdaqtrader.com/Trader.aspx?id=Calendar
- https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=294&boardSeq=100526&lev=0
- https://raw.githubusercontent.com/gerrymanoim/exchange_calendars/master/exchange_calendars/xkrx_holidays.py
- https://openminister.mpm.go.kr/mpm/comm/newsPress/newsPressRelease/?boardId=bbs_0000000000000029&category=&cntId=4250&mode=view&pageIdx=
- https://stock.mk.co.kr/news/disclosure/template/1029043 (거래소 파생/일반상품 휴장 공지 재게시; 주식 전체 일정의 독립 공식 원본 확인과는 구분)
- https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/chk_holiday/chk_holiday.py

검증 완료 후 원본과 대조해 반영해야 한다. 이 문서만으로 운영 반영 완료를 뜻하지 않는다.
