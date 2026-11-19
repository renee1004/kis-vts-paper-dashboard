"""
naver_bot.py — 네이버 임시저장 보조 봇 (SPEC 모듈 3)

- 모든 셀렉터는 config.json에서 참조 (DOM 변경 대응)
- 로그인은 사용자가 브라우저에서 직접 한다. 봇은 아이디/비밀번호를 받지도,
  저장하지도, 입력하지도 않는다. 로그인 상태는 로컬 전용 Chrome 프로필
  (.chrome-profile/, gitignore)에 유지되어 다음 실행부터 재사용된다.
- 자동화 감지 회피(자동화 플래그 숨김, 클립보드 붙여넣기, 무작위 타이핑)는 하지 않는다.
- 안전 발행: 자동 '발행' 절대 금지 — '임시저장'만 수행

Run standalone:  python naver_bot.py           (dry-run, 브라우저 없음)
                 python naver_bot.py --live    (실제 브라우저, 첫 실행 시 직접 로그인)
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROFILE_DIR = BASE_DIR / ".chrome-profile"


def load_config(path: Path | None = None) -> dict:
    return json.loads((path or BASE_DIR / "config.json").read_text(encoding="utf-8"))


def is_save_confirmed(text: str, success_keywords: list[str], failure_keywords: list[str]) -> bool:
    """Toast text counts as a save only if it names success and no failure."""
    t = (text or "").strip().lower()
    if not t:
        return False
    if any(k.lower() in t for k in failure_keywords):
        return False
    return any(k.lower() in t for k in success_keywords)


class NaverBlogBot:
    def __init__(self, config: dict | None = None, progress_cb=None, dry_run: bool = False):
        self.config = config or load_config()
        self.ncfg = self.config.get("naver", {})
        self.selectors: dict = self.ncfg.get("selectors", {})
        self.tcfg = self.config.get("typing", {})
        self.progress_cb = progress_cb or (lambda msg: None)
        self.dry_run = dry_run
        self.driver = None

    # ---- helpers ---------------------------------------------------------
    def type_text(self, element, text: str) -> None:
        """문단 단위로 입력하고 줄바꿈은 Enter 키로 넣는다."""
        from selenium.webdriver.common.keys import Keys

        element.click()
        pause = float(self.tcfg.get("paragraph_delay", 0.3))
        for paragraph in text.split("\n"):
            if paragraph:
                element.send_keys(paragraph)
            element.send_keys(Keys.ENTER)
            time.sleep(pause)

    # ---- browser steps ---------------------------------------------------
    def _start_driver(self):
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        from webdriver_manager.chrome import ChromeDriverManager

        options = Options()
        # Dedicated local profile so the user's own login session persists.
        options.add_argument(f"--user-data-dir={PROFILE_DIR}")
        self.driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
        return self.driver

    def _is_logged_in(self) -> bool:
        """Authenticated once we are off the NID login domain / login form."""
        try:
            url = self.driver.current_url or ""
            if "nid.naver.com" in url or "nidlogin" in url:
                return False
            from selenium.webdriver.common.by import By

            pw_sel = self.selectors.get("login_pw", "#pw")
            return not self.driver.find_elements(By.CSS_SELECTOR, pw_sel)
        except Exception:  # noqa: BLE001
            return False

    def ensure_login(self) -> None:
        """Open the editor; if Naver asks for login, wait for the user to log in manually.

        Raises TimeoutError instead of proceeding unauthenticated.
        """
        self.driver.get(self.ncfg.get("write_url", "https://blog.naver.com/GoBlogWrite.naver"))
        time.sleep(1.0)
        if self._is_logged_in():
            self.progress_cb("기존 로그인 상태 확인")
            return
        timeout = int(self.ncfg.get("login_wait_seconds", 300))
        self.progress_cb(
            f"브라우저에서 네이버 로그인을 직접 완료해 주세요. 최대 {timeout}초 동안 기다립니다. "
            "(다음 실행부터는 로그인 상태가 유지됩니다)"
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._is_logged_in():
                self.progress_cb("로그인 확인 완료")
                return
            time.sleep(1.0)
        raise TimeoutError(
            f"{timeout}초 안에 로그인이 확인되지 않았습니다. 브라우저에서 로그인한 뒤 다시 실행해 주세요."
        )

    def open_editor_and_prepare(self) -> None:
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait

        wait_seconds = int(self.ncfg.get("frame_wait_seconds", 15))
        wait = WebDriverWait(self.driver, wait_seconds)
        write_url = self.ncfg.get("write_url", "https://blog.naver.com/GoBlogWrite.naver")
        if "GoBlogWrite" not in (self.driver.current_url or ""):
            self.driver.get(write_url)
        frame = self.selectors.get("main_frame", self.ncfg.get("main_frame", "#mainFrame"))
        wait.until(EC.frame_to_be_available_and_switch_to_it((By.CSS_SELECTOR, frame)))
        self.progress_cb("#mainFrame 전환 완료")
        self._dismiss_popups()

    def _dismiss_popups(self) -> None:
        from selenium.common.exceptions import NoSuchElementException
        from selenium.webdriver.common.by import By

        for key in ("popup_cancel_button", "help_close_button", "popup_close_button"):
            selector = self.selectors.get(key)
            if not selector:
                continue
            for single in selector.split(","):
                try:
                    el = self.driver.find_element(By.CSS_SELECTOR, single.strip())
                    if el.is_displayed():
                        el.click()
                        self.progress_cb(f"팝업 닫기: {key}")
                        time.sleep(0.5)
                except NoSuchElementException:
                    continue
                except Exception:  # noqa: BLE001
                    continue

    def _visible_toast_texts(self) -> list[str]:
        from selenium.webdriver.common.by import By

        texts = []
        for el in self.driver.find_elements(By.CSS_SELECTOR, self.selectors.get("saved_toast", ".se-toast")):
            try:
                if el.is_displayed():
                    texts.append((el.text or "").strip())
            except Exception:  # noqa: BLE001 - stale element
                continue
        return texts

    def _wait_save_confirmation(self, before: list[str]) -> tuple[bool, str]:
        """Succeed only on a NEW visible toast whose text names success and no failure."""
        success = self.ncfg.get("save_success_keywords", ["저장되었습니다", "저장 완료", "저장했습니다"])
        failure = self.ncfg.get("save_failure_keywords", ["실패", "오류", "에러", "error", "fail"])
        timeout = int(self.ncfg.get("save_confirm_timeout_seconds", 10))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for text in self._visible_toast_texts():
                if text in before:
                    continue
                if any(k.lower() in text.lower() for k in failure):
                    return False, text
                if is_save_confirmed(text, success, failure):
                    return True, text
            time.sleep(0.5)
        return False, ""

    def save_draft(self, title: str, body: str) -> dict:
        """임시저장만 수행한다. 발행 버튼은 절대 누르지 않는다."""
        if self.dry_run:
            typed = sum(len(p) for p in body.splitlines())
            self.progress_cb(f"[dry-run] 제목 입력 → 본문 {typed}자 입력 → 임시저장 (시뮬레이션)")
            return {"success": True, "message": "임시저장 완료 (dry-run)"}
        if not title.strip() or not body.strip():
            return {"success": False, "message": "제목과 본문을 먼저 작성해 주세요."}
        try:
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support import expected_conditions as EC
            from selenium.webdriver.support.ui import WebDriverWait

            wait = WebDriverWait(self.driver, 15)
            title_el = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, self.selectors["title_textarea"])))
            self.type_text(title_el, title)
            body_el = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, self.selectors["body_textarea"])))
            self.type_text(body_el, body)

            save_btn = None
            for selector in self.selectors.get("save_button_fallbacks", [self.selectors.get("save_button", "")]):
                try:
                    save_btn = self.driver.find_element(By.CSS_SELECTOR, selector)
                    if save_btn:
                        break
                except Exception:  # noqa: BLE001
                    continue
            if save_btn is None:
                return {"success": False, "message": "임시저장 버튼을 찾지 못했습니다. config.json 셀렉터를 확인해 주세요."}
            before = self._visible_toast_texts()
            save_btn.click()
            self.progress_cb("임시저장 버튼 클릭 — 저장 확인 대기 중…")
            ok, text = self._wait_save_confirmation(before)
            if ok:
                self.progress_cb(f"임시저장 확인: {text[:60]}")
                return {"success": True, "message": "임시저장 완료"}
            detail = f" (알림: {text[:60]})" if text else ""
            return {
                "success": False,
                "message": "임시저장 확인에 실패했습니다. 브라우저에서 저장 상태를 직접 확인해 주세요."
                           f"{detail} (브라우저는 닫지 않았습니다)",
            }
        except Exception as exc:  # noqa: BLE001
            return {"success": False, "message": f"임시저장 실패: {exc}"}

    def run(self, title: str, body: str) -> dict:
        if self.dry_run:
            return self.save_draft(title, body)
        try:
            self._start_driver()
            self.ensure_login()
            self.open_editor_and_prepare()
            return self.save_draft(title, body)
        except Exception as exc:  # noqa: BLE001
            return {"success": False, "message": f"봇 실행 실패: {exc}"}
        # NOTE: driver is intentionally left open so the user can review
        # the saved draft in the browser before closing it manually.


if __name__ == "__main__":
    ok_kw, bad_kw = ["저장되었습니다"], ["실패", "오류"]
    assert is_save_confirmed("임시저장되었습니다.", ok_kw, bad_kw)
    assert not is_save_confirmed("임시저장에 실패했습니다.", ok_kw, bad_kw)
    assert not is_save_confirmed("저장되었습니다 — 일부 오류", ok_kw, bad_kw)
    assert not is_save_confirmed("맞춤법 검사 완료", ok_kw, bad_kw)
    assert not is_save_confirmed("", ok_kw, bad_kw)
    print("[✔ save-confirmation test passed]")

    live = "--live" in sys.argv
    bot = NaverBlogBot(dry_run=not live)
    result = bot.run(
        title="Editorial Studio 테스트 제목",
        body="첫 번째 문단입니다.\n두 번째 문단입니다.",
    )
    print(json.dumps(result, ensure_ascii=False))
    assert result["success"], result
    print("[✔ naver_bot test passed]" + ("" if live else " (dry-run — 실제 실행은 --live)"))
