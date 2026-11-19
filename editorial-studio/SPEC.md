# Editorial Studio — PRD & Technical Spec

> Source: [Google Doc](https://docs.google.com/document/d/1LpYsVFYxtMbCaaIzutUgd9sp5rSxGrOWQhm4GK8vErM/edit?usp=sharing) — "Editorial Studio - Cursor AI 개발 명세서 (PRD & Technical Spec)"
> 네이버 블로그 리서치·벤치마킹·초안 작성·안전 임시저장 통합 데스크톱 애플리케이션

## 1. 프로젝트 개요

- **프로젝트명**: Editorial Studio
- **제품 정의**: 네이버 블로그 리서치, 경쟁 글 벤치마킹, AI 초안 생성, 안전 임시저장을 단일 워크플로우로 통합한 데스크톱 앱
- **핵심 철학**: "글쓰기 노동의 80%를 1분 만에 끝내고, 마지막 20%의 인사이트만 사람이 다듬는 반자동 AI 편집장 스튜디오"

### 개발 원칙

1. **단일 책임 원칙 (SRP)**: 모든 모듈은 기능 단위로 엄격히 파일 분리
2. **보안**: API 키/계정은 하드코딩 금지 — `.env` 및 런타임 GUI 설정으로만 로드
3. **유연한 UI 대응**: 모든 CSS 셀렉터/XPath는 `config.json`으로 외부화
4. **독립적 모듈 검증**: 모든 모듈 하단에 `if __name__ == "__main__":` 테스트 블록

## 2. 기술 스택 & 구조

- 런타임: Python 3.10+ / GUI: `PySide6` / AI: `google-genai` (Gemini)
- 자동화·파싱: `selenium`, `webdriver-manager`, `requests`, `beautifulsoup4`
- 유틸: `pandas`, `openpyxl`, `python-dotenv`

| 파일 | 역할 |
|---|---|
| `app.py` | PySide6 3단 대시보드 GUI + QThread 워커 |
| `researcher.py` | 네이버 상위 글 수집 + Gemini 분석 리포트 |
| `writer.py` | 벤치마킹 + 페르소나 기반 원고 생성 |
| `naver_bot.py` | Selenium 임시저장 (로그인은 사용자가 직접) |
| `config.json` | 셀렉터, 지연시간, 페르소나 프리셋 |
| `.env.example` | 환경변수 템플릿 |
| `requirements.txt` | 의존성 |

## 3. 모듈 1 — `researcher.py`

- **2단계 하이브리드 수집**: 1차 네이버 검색 오픈 API (`sort=sim, display=10`) → 키 없으면 모바일 검색 폴백. 2차 PC URL → 모바일 URL 전환 파싱 (`#mainFrame` 없음)
- **Anti-Blocking**: 최신 Chrome UA + Referer, `requests.Session()` 재사용, 요청 간 `sleep(random.uniform(1.5, 3.0))`, 타임아웃 10초
- **다중 폴백 파싱**: `.se-main-container` → `#postViewArea` → `div.post_ct`. 아이콘/스티커 제외 이미지 카운트. 200자 미만/403/429/비공개 제외, 유효 3개 확보. 전체 실패 시 `fallback_mode: true` + Gemini 지식 기반 리포트
- **출력 스키마**: `keyword, source_urls, avg_length, avg_images, common_subheadings, core_keywords, content_gap, recommended_outline, fallback_mode`

## 4. 모듈 2 — `writer.py`

- 입력: `keyword, benchmark_report, persona_key, custom_instruction?` → 출력: `{title, body, tags}`
- 페르소나: `trend_editor` (2030 트렌드), `pro_marketer` (전문 마케터), `lifestyle_curator` (감성 큐레이터)
- **AI 티 제거**: 마크다운 금지, "서론/본론/결론" 금지, 공감형 도입, `content_gap` 필수 반영, `[이미지 제안: …]` 배치

## 5. 모듈 3 — `naver_bot.py`

- 셀렉터는 `config.json` 참조. 앱은 네이버 아이디·비밀번호를 받거나 저장하지 않는다
- 로그인: 사용자가 봇이 연 브라우저에서 직접 로그인(최대 300초 대기). 세션은 로컬 `.chrome-profile/`(gitignore)에 유지
- 자동화 감지 회피(자동화 플래그 숨김, 클립보드 붙여넣기, 무작위 타이핑)는 하지 않는다
- `GoBlogWrite.naver` → `WebDriverWait(15)` → `#mainFrame` 전환, 팝업 닫기
- 입력: 문단 단위 `send_keys`, 줄바꿈 `Keys.ENTER`
- 저장 확인: 클릭 후 새로 뜬 알림 문구에 성공 키워드가 있고 실패 키워드가 없을 때만 성공 (`config.json`의 `save_success_keywords`/`save_failure_keywords`)
- **안전 발행**: 자동 발행 금지, 임시저장만. 반환 `{"success": true, "message": "임시저장 완료"}`

## 6. 모듈 4 — `app.py` (PySide6)

- 팔레트: BG `#F8F9FA`, Card `#FFFFFF`, Border `#E5E7EB`, Accent `#FF6B00` (Hover `#E55A00`)
- 상태는 색 + 텍스트 배지 병행: `[✔ 완료] [⏳ 진행중] [○ 대기] [⚠️ 오류]`
- 좌: 입력·페르소나·엑셀·설정 / 중: 벤치마킹 카드·AI 생성·에디터(글자수) / 우: 대기열·타이핑 슬라이더·임시저장·진행률
- 비동기: `ResearchWorker`, `WriterWorker`, `NaverBotWorker` (QThread + Signal)

## 7. 실행 가이드

```bash
cd editorial-studio
cp .env.example .env   # 키 입력
pip install -r requirements.txt
python researcher.py   # 모듈 단독 검증
python writer.py
python naver_bot.py    # 기본 dry-run
python app.py          # GUI 실행
```
