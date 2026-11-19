"""
naver_bot.py — 네이버 안전 임시저장 봇 (SPEC 모듈 3)

- 모든 셀렉터는 config.json에서 참조 (DOM 변경 대응)
- 로그인은 pyperclip + 붙여넣기로 send_keys 매크로 감지 회피
- 휴먼 타이핑: typing_delay(기본 0.03) ± noise, 줄바꿈은 Keys.ENTER
- 안전 발행: 자동 '발행' 절대 금지 — '임시저장'만 수행

Credentials come from arguments / .env only. Never hardcoded.
Run standalone:  python naver_bot.py           (dry-run, 브라우저 없음)
                 python naver_bot.py --live    (실제 브라우저, .env 계정 필요)
"""
from __future__ import annotations

import json
import os
import platform
import random
import sys
import time
from pathlib import Path

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
    def _paste_shortcut(self):
        from selenium.webdriver.common.keys import Keys

        return Keys.COMMAND if platform.system() == "Darwin" else Keys.CONTROL

    def _clipboard_paste(self, element, text: str) -> None:
        """pyperclip + Ctrl/Cmd+V — send_keys 직접 입력 감지 회피.

        The previous clipboard value is restored in a finally block so a
        credential (login password) never lingers in the system clipboard,
        clipboard history, or sync services after the paste.
        """
        import pyperclip
        from selenium.webdriver.common.action_chains import ActionChains
        from selenium.webdriver.common.keys import Keys

        try:
            previous = pyperclip.paste()
        except Exception:  # noqa: BLE001 - clipboard may be empty/unavailable
            previous = None
        try:
            pyperclip.copy(text)
            element.click()
            ActionChains(self.driver).key_down(self._paste_shortcut()).send_keys("v") \
                .key_up(self._paste_shortcut()).perform()
            time.sleep(float(self.tcfg.get("paste_delay", 0.6)))
        finally:
            try:
                pyperclip.copy(previous if previous is not None else "")
            except Exception:  # noqa: BLE001,S110
                pass

    def human_type(self, element, text: str) -> None:
        """한 글자씩, 설정 지연 ± 노이즈로 입력. 줄바꿈은 Enter 키."""
        from selenium.webdriver.common.keys import Keys

        element.click()
        base = float(self.tcfg.get("typing_delay", 0.03))
        noise = float(self.tcfg.get("typing_noise", 0.01))
        for paragraph in text.split("\n"):
            for ch in paragraph:
                element.send_keys(ch)
                time.sleep(max(0.005, base + random.uniform(-noise, noise)))
            element.send_keys(Keys.ENTER)

    def set_typing_delay(self, delay: float) -> None:
        lo = float(self.tcfg.get("typing_delay_min", 0.02))
        hi = float(self.tcfg.get("typing_delay_max", 0.06))
        self.tcfg["typing_delay"] = min(hi, max(lo, delay))

    # ---- browser steps ---------------------------------------------------
    def _start_driver(self):
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        from webdriver_manager.chrome import ChromeDriverManager

        options = Options()
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        self.driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
        return self.driver

    def _is_logged_in(self) -> bool:
        """Authenticated once we leave the NID login domain / login form."""
        try:
            url = self.driver.current_url or ""
            if "nid.naver.com" in url or "nidlogin" in url:
                return False
            from selenium.webdriver.common.by import By

            return not self.driver.find_elements(By.CSS_SELECTOR, self.selectors["login_pw"])
        except Exception:  # noqa: BLE001
            return False

    def _wait_for_login(self) -> None:
        """Poll for authentication, pausing for manual CAPTCHA completion.

        Raises TimeoutError instead of proceeding to the editor unauthenticated.
        """
        timeout = int(self.ncfg.get("login_wait_seconds", 120))
        deadline = time.monotonic() + timeout
        announced = False
        while time.monotonic() < deadline:
            if self._is_logged_in():
                self.progress_cb("로그인 확인 완료")
                return
            if not announced:
                announced = True
                self.progress_cb(
                    f"로그인 확인 대기 중 — 캡차/추가 인증이 뜨면 브라우저에서 직접 완료해 주세요. "
                    f"최대 {timeout}초 동안 기다립니다."
                )
            time.sleep(1.0)
        raise TimeoutError(
            f"{timeout}초 안에 로그인이 확인되지 않았습니다. 브라우저에서 인증을 완료한 뒤 다시 실행해 주세요."
        )

    def login(self, naver_id: str, naver_pw: str) -> None:
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait

        wait = WebDriverWait(self.driver, 15)
        self.driver.get(self.ncfg.get("login_url", "https://nid.naver.com/nidlogin.login"))
        id_el = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, self.selectors["login_id"])))
        self._clipboard_paste(id_el, naver_id)
        pw_el = self.driver.find_element(By.CSS_SELECTOR, self.selectors["login_pw"])
        self._clipboard_paste(pw_el, naver_pw)
        self.driver.find_element(By.CSS_SELECTOR, self.selectors["login_button"]).click()
        self._wait_for_login()

    def open_editor_and_prepare(self) -> None:
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait

        wait_seconds = int(self.ncfg.get("frame_wait_seconds", 15))
        wait = WebDriverWait(self.driver, wait_seconds)
        self.driver.get(self.ncfg.get("write_url", "https://blog.naver.com/GoBlogWrite.naver"))
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

    def save_draft(self, title: str, body: str) -> dict:
        """임시저장만 수행한다. 발행 버튼은 절대 누르지 않는다."""
        if self.dry_run:
            typed = sum(len(p) for p in body.splitlines())
            self.progress_cb(f"[dry-run] 제목 입력 → 본문 {typed}자 휴먼 타이핑 → 임시저장 (시뮬레이션)")
            return {"success": True, "message": "임시저장 완료 (dry-run)"}
        if not title.strip() or not body.strip():
            return {"success": False, "message": "제목과 본문을 먼저 작성해 주세요."}
        try:
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support import expected_conditions as EC
            from selenium.webdriver.support.ui import WebDriverWait

            wait = WebDriverWait(self.driver, 15)
            title_el = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, self.selectors["title_textarea"])))
            self.human_type(title_el, title)
            body_el = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, self.selectors["body_textarea"])))
            self.human_type(body_el, body)

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
            save_btn.click()
            self.progress_cb("임시저장 버튼 클릭 — 저장 확인 대기 중…")
            # A click is not a save: only report success once Naver shows the
            # persisted-state indicator, otherwise the user could close the
            # retained browser and lose the article.
            toast_selector = self.selectors.get("saved_toast", ".toast, .se-toast, [class*='toast']")
            confirm_timeout = int(self.ncfg.get("save_confirm_timeout_seconds", 10))
            try:
                toast = WebDriverWait(self.driver, confirm_timeout).until(
                    EC.visibility_of_element_located((By.CSS_SELECTOR, toast_selector))
                )
                self.progress_cb(f"임시저장 확인: {(toast.text or '').strip()[:60]}")
                return {"success": True, "message": "임시저장 완료"}
            except Exception:  # noqa: BLE001
                return {
                    "success": False,
                    "message": "임시저장 확인에 실패했습니다. 브라우저에서 저장 상태를 직접 확인해 주세요. (브라우저는 닫지 않았습니다)",
                }
        except Exception as exc:  # noqa: BLE001
            return {"success": False, "message": f"임시저장 실패: {exc}"}

    def run(self, title: str, body: str, naver_id: str = "", naver_pw: str = "") -> dict:
        if self.dry_run:
            return self.save_draft(title, body)
        naver_id = naver_id or os.getenv("NAVER_ID", "")
        naver_pw = naver_pw or os.getenv("NAVER_PW", "")
        if not naver_id or not naver_pw:
            return {"success": False, "message": "네이버 계정이 없습니다. 설정에서 입력해 주세요."}
        try:
            self._start_driver()
            self.login(naver_id, naver_pw)
            self.open_editor_and_prepare()
            return self.save_draft(title, body)
        except Exception as exc:  # noqa: BLE001
            return {"success": False, "message": f"봇 실행 실패: {exc}"}
        # NOTE: driver is intentionally left open so the user can review
        # the saved draft in the browser before closing it manually.


if __name__ == "__main__":
    live = "--live" in sys.argv
    bot = NaverBlogBot(dry_run=not live)
    result = bot.run(
        title="Editorial Studio 테스트 제목",
        body="첫 번째 문단입니다.\n두 번째 문단입니다.",
    )
    print(json.dumps(result, ensure_ascii=False))
    assert result["success"], result
    print("[✔ naver_bot test passed]" + ("" if live else " (dry-run — 실제 실행은 --live)"))
