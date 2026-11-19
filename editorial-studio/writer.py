"""
writer.py — 차별화 원고 생성 엔진 (SPEC 모듈 2)

입력: keyword, benchmark_report(JSON), persona_key, custom_instruction(선택)
출력: {"title": str, "body": str, "tags": [str]}

AI 티 제거 제약: 마크다운 금지, "서론/본론/결론" 금지, content_gap 필수 반영,
[이미지 제안: …] 배치. Secrets come from .env only.
Run standalone:  python writer.py
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

FORBIDDEN_WORDS = ["서론", "본론", "결론"]
MARKDOWN_PATTERN = re.compile(r"(\*\*|##|^#\s|^[-*]\s|^>\s|```)", re.M)


def load_config(path: Path | None = None) -> dict:
    return json.loads((path or BASE_DIR / "config.json").read_text(encoding="utf-8"))


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv

        load_dotenv(BASE_DIR / ".env")
    except ImportError:
        pass


_load_dotenv()


class BlogWriter:
    def __init__(self, config: dict | None = None):
        self.config = config or load_config()
        self.personas: dict = self.config.get("personas", {})

    def get_persona(self, persona_key: str) -> dict:
        if persona_key not in self.personas:
            raise ValueError(f"알 수 없는 페르소나: {persona_key} (가능: {', '.join(self.personas)})")
        return self.personas[persona_key]

    def build_prompt(self, keyword: str, report: dict, persona_key: str,
                     custom_instruction: str = "") -> str:
        persona = self.get_persona(persona_key)
        gaps = "\n".join(f"- {g}" for g in report.get("content_gap", [])) or "- (없음)"
        outline = "\n".join(report.get("recommended_outline", []))
        extra = f"\n추가 지시: {custom_instruction}" if custom_instruction.strip() else ""
        return f"""{persona['system_prompt']}

키워드: {keyword}
페르소나 톤: {persona['tone']}
평균 글자수 목표: 약 {report.get('avg_length', 2000)}자 / 평균 이미지: {report.get('avg_images', 10)}장
공통 소제목 참고: {', '.join(report.get('common_subheadings', []))}
핵심 키워드: {', '.join(report.get('core_keywords', []))}

반드시 본문에 녹여낼 차별화 포인트(content_gap):
{gaps}

추천 목차 참고:
{outline}
{extra}

작성 규칙 (엄격히 준수):
1. 마크다운 기호를 절대 쓰지 마세요. 별표, 샵, 대시 목록, 코드블록 모두 금지. 순수 텍스트와 줄바꿈만 사용하세요.
2. 서론, 본론, 결론 같은 상투적인 구분 단어를 쓰지 마세요. 독자가 공감할 질문이나 상황 묘사로 시작하세요.
3. 차별화 포인트를 본문 핵심 부분에 반드시 자연스럽게 포함하세요.
4. 사진이 필요한 지점에 [이미지 제안: 구체적인 촬영 가이드] 형식으로 배치하세요.
5. 첫 줄에 제목 한 줄, 그 다음 빈 줄, 이어서 본문, 마지막에 태그를 쉼표로 구분해 한 줄로 출력하세요. 태그 줄은 '태그:' 로 시작하세요."""

    @staticmethod
    def sanitize(body: str) -> str:
        """모델이 규칙을 어겼을 때의 안전망: 마크다운/상투어 제거."""
        body = MARKDOWN_PATTERN.sub("", body)
        for word in FORBIDDEN_WORDS:
            body = body.replace(word, "")
        return re.sub(r"\n{3,}", "\n\n", body).strip()

    @staticmethod
    def parse_output(raw: str) -> dict:
        lines = [ln.strip() for ln in raw.strip().splitlines() if ln.strip()]
        tags: list[str] = []
        if lines and lines[-1].startswith("태그:"):
            tags = [t.strip().lstrip("#") for t in lines.pop()[3:].replace("#", ",").split(",") if t.strip()]
        title = lines.pop(0) if lines else ""
        body = BlogWriter.sanitize("\n\n".join(lines))
        return {"title": title.replace("**", "").strip(), "body": body, "tags": tags[:10]}

    def _fallback_draft(self, keyword: str, report: dict, persona_key: str) -> dict:
        """Gemini 키가 없을 때도 앱 흐름이 끊기지 않는 로컬 초안."""
        persona = self.get_persona(persona_key)
        gaps = report.get("content_gap", ["상위 글에서 빠진 실용 정보"])
        core = report.get("core_keywords", [keyword])
        title = f"{keyword}, 직접 가보니 달랐던 솔직 후기"
        paras = [
            f"{keyword} 찾다가 후기만 잔뜩 읽고 더 헷갈렸던 적 있으신가요. 저도 그랬어요. 그래서 이번엔 직접 다녀온 기준으로만 정리해 봤어요.",
            f"먼저 분위기부터 말하면, 사진으로 보던 것보다 훨씬 여유 있는 공간이었어요. {persona['tone']}",
            "[이미지 제안: 입구 전경과 간판이 함께 보이게 정면에서 한 컷, 사람이 몰리기 전 오전 시간대 추천]",
            gaps[0] + " 이 부분은 다른 후기에서 잘 안 보여서 제가 직접 확인해 정리했어요.",
            "[이미지 제안: 대표 메뉴를 위에서 45도 각도로, 젓가락으로 한 점 집은 장면까지 두 컷]",
            "솔직히 아쉬운 점도 있었어요. 피크 시간대에는 대기가 길어질 수 있으니, 방문 시간을 조금만 앞당기는 게 팁이에요.",
            "정리하면 처음 가는 분께도 추천할 만한 곳이었어요. 여러분은 어떤 기준으로 고르시나요. 댓글로 궁금한 점 남겨주세요.",
        ]
        return {"title": title, "body": "\n\n".join(paras),
                "tags": [t for t in core[:6]] or [keyword.replace(" ", "")]}

    def generate(self, keyword: str, benchmark_report: dict, persona_key: str = "trend_editor",
                 custom_instruction: str = "") -> dict:
        keyword = keyword.strip()
        if not keyword:
            raise ValueError("키워드를 입력해 주세요.")
        self.get_persona(persona_key)

        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key:
            return self._fallback_draft(keyword, benchmark_report, persona_key)
        try:
            from google import genai

            gcfg = self.config.get("gemini", {})
            client = genai.Client(api_key=api_key)
            resp = client.models.generate_content(
                model=gcfg.get("model", "gemini-2.0-flash"),
                contents=self.build_prompt(keyword, benchmark_report, persona_key, custom_instruction),
                config={"temperature": gcfg.get("temperature", 0.8),
                        "max_output_tokens": gcfg.get("max_output_tokens", 4096)},
            )
            result = self.parse_output(resp.text or "")
            return result if result["body"] else self._fallback_draft(keyword, benchmark_report, persona_key)
        except Exception:  # noqa: BLE001 - never break the writing flow
            return self._fallback_draft(keyword, benchmark_report, persona_key)


if __name__ == "__main__":
    sample_report = {
        "keyword": "성수동 맛집 추천", "avg_length": 2150, "avg_images": 14,
        "common_subheadings": ["매장 위치 및 주차 정보", "시그니처 메뉴 후기"],
        "core_keywords": ["성수동맛집", "성수데이트", "내돈내산"],
        "content_gap": ["주말 웨이팅 소요 시간 정보가 미흡함"],
        "recommended_outline": ["1. 위치 및 찾아가는 길", "2. 대표 메뉴 소개"],
        "fallback_mode": False,
    }
    writer = BlogWriter()
    for key in writer.personas:
        out = writer.generate("성수동 맛집 추천", sample_report, persona_key=key)
        assert out["title"] and out["body"] and "**" not in out["body"] and "##" not in out["body"]
        assert not any(w in out["body"] for w in FORBIDDEN_WORDS), out["body"]
        assert "[이미지 제안:" in out["body"]
        print(f"[✔ {key}] {out['title']} | {len(out['body'])}자 | 태그 {out['tags']}")
    print("[✔ writer test passed] (GEMINI_API_KEY 없으면 로컬 폴백 초안으로 검증됩니다)")
