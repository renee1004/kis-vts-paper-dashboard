# Editorial Studio

네이버 블로그 리서치 · 벤치마킹 · AI 초안 · 안전 임시저장을 하나로 묶은 데스크톱 앱입니다.
"글쓰기 노동의 80%를 1분 만에 끝내고, 마지막 20%의 인사이트만 사람이 다듬는 반자동 AI 편집장 스튜디오"

상세 규격은 [SPEC.md](./SPEC.md)를 참고하세요.

## 빠른 시작

```bash
cd editorial-studio
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # GEMINI_API_KEY / NAVER_CLIENT_ID·SECRET 입력 (없으면 폴백 모드로 동작)
python app.py
```

API 키는 코드에 하드코딩하지 않습니다. GUI의 `⚙ API 키 설정`에서 입력하면 로컬 `.env`에만 저장됩니다.
네이버 아이디·비밀번호는 앱에 입력하지 않습니다. 임시저장 시 열리는 브라우저에서 직접 로그인하면, 로그인 상태가 로컬 `.chrome-profile/`에 유지됩니다.

## 모듈 단독 검증

```bash
python researcher.py                    # 파서 + 폴백 리포트 (오프라인)
python researcher.py --live "성수동 맛집 추천"   # 실제 수집 (네트워크 필요)
python writer.py                        # 페르소나 3종 초안 + AI 티 제거 검증
python naver_bot.py                     # dry-run (브라우저 없이 흐름 검증)
python naver_bot.py --live              # 실제 임시저장 (Chrome 필요, 첫 실행 시 직접 로그인)
```

## 동작 원칙

- **리서치**: 네이버 오픈 API 우선 → 모바일 검색 폴백 → 모바일 본문 파싱. 유효 글 3개를 못 모으면 `fallback_mode` 리포트로 대체해 흐름이 끊기지 않습니다.
- **원고**: 마크다운·"서론/본론/결론" 금지, 벤치마킹의 `content_gap`을 본문에 반영, `[이미지 제안: …]` 배치.
- **임시저장**: 자동 발행은 없습니다. 임시저장 버튼까지만 클릭하고, 브라우저는 검토할 수 있도록 열어 둡니다.
- **셀렉터 대응**: 네이버 DOM이 바뀌면 코드가 아니라 `config.json`의 셀렉터만 수정하면 됩니다.
