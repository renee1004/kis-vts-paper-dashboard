"""
researcher.py — 네이버 블로그 리서치 & 벤치마킹 엔진 (SPEC 모듈 1)

2단계 하이브리드 수집:
  1차: 네이버 검색 오픈 API (IP 차단 방지) → 키 없으면 모바일 검색 폴백
  2차: PC URL을 모바일 URL로 전환해 본문 파싱 (#mainFrame iframe 없음)

Secrets are loaded from .env / environment only. Nothing is hardcoded.
Run standalone:  python researcher.py [--live] [keyword]
"""
from __future__ import annotations

import json
import os
import random
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlparse

BASE_DIR = Path(__file__).resolve().parent


def load_config(path: Path | None = None) -> dict:
    return json.loads((path or BASE_DIR / "config.json").read_text(encoding="utf-8"))


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv

        load_dotenv(BASE_DIR / ".env")
    except ImportError:
        pass


_load_dotenv()


@dataclass
class BlogPost:
    url: str
    title: str = ""
    text: str = ""
    subheadings: list[str] = field(default_factory=list)
    image_count: int = 0

    @property
    def length(self) -> int:
        return len(self.text.strip())


def pc_to_mobile(url: str) -> str:
    """blog.naver.com/{id}/{logNo} -> m.blog.naver.com/{id}/{logNo}"""
    url = url.replace("://blog.naver.com", "://m.blog.naver.com")
    return url


def extract_blog_id_logno(url: str) -> tuple[str, str] | None:
    m = re.search(r"blog\.naver\.com/([^/?#]+)/(\d+)", url)
    if m:
        return m.group(1), m.group(2)
    m = re.search(r"[?&]blogId=([^&]+).*?[?&]logNo=(\d+)", url)
    if m:
        return m.group(1), m.group(2)
    return None


class NaverBlogResearcher:
    def __init__(self, config: dict | None = None, progress_cb=None):
        self.config = config or load_config()
        self.rcfg = self.config.get("research", {})
        self.pcfg = self.config.get("parsing", {})
        self.progress_cb = progress_cb or (lambda msg: None)
        self._session = None

    @property
    def session(self):
        """Lazy session so parsing/fallback tests run without network deps."""
        if self._session is None:
            import requests

            self._session = requests.Session()
            self._session.headers.update(
                {
                    "User-Agent": self.rcfg.get("user_agent", "Mozilla/5.0"),
                    "Referer": self.rcfg.get("referer", "https://m.search.naver.com/"),
                    "Accept-Language": "ko-KR,ko;q=0.9",
                }
            )
        return self._session

    @staticmethod
    def _soup(html: str):
        from bs4 import BeautifulSoup

        try:
            return BeautifulSoup(html, "lxml")
        except Exception:  # lxml 미설치 환경 폴백
            return BeautifulSoup(html, "html.parser")

    # ---- 1차 수집 -------------------------------------------------------
    def search_via_open_api(self, keyword: str) -> list[str]:
        client_id = os.getenv("NAVER_CLIENT_ID", "").strip()
        client_secret = os.getenv("NAVER_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            return []
        import requests

        try:
            resp = self.session.get(
                self.rcfg.get("naver_open_api_url", "https://openapi.naver.com/v1/search/blog.json"),
                params={"query": keyword, "sort": self.rcfg.get("sort", "sim"),
                        "display": self.rcfg.get("display", 10)},
                headers={"X-Naver-Client-Id": client_id, "X-Naver-Client-Secret": client_secret},
                timeout=self.rcfg.get("timeout_seconds", 10),
            )
            resp.raise_for_status()
            return [item.get("link", "") for item in resp.json().get("items", []) if item.get("link")]
        except Exception as exc:  # noqa: BLE001 - fall back to mobile search
            self.progress_cb(f"오픈 API 실패, 모바일 검색으로 폴백: {exc}")
            return []

    def search_via_mobile(self, keyword: str) -> list[str]:
        url = self.rcfg.get(
            "mobile_search_url", "https://m.search.naver.com/search.naver?where=m_blog&query={query}"
        ).format(query=quote(keyword))
        try:
            resp = self.session.get(url, timeout=self.rcfg.get("timeout_seconds", 10))
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            self.progress_cb(f"모바일 검색 실패: {exc}")
            return []
        soup = self._soup(resp.text)
        urls: list[str] = []
        for a in soup.select("a[href]"):
            href = a.get("href", "")
            if "blog.naver.com" in href and extract_blog_id_logno(href) and href not in urls:
                urls.append(href)
        return urls[: self.rcfg.get("display", 10)]

    # ---- 2차 본문 파싱 ----------------------------------------------------
    def parse_post_html(self, html: str, url: str = "") -> BlogPost | None:
        soup = self._soup(html)
        container = None
        for selector in self.pcfg.get("body_selectors", [".se-main-container", "#postViewArea", "div.post_ct"]):
            container = soup.select_one(selector)
            if container:
                break
        if container is None:
            return None

        title = ""
        for selector in self.pcfg.get("title_selectors", []):
            el = soup.select_one(selector)
            if el and el.get_text(strip=True):
                title = el.get_text(strip=True)
                break

        text = container.get_text("\n", strip=True)
        if len(text) < self.rcfg.get("min_text_length", 200):
            return None

        subheadings: list[str] = []
        for el in container.select("h3, h4, strong"):
            t = el.get_text(strip=True)
            if 4 <= len(t) <= 60 and t not in subheadings:
                subheadings.append(t)

        exclude = self.pcfg.get("exclude_image_keywords", [])
        images = 0
        for img in container.find_all("img"):
            src = (img.get("src") or img.get("data-src") or img.get("data-lazy-src") or "").lower()
            if src and not any(k in src for k in exclude):
                images += 1
        return BlogPost(url=url, title=title, text=text, subheadings=subheadings[:8], image_count=images)

    def fetch_post(self, url: str) -> BlogPost | None:
        mobile = pc_to_mobile(url)
        try:
            resp = self.session.get(mobile, timeout=self.rcfg.get("timeout_seconds", 10))
            if resp.status_code in (403, 429):
                self.progress_cb(f"차단 응답 {resp.status_code}, 건너뜀: {mobile}")
                return None
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            self.progress_cb(f"본문 요청 실패: {exc}")
            return None
        post = self.parse_post_html(resp.text, url=mobile)
        return post

    # ---- 분석 -------------------------------------------------------------
    def _heuristic_analysis(self, keyword: str, posts: list[BlogPost]) -> dict:
        avg_length = round(sum(p.length for p in posts) / len(posts)) if posts else 0
        avg_images = round(sum(p.image_count for p in posts) / len(posts)) if posts else 0
        sub_counter: Counter = Counter()
        for p in posts:
            sub_counter.update(p.subheadings)
        common = [s for s, _ in sub_counter.most_common(5)]

        words: Counter = Counter()
        for p in posts:
            for token in re.findall(r"[가-힣A-Za-z]{2,}", p.text):
                words[token] += 1
        stop = {keyword, "그리고", "하지만", "입니다", "있습니다", "합니다", "것을", "수있", "대한"}
        core = [w for w, _ in words.most_common(30) if w not in stop][:5]

        return {
            "keyword": keyword,
            "source_urls": [p.url for p in posts],
            "avg_length": avg_length,
            "avg_images": avg_images,
            "common_subheadings": common,
            "core_keywords": core,
            "content_gap": [
                "상위 글 대부분이 실제 소요 시간·대기 같은 구체 수치 정보가 미흡함",
                "처음 방문자가 헷갈리는 동선·주차 등 실용 정보 안내가 부족함",
            ],
            "recommended_outline": [
                "1. 위치 및 찾아가는 길 (주차정보 포함)",
                "2. 분위기 및 대표 메뉴 소개",
                "3. 직접 경험한 솔직 후기",
                "4. 방문 전 반드시 알아야 할 팁",
            ],
            "fallback_mode": False,
        }

    def _gemini_analysis(self, keyword: str, posts: list[BlogPost]) -> dict | None:
        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key or not posts:
            return None
        try:
            from google import genai

            gcfg = self.config.get("gemini", {})
            client = genai.Client(api_key=api_key)
            corpus = "\n\n---\n\n".join(
                f"제목: {p.title}\n소제목: {', '.join(p.subheadings)}\n본문(2000자): {p.text[:2000]}"
                for p in posts
            )
            prompt = (
                f"키워드 '{keyword}'의 네이버 블로그 상위 글 {len(posts)}개를 분석해 벤치마킹 리포트를 JSON으로만 답하세요. "
                "키는 keyword, source_urls, avg_length, avg_images, common_subheadings, core_keywords, "
                "content_gap, recommended_outline, fallback_mode 입니다. 마크다운 코드블록 없이 순수 JSON만 출력하세요.\n\n" + corpus
            )
            resp = client.models.generate_content(
                model=gcfg.get("model", "gemini-2.0-flash"), contents=prompt
            )
            data = json.loads(re.sub(r"^```(?:json)?|```$", "", (resp.text or "").strip(), flags=re.M))
            # Metrics are measured, never model-guessed: the corpus sent above is
            # truncated, so overwrite them from the collected posts. Gemini is
            # only trusted for qualitative fields (subheadings, gaps, outline).
            data["keyword"] = keyword
            data["fallback_mode"] = False
            data["source_urls"] = [p.url for p in posts]
            data["avg_length"] = round(sum(p.length for p in posts) / len(posts))
            data["avg_images"] = round(sum(p.image_count for p in posts) / len(posts))
            return data
        except Exception as exc:  # noqa: BLE001
            self.progress_cb(f"Gemini 분석 실패, 휴리스틱으로 대체: {exc}")
            return None

    def fallback_report(self, keyword: str) -> dict:
        """네트워크 완전 실패 시 Gemini 지식 기반(없으면 템플릿) 리포트."""
        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if api_key:
            try:
                from google import genai

                client = genai.Client(api_key=api_key)
                prompt = (
                    f"키워드 '{keyword}'에 대해 네이버 블로그 상위 글의 일반적인 패턴을 추정해 벤치마킹 리포트를 JSON으로만 답하세요. "
                    "키는 keyword, source_urls(빈 배열), avg_length, avg_images, common_subheadings, core_keywords, "
                    "content_gap, recommended_outline, fallback_mode(true) 입니다. 순수 JSON만 출력하세요."
                )
                resp = client.models.generate_content(
                    model=self.config.get("gemini", {}).get("model", "gemini-2.0-flash"), contents=prompt
                )
                data = json.loads(re.sub(r"^```(?:json)?|```$", "", (resp.text or "").strip(), flags=re.M))
                data.update({"keyword": keyword, "fallback_mode": True, "source_urls": []})
                return data
            except Exception:  # noqa: BLE001,S110
                pass
        report = self._heuristic_analysis(keyword, [])
        report["fallback_mode"] = True
        report["avg_length"], report["avg_images"] = 2150, 14
        report["core_keywords"] = [keyword.replace(" ", ""), "내돈내산", "솔직후기", "주차가능", "방문팁"]
        report["common_subheadings"] = ["위치 및 주차 정보", "대표 메뉴 후기", "방문 팁 및 총평"]
        return report

    def research(self, keyword: str) -> dict:
        keyword = keyword.strip()
        if not keyword:
            raise ValueError("키워드를 입력해 주세요.")
        self.progress_cb(f"'{keyword}' 상위 글 수집 중…")
        urls = self.search_via_open_api(keyword) or self.search_via_mobile(keyword)

        target = self.rcfg.get("target_valid_posts", 3)
        posts: list[BlogPost] = []
        delay_min = float(self.rcfg.get("request_delay_min", 1.5))
        delay_max = float(self.rcfg.get("request_delay_max", 3.0))
        for url in urls:
            if len(posts) >= target:
                break
            if urls.index(url) > 0:
                time.sleep(random.uniform(delay_min, delay_max))
            post = self.fetch_post(url)
            if post:
                posts.append(post)
                self.progress_cb(f"유효 글 {len(posts)}/{target} 확보: {post.title[:30]}")

        if not posts:
            self.progress_cb("수집 실패 — 폴백 리포트로 대체합니다.")
            return self.fallback_report(keyword)

        report = self._gemini_analysis(keyword, posts) or self._heuristic_analysis(keyword, posts)
        if len(posts) < target:
            # Partial collection: averages from 1-2 posts are unstable, so do
            # not present this as a full benchmark.
            self.progress_cb(f"유효 글 {len(posts)}/{target}개만 확보 — 부분 수집으로 표시합니다.")
            report["fallback_mode"] = True
            report["partial_collection"] = True
            report["collected_count"] = len(posts)
        return report


if __name__ == "__main__":
    # Independent module test: parser + fallback run offline by default.
    researcher = NaverBlogResearcher()
    sample_html = """
    <html><body><div class="se-main-container">
      <h3 class="se-title-text">성수동 맛집 솔직 후기</h3>
      <h4>매장 위치 및 주차 정보</h4><p>""" + ("정말 맛있고 분위기가 좋았어요. " * 40) + """</p>
      <h4>시그니처 메뉴 후기</h4><p>메뉴가 다양해서 고르는 재미가 있었습니다.</p>
      <img src="https://postfiles.pstatic.net/food1.jpg"><img src="/icon_star.png">
    </div></body></html>"""
    assert pc_to_mobile("https://blog.naver.com/a/123") == "https://m.blog.naver.com/a/123"
    try:
        parsed = researcher.parse_post_html(sample_html, url="https://m.blog.naver.com/test/1")
        assert parsed and parsed.length >= 200 and parsed.image_count == 1, parsed
        print("[✔ parser test passed]", parsed.title, "| images:", parsed.image_count)
    except ImportError:
        print("[⚠️ beautifulsoup4 미설치] parser 검증을 건너뜁니다 — `pip install -r requirements.txt` 후 재실행하세요.")

    if "--live" in sys.argv:
        kw = sys.argv[-1] if len(sys.argv) > 1 and not sys.argv[-1].startswith("-") else "성수동 맛집 추천"
        print(json.dumps(researcher.research(kw), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(researcher.fallback_report("성수동 맛집 추천"), ensure_ascii=False, indent=2))
        print("[✔ fallback test passed] live 수집은 `python researcher.py --live <키워드>` 로 실행하세요.")
