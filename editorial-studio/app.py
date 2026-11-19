"""
app.py — Editorial Studio 메인 GUI (SPEC 모듈 4, PySide6)

3단 레이아웃: 입력&설정 | 벤치마킹&퀵에딧 | 작업 대기열&안전 발행
비동기: ResearchWorker / WriterWorker / NaverBotWorker (QThread + Signal)
디자인: BG #F8F9FA, Card #FFFFFF, Border #E5E7EB, Accent #FF6B00 (Hover #E55A00)
상태 배지는 색 + 아이콘/텍스트 병행 표기 (접근성).

Run:  python app.py
API 키/계정은 코드에 하드코딩하지 않으며 설정 모달 → .env (로컬)로만 저장됩니다.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
ENV_PATH = BASE_DIR / ".env"

try:
    from dotenv import load_dotenv

    load_dotenv(ENV_PATH)
except ImportError:
    pass

try:
    from PySide6.QtCore import Qt, QThread, Signal
    from PySide6.QtGui import QFont
    from PySide6.QtWidgets import (
        QApplication, QButtonGroup, QDialog, QFileDialog, QFrame, QHBoxLayout,
        QLabel, QLineEdit, QListWidget, QListWidgetItem, QMainWindow,
        QMessageBox, QProgressBar, QPushButton, QRadioButton, QSlider,
        QTextEdit, QVBoxLayout, QWidget,
    )
    HAS_PYSIDE = True
except ImportError:  # GUI not installed yet — give a clear hint instead of a traceback
    HAS_PYSIDE = False

STATUS = {
    "waiting": ("○ 대기", "#6B7280", "#F3F4F6"),
    "running": ("⏳ 진행중", "#B45309", "#FEF3C7"),
    "done": ("✔ 완료", "#047857", "#D1FAE5"),
    "error": ("⚠️ 오류", "#B91C1C", "#FEE2E2"),
}

STYLE = """
QMainWindow, QWidget { background: #F8F9FA; color: #111827; font-family: 'Pretendard', 'Malgun Gothic', sans-serif; }
QFrame#card { background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 12px; }
QLabel#cardTitle { font-size: 13px; font-weight: 700; color: #111827; }
QLabel#hint { font-size: 11px; color: #6B7280; }
QLineEdit, QTextEdit { background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 8px; padding: 8px; selection-background-color: #FFE8D6; }
QLineEdit:focus, QTextEdit:focus { border: 1.5px solid #FF6B00; }
QPushButton#primary { background: #FF6B00; color: white; border: none; border-radius: 8px; padding: 11px; font-weight: 700; }
QPushButton#primary:hover { background: #E55A00; }
QPushButton#primary:disabled { background: #FDBA74; }
QPushButton#outline { background: #FFFFFF; color: #FF6B00; border: 1.5px solid #FF6B00; border-radius: 8px; padding: 10px; font-weight: 700; }
QPushButton#outline:hover { background: #FFF7ED; }
QPushButton#ghost { background: #FFFFFF; color: #374151; border: 1px solid #E5E7EB; border-radius: 8px; padding: 9px; }
QPushButton#ghost:hover { border-color: #FF6B00; color: #FF6B00; }
QFrame#persona { background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 10px; }
QFrame#persona:hover { border-color: #FF6B00; }
QProgressBar { border: 1px solid #E5E7EB; border-radius: 6px; background: #FFFFFF; height: 12px; text-align: center; }
QProgressBar::chunk { background: #FF6B00; border-radius: 5px; }
QListWidget { background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 8px; }
"""

if HAS_PYSIDE:

    def load_config() -> dict:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

    def card(title: str) -> tuple[QFrame, QVBoxLayout]:
        frame = QFrame()
        frame.setObjectName("card")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(8)
        label = QLabel(title)
        label.setObjectName("cardTitle")
        layout.addWidget(label)
        return frame, layout

    def badge(status: str) -> str:
        return STATUS.get(status, STATUS["waiting"])[0]

    # ---- Workers ---------------------------------------------------------
    class ResearchWorker(QThread):
        progress = Signal(str)
        finished_ok = Signal(dict)
        failed = Signal(str)

        def __init__(self, keyword: str):
            super().__init__()
            self.keyword = keyword

        def run(self):
            try:
                from researcher import NaverBlogResearcher

                researcher = NaverBlogResearcher(progress_cb=self.progress.emit)
                self.finished_ok.emit(researcher.research(self.keyword))
            except Exception as exc:  # noqa: BLE001
                self.failed.emit(str(exc))

    class WriterWorker(QThread):
        progress = Signal(str)
        finished_ok = Signal(dict)
        failed = Signal(str)

        def __init__(self, keyword: str, report: dict, persona_key: str, custom: str = ""):
            super().__init__()
            self.keyword, self.report, self.persona_key, self.custom = keyword, report, persona_key, custom

        def run(self):
            try:
                from writer import BlogWriter

                self.progress.emit("AI 초안 생성 중…")
                self.finished_ok.emit(
                    BlogWriter().generate(self.keyword, self.report, self.persona_key, self.custom)
                )
            except Exception as exc:  # noqa: BLE001
                self.failed.emit(str(exc))

    class NaverBotWorker(QThread):
        progress = Signal(str)
        finished_ok = Signal(dict)
        failed = Signal(str)

        def __init__(self, title: str, body: str, dry_run: bool = False):
            super().__init__()
            self.title, self.body = title, body
            self.dry_run = dry_run

        def run(self):
            try:
                from naver_bot import NaverBlogBot

                bot = NaverBlogBot(progress_cb=self.progress.emit, dry_run=self.dry_run)
                self.finished_ok.emit(bot.run(self.title, self.body))
            except Exception as exc:  # noqa: BLE001
                self.failed.emit(str(exc))

    # ---- Settings dialog ---------------------------------------------------
    class SettingsDialog(QDialog):
        """API 키는 이 모달에서만 입력받아 로컬 .env에 저장한다.

        네이버 계정(아이디/비밀번호)은 받지 않는다 — 로그인은 브라우저에서 직접 한다.
        """

        # Legacy keys from earlier builds; dropped from .env on the next save.
        REMOVED_KEYS = ("NAVER_ID", "NAVER_PW")

        def __init__(self, parent=None):
            super().__init__(parent)
            self.setWindowTitle("설정 — API 키")
            self.setMinimumWidth(420)
            layout = QVBoxLayout(self)
            layout.addWidget(QLabel("키는 이 PC의 .env 파일에만 저장되며 코드에 포함되지 않습니다.\n"
                                    "네이버 로그인은 임시저장 시 열리는 브라우저에서 직접 해 주세요."))
            self.fields: dict[str, QLineEdit] = {}
            current = self._read_env()
            for key, label, pw in [
                ("GEMINI_API_KEY", "Gemini API Key", True),
                ("NAVER_CLIENT_ID", "Naver Client ID", False),
                ("NAVER_CLIENT_SECRET", "Naver Client Secret", True),
            ]:
                layout.addWidget(QLabel(label))
                edit = QLineEdit(current.get(key, ""))
                if pw:
                    edit.setEchoMode(QLineEdit.EchoMode.Password)
                layout.addWidget(edit)
                self.fields[key] = edit
            save = QPushButton("저장")
            save.setObjectName("primary")
            save.clicked.connect(self._save)
            layout.addWidget(save)

        @staticmethod
        def _read_env() -> dict:
            data = {}
            if ENV_PATH.exists():
                for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
                    if "=" in line and not line.strip().startswith("#"):
                        k, v = line.split("=", 1)
                        data[k.strip()] = v.strip()
            return data

        def _save(self):
            merged = self._read_env()
            for key in self.REMOVED_KEYS:
                merged.pop(key, None)
                os.environ.pop(key, None)
            for key, edit in self.fields.items():
                merged[key] = edit.text().strip()
                os.environ[key] = merged[key]
            ENV_PATH.write_text(
                "".join(f"{k}={v}\n" for k, v in merged.items()), encoding="utf-8"
            )
            QMessageBox.information(self, "설정", "저장되었습니다. (.env, 로컬 전용)")
            self.accept()

    # ---- Main window -------------------------------------------------------
    class MainWindow(QMainWindow):
        def __init__(self):
            super().__init__()
            self.config = load_config()
            self.report: dict | None = None
            self.reports: dict[str, dict] = {}
            self.workers: list[QThread] = []
            self.setWindowTitle("Editorial Studio — 반자동 AI 편집장")
            self.resize(1240, 780)
            self.setStyleSheet(STYLE)

            root = QWidget()
            self.setCentralWidget(root)
            main = QHBoxLayout(root)
            main.setContentsMargins(14, 14, 14, 14)
            main.setSpacing(12)
            main.addWidget(self._left_panel(), 3)
            main.addWidget(self._center_panel(), 5)
            main.addWidget(self._right_panel(), 3)

        # Left: input & settings
        def _left_panel(self) -> QWidget:
            wrap = QWidget()
            layout = QVBoxLayout(wrap)
            layout.setContentsMargins(0, 0, 0, 0)

            input_card, il = card("주제 입력")
            self.keyword_edit = QLineEdit()
            self.keyword_edit.setPlaceholderText("예) 성수동 맛집 추천")
            il.addWidget(self.keyword_edit)
            self.research_btn = QPushButton("🔍 리서치 시작")
            self.research_btn.setObjectName("outline")
            self.research_btn.clicked.connect(self.on_research)
            il.addWidget(self.research_btn)
            layout.addWidget(input_card)

            persona_card, pl = card("페르소나 선택")
            self.persona_group = QButtonGroup(self)
            self.persona_buttons: dict[str, QRadioButton] = {}
            for i, (key, p) in enumerate(self.config.get("personas", {}).items()):
                frame = QFrame()
                frame.setObjectName("persona")
                fl = QVBoxLayout(frame)
                radio = QRadioButton(f"{p['label']}")
                radio.setFont(QFont("", 10, QFont.Weight.Bold))
                desc = QLabel(p["description"])
                desc.setObjectName("hint")
                desc.setWordWrap(True)
                fl.addWidget(radio)
                fl.addWidget(desc)
                self.persona_group.addButton(radio)
                self.persona_buttons[key] = radio
                if i == 0:
                    radio.setChecked(True)
                pl.addWidget(frame)
            layout.addWidget(persona_card)

            batch_card, bl = card("일괄 작업")
            excel_btn = QPushButton("엑셀(.xlsx) 일괄 업로드")
            excel_btn.setObjectName("ghost")
            excel_btn.clicked.connect(self.on_excel_upload)
            bl.addWidget(excel_btn)
            hint = QLabel("시트 첫 열의 키워드를 대기열에 추가합니다.")
            hint.setObjectName("hint")
            bl.addWidget(hint)
            layout.addWidget(batch_card)

            settings_btn = QPushButton("⚙ API 키 설정")
            settings_btn.setObjectName("ghost")
            settings_btn.clicked.connect(lambda: SettingsDialog(self).exec())
            layout.addWidget(settings_btn)
            layout.addStretch()
            return wrap

        # Center: benchmark & editor
        def _center_panel(self) -> QWidget:
            wrap = QWidget()
            layout = QVBoxLayout(wrap)
            layout.setContentsMargins(0, 0, 0, 0)

            bench_card, bl = card("벤치마킹 요약")
            self.bench_label = QLabel("리서치를 실행하면 평균 글자수·이미지 수·공통 목차·차별화 포인트가 표시됩니다.")
            self.bench_label.setObjectName("hint")
            self.bench_label.setWordWrap(True)
            bl.addWidget(self.bench_label)
            layout.addWidget(bench_card)

            self.write_btn = QPushButton("✨ AI 초안 생성")
            self.write_btn.setObjectName("primary")
            self.write_btn.clicked.connect(self.on_write)
            layout.addWidget(self.write_btn)

            editor_card, el = card("제목 / 본문 편집 — 마지막 20%는 사람이 다듬는 공간")
            self.title_edit = QLineEdit()
            self.title_edit.setPlaceholderText("제목")
            self.body_edit = QTextEdit()
            self.body_edit.setPlaceholderText("AI 초안이 여기에 표시됩니다. 직접 수정할 수 있어요.")
            self.body_edit.textChanged.connect(self._update_count)
            self.count_label = QLabel("0자")
            self.count_label.setObjectName("hint")
            el.addWidget(self.title_edit)
            el.addWidget(self.body_edit, 1)
            el.addWidget(self.count_label)
            layout.addWidget(editor_card, 1)
            return wrap

        # Right: queue & safe publish
        def _right_panel(self) -> QWidget:
            wrap = QWidget()
            layout = QVBoxLayout(wrap)
            layout.setContentsMargins(0, 0, 0, 0)

            queue_card, ql = card("작업 대기열")
            self.queue_list = QListWidget()
            self.queue_list.itemClicked.connect(self._on_queue_click)
            ql.addWidget(self.queue_list)
            layout.addWidget(queue_card, 1)

            publish_card, pl = card("안전 발행")
            mode = QLabel("발행 모드: 임시저장 전용 (자동 발행은 지원하지 않습니다)\n"
                          "로그인이 필요하면 열린 브라우저에서 직접 로그인해 주세요.")
            mode.setObjectName("hint")
            mode.setWordWrap(True)
            pl.addWidget(mode)

            self.save_btn = QPushButton("🚀 네이버 임시저장 실행")
            self.save_btn.setObjectName("primary")
            self.save_btn.clicked.connect(self.on_save_draft)
            pl.addWidget(self.save_btn)

            dry = QPushButton("브라우저 없이 테스트 (dry-run)")
            dry.setObjectName("ghost")
            dry.clicked.connect(lambda: self.on_save_draft(dry_run=True))
            pl.addWidget(dry)
            layout.addWidget(publish_card)

            self.log_label = QLabel("대기 중")
            self.log_label.setObjectName("hint")
            self.log_label.setWordWrap(True)
            layout.addWidget(self.log_label)
            self.progress = QProgressBar()
            self.progress.setRange(0, 100)
            self.progress.setValue(0)
            layout.addWidget(self.progress)
            return wrap

        # ---- actions -----------------------------------------------------
        def _persona_key(self) -> str:
            for key, btn in self.persona_buttons.items():
                if btn.isChecked():
                    return key
            return "trend_editor"

        def _set_log(self, msg: str, progress: int | None = None):
            self.log_label.setText(msg)
            if progress is not None:
                self.progress.setValue(progress)

        def _track(self, worker: QThread):
            self.workers.append(worker)
            worker.finished.connect(lambda: self.workers.remove(worker) if worker in self.workers else None)

        def _add_queue_item(self, keyword: str, status: str = "waiting"):
            item = QListWidgetItem(f"{badge(status)}  {keyword}")
            item.setData(Qt.ItemDataRole.UserRole, {"keyword": keyword, "status": status})
            self.queue_list.addItem(item)

        def _set_queue_status(self, keyword: str, status: str):
            for i in range(self.queue_list.count()):
                item = self.queue_list.item(i)
                data = item.data(Qt.ItemDataRole.UserRole) or {}
                if data.get("keyword") == keyword:
                    data["status"] = status
                    item.setData(Qt.ItemDataRole.UserRole, data)
                    item.setText(f"{badge(status)}  {keyword}")
                    return
            self._add_queue_item(keyword, status)

        def _show_report(self, report: dict):
            fb = " · 폴백 모드" if report.get("fallback_mode") else ""
            self.bench_label.setText(
                f"평균 글자수 {report.get('avg_length', 0):,}자 · 평균 이미지 {report.get('avg_images', 0)}장{fb}\n"
                f"공통 목차: {', '.join(report.get('common_subheadings', [])) or '-'}\n"
                f"핵심 키워드: {', '.join(report.get('core_keywords', [])) or '-'}\n"
                f"차별화 포인트: {' / '.join(report.get('content_gap', [])) or '-'}"
            )

        def report_for(self, keyword: str) -> dict | None:
            """Only a report researched for this exact keyword may be reused."""
            report = self.reports.get(keyword)
            if report is not None:
                return report
            if self.report and self.report.get("keyword") == keyword:
                return self.report
            return None

        def _on_queue_click(self, item: QListWidgetItem):
            data = item.data(Qt.ItemDataRole.UserRole) or {}
            if data.get("keyword"):
                self.keyword_edit.setText(data["keyword"])
                report = self.report_for(data["keyword"])
                if report:
                    self._show_report(report)
                else:
                    self.bench_label.setText("이 키워드는 아직 리서치하지 않았습니다. 먼저 리서치를 실행해 주세요.")

        def on_research(self):
            keyword = self.keyword_edit.text().strip()
            if not keyword:
                QMessageBox.warning(self, "입력 확인", "주제/키워드를 입력해 주세요.")
                return
            self.research_btn.setEnabled(False)
            self._set_queue_status(keyword, "running")
            self._set_log(f"'{keyword}' 리서치 중…", 20)
            worker = ResearchWorker(keyword)
            worker.progress.connect(lambda m: self._set_log(m, 40))
            worker.finished_ok.connect(lambda r: self._on_research_done(keyword, r))
            worker.failed.connect(lambda e: self._on_error(keyword, e))
            self._track(worker)
            worker.start()

        def _on_research_done(self, keyword: str, report: dict):
            report = {**report, "keyword": report.get("keyword") or keyword}
            self.reports[keyword] = report
            self.report = report
            self.research_btn.setEnabled(True)
            self._set_queue_status(keyword, "done")
            # A queued research finishing later must not overwrite the
            # benchmark card for a keyword the user has since switched to.
            if self.keyword_edit.text().strip() == keyword:
                self._show_report(report)
            self._set_log("리서치 완료 — AI 초안을 생성할 수 있습니다.", 60)

        def on_write(self):
            keyword = self.keyword_edit.text().strip()
            if not keyword:
                QMessageBox.warning(self, "입력 확인", "주제/키워드를 입력해 주세요.")
                return
            report = self.report_for(keyword) or {"keyword": keyword, "content_gap": [], "core_keywords": [keyword]}
            self.write_btn.setEnabled(False)
            self._set_log("AI 초안 생성 중…", 75)
            worker = WriterWorker(keyword, report, self._persona_key())
            worker.progress.connect(lambda m: self._set_log(m, 80))
            worker.finished_ok.connect(self._on_write_done)
            worker.failed.connect(lambda e: self._on_error(keyword, e))
            self._track(worker)
            worker.start()

        def _on_write_done(self, draft: dict):
            self.write_btn.setEnabled(True)
            self.title_edit.setText(draft.get("title", ""))
            self.body_edit.setPlainText(draft.get("body", ""))
            if draft.get("tags"):
                self.body_edit.append(f"\n태그: {', '.join(draft['tags'])}")
            self._update_count()
            self._set_log("초안 완성 — 본문을 다듬은 뒤 임시저장하세요.", 90)

        def on_save_draft(self, dry_run: bool = False):
            title, body = self.title_edit.text().strip(), self.body_edit.toPlainText().strip()
            if not title or not body:
                QMessageBox.warning(self, "입력 확인", "제목과 본문을 먼저 작성해 주세요.")
                return
            self.save_btn.setEnabled(False)
            self._set_log("네이버 임시저장 중… (발행은 하지 않습니다)", 95)
            worker = NaverBotWorker(title, body, dry_run=dry_run)
            worker.progress.connect(lambda m: self._set_log(m, 97))
            worker.finished_ok.connect(self._on_save_done)
            worker.failed.connect(lambda e: self._on_error(self.keyword_edit.text(), e))
            self._track(worker)
            worker.start()

        def _on_save_done(self, result: dict):
            self.save_btn.setEnabled(True)
            if result.get("success"):
                self._set_log(f"✔ {result.get('message', '임시저장 완료')}", 100)
                QMessageBox.information(self, "임시저장", result.get("message", "임시저장 완료"))
            else:
                self._set_log(f"⚠️ {result.get('message', '실패')}", 0)
                QMessageBox.warning(self, "임시저장 실패", result.get("message", "실패"))

        def _on_error(self, keyword: str, message: str):
            self.research_btn.setEnabled(True)
            self.write_btn.setEnabled(True)
            self.save_btn.setEnabled(True)
            if keyword:
                self._set_queue_status(keyword, "error")
            self._set_log(f"⚠️ 오류: {message}", 0)

        def _update_count(self):
            self.count_label.setText(f"제목 {len(self.title_edit.text())}자 · 본문 {len(self.body_edit.toPlainText()):,}자")

        def on_excel_upload(self):
            path, _ = QFileDialog.getOpenFileName(self, "엑셀 파일 선택", "", "Excel (*.xlsx *.xls)")
            if not path:
                return
            try:
                keywords: list[str] = []
                try:
                    import pandas as pd

                    df = pd.read_excel(path, header=None)
                    keywords = [str(v).strip() for v in df.iloc[:, 0].tolist() if str(v).strip()]
                except Exception:
                    from openpyxl import load_workbook

                    ws = load_workbook(path, read_only=True).active
                    keywords = [str(r[0].value).strip() for r in ws.iter_rows() if r[0].value]
                for kw in keywords:
                    self._add_queue_item(kw)
                self._set_log(f"엑셀에서 {len(keywords)}개 키워드를 대기열에 추가했습니다.")
            except Exception as exc:  # noqa: BLE001
                QMessageBox.warning(self, "엑셀 오류", str(exc))

    def main():
        app = QApplication(sys.argv)
        app.setFont(QFont("Pretendard", 10))
        window = MainWindow()
        window.show()
        sys.exit(app.exec())

else:

    def main():  # type: ignore[no-redef]
        print("PySide6가 설치되어 있지 않습니다. 먼저 실행하세요:\n  pip install -r requirements.txt")
        sys.exit(1)


if __name__ == "__main__":
    if not HAS_PYSIDE:
        # Import-level smoke test so the module is verifiable without a display.
        print("[⚠️ PySide6 미설치] app.py 구조 로드 OK — GUI 실행 전 `pip install -r requirements.txt` 필요")
        print(f"[✔ config check] personas/config 존재: {CONFIG_PATH.exists()}")
    else:
        main()
