"""End-to-end test: the built extension in real Chromium, fake YouTube and Bilibili
watch pages with a real (seekable) video, and mock Gemini and DashScope (Qwen)
APIs served over TLS on loopback under their real hostnames. Checks what a
screen reader would hear. The English run covers everything; a short second run
with only the Chinese strings checks the Chinese interface.

Run:  npm run build && python3 test/e2e/e2e.py
"""
import json
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "dist"
FIX = Path(__file__).resolve().parent / "fixtures"
OUT = ROOT / "test" / "e2e" / "output"
OUT.mkdir(exist_ok=True)
VIDEO_ID = "abcdefghijk"
WATCH = f"https://www.youtube.com/watch?v={VIDEO_ID}"
BILI_BVID = "BV1xx411c7mD"
BILI_WATCH = f"https://www.bilibili.com/video/{BILI_BVID}/"
# The subtitle file the fake Bilibili player loads (fixtures/bilibili.html); the content script reads the same address.
BILI_SUBTITLE = "https://i0.hdslb.com/bfs/subtitle/170001/dumplings-zh.json"
GEMINI_HOST = "generativelanguage.googleapis.com"
GEMINI = f"https://{GEMINI_HOST}"
DASHSCOPE_HOST = "dashscope.aliyuncs.com"
QWEN_KEY = "qwen-test-key"

REQUESTS = []
# Every address a page in the browser asked for (not the extension's own requests, which the mock logs).
PAGE_REQUESTS = []
FAILURES = []
CURRENT_PAGE = None


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILURES.append(msg)
        if CURRENT_PAGE is not None:
            try:
                print("       log:", [(round(e["vt"], 2), e["text"][:60]) for e in CURRENT_PAGE.evaluate("window.__log")][-6:])
            except Exception:
                pass


def has_key(text, letter):
    """Alt+Shift+<letter> as SceneVoice says it: "Alt+Shift+D", or "Option+Shift+D" on macOS
    (Chrome itself prints "⌥⇧D" there; displayShortcut spells it out for the screen reader)."""
    return any(k in (text or "") for k in (f"Alt+Shift+{letter}", f"Option+Shift+{letter}", f"⌥⇧{letter}"))


def locale_only_copy(tmp, locale):
    """The built extension with only one interface language, as default_locale. Chrome
    picks the interface language from the machine (macOS ignores --lang), so the
    checks force a language by leaving it the only one."""
    ext = Path(tmp) / f"ext-{locale}"
    shutil.copytree(DIST, ext)
    for loc in (ext / "_locales").iterdir():
        if loc.name != locale:
            shutil.rmtree(loc)
    manifest = ext / "manifest.json"
    data = json.loads(manifest.read_text())
    data["default_locale"] = locale
    manifest.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    return ext


def english_only_copy(tmp):
    """The main run reads English text."""
    return locale_only_copy(tmp, "en")


def chinese_only_copy(tmp):
    """The short second run reads 简体中文."""
    return locale_only_copy(tmp, "zh_CN")


# ---------------------------------------------------------------- mock Gemini
def script_for(start):
    if start == 0:
        return {
            "characters": [{"label": "Chef Lin", "description": "woman in a white apron"}],
            "cues": [
                {"start": 1, "gap": 4, "kind": "visual", "priority": 1, "brief": "Chef Lin enters.",
                 "standard": "Chef Lin enters the kitchen in a white apron.",
                 "detailed": "Chef Lin, a woman in a white apron, enters a bright kitchen lined with copper pans."},
                {"start": 6, "gap": 1.5, "kind": "text", "priority": 2, "brief": "Title: Dumplings 101",
                 "standard": "Title card: Dumplings 101", "detailed": "A title card reads: Dumplings 101, episode one."},
                {"start": 12, "gap": 0.5, "kind": "visual", "priority": 1, "brief": "She folds a dumpling.",
                 "standard": "She pinches the dough into pleats, folding a dumpling.",
                 "detailed": "Holding a round wrapper in her left hand, she spoons in filling and pinches the edge into eight neat pleats, then sets the dumpling on a floured tray."},
                {"start": 20, "gap": 8, "kind": "visual", "priority": 3, "brief": "A tray of dumplings.",
                 "standard": "A tray of twenty dumplings sits on the counter.",
                 "detailed": "A wooden tray holds twenty plump dumplings in neat rows on the marble counter."},
            ],
        }
    # Later chunk: timestamps relative to the clip, as the model sometimes does.
    return {
        "characters": [{"label": "Chef Lin"}],
        "cues": [
            {"start": 10, "gap": 5, "kind": "visual", "priority": 1, "brief": "Steam rises.",
             "standard": "Steam rises from the bamboo basket.", "detailed": "Thick steam rises from the bamboo basket as Chef Lin lifts the lid."},
        ],
    }


def qwen_script_for(window):
    """What the mock Qwen says about one stretch of frames (src/shared/frames.js, JSON_SHAPES.script):
    one description just before the stretch ends, so it is still recent when it arrives."""
    start, end = window
    return {
        "videoType": "tutorial",
        "characters": [{"label": "the cook", "description": "person in a white apron"}],
        "cues": [
            {"start": round(max(start, end - 1), 1), "gap": 4, "kind": "visual", "priority": 1, "onScreenText": "", "confidence": "high",
             "brief": "The cook lifts a steamer lid.",
             "standard": "The cook lifts the lid of a bamboo steamer.",
             "detailed": "The cook, in a white apron, lifts the lid of a bamboo steamer and steam rises past the camera."},
        ],
    }


MODELS = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-pro", "text-embedding-004"]
DELAY = {"seconds": 1.0}
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-goog-api-key, authorization", "access-control-allow-methods": "GET, POST, OPTIONS"}
QWEN_PATH = "/compatible-mode/v1/chat/completions"


class Gemini(BaseHTTPRequestHandler):
    """Mock Gemini API, and mock DashScope (Qwen, OpenAI-compatible) under the other
    hostname, served over TLS on the real hostnames via --host-resolver-rules, so
    both extension pages and the content scripts reach them like the real thing.
    Which one answers is decided by the request path (the two APIs share none)."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("content-length", "0")
        self.end_headers()

    def authorized(self):
        if self.headers.get("x-goog-api-key") != "test-key":
            self.reply(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}})
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        if self.path.startswith("/v1beta/models"):
            self.reply(200, {"models": [{"name": f"models/{n}", "displayName": n, "supportedGenerationMethods": ["embedContent"] if "embedding" in n else ["generateContent"]} for n in MODELS]})
        else:
            self.reply(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        if self.path.startswith(QWEN_PATH):
            return self.qwen(body)
        if not self.authorized():
            return
        REQUESTS.append({"host": self.headers.get("host", ""), "path": self.path, "body": body, "origin": self.headers.get("origin", "")})
        time.sleep(DELAY["seconds"])
        video = body["contents"][0]["parts"][0]
        meta = video.get("videoMetadata") or {}
        start = int(float(meta.get("startOffset", "0s").rstrip("s")))
        props = (body.get("generationConfig", {}).get("responseSchema") or {}).get("properties") or {}
        if "answer" in props:
            # A question: the answer, and the moment it is about (seconds of the full video).
            text = json.dumps({"time": start + 18, "confidence": "high", "answer": "A chef holds a finished dumpling up to the camera."})
        elif "cues" in props and "videoType" not in props:
            # A description marked as wrong, described again.
            text = json.dumps({"cues": [{"start": start, "gap": 4, "kind": "visual", "priority": 1, "onScreenText": "", "confidence": "high",
                                         "brief": "Chef Lin waves.", "standard": "Chef Lin waves at the camera.",
                                         "detailed": "Chef Lin, in her white apron, waves at the camera from the kitchen doorway."}]})
        else:
            text = json.dumps(script_for(start))
        try:
            self.reply(200, {"candidates": [{"content": {"parts": [{"text": text}], "role": "model"}, "finishReason": "STOP"}]})
        except Exception:
            pass  # the tab aborted the request (stop / navigation)

    def qwen(self, body):
        """DashScope in OpenAI-compatible mode: the key as a Bearer token, a chat completion back."""
        if self.headers.get("authorization") != f"Bearer {QWEN_KEY}":
            self.reply(401, {"error": {"message": "Incorrect API key provided.", "type": "invalid_request_error", "code": "invalid_api_key"}})
            return
        user = next((m for m in body.get("messages", []) if m.get("role") == "user"), {})
        parts = user.get("content") if isinstance(user.get("content"), list) else [{"type": "text", "text": str(user.get("content", ""))}]
        text = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
        frames = sum(1 for p in parts if p.get("type") == "image_url")
        REQUESTS.append({"host": self.headers.get("host", ""), "path": self.path, "body": body, "origin": self.headers.get("origin", ""), "frames": frames})
        if "Reply with: OK" in text:
            answer = "OK"  # the key test from the settings page
        else:
            time.sleep(DELAY["seconds"])
            m = re.search(r"\(([\d.]+)s to ([\d.]+)s\)", text)
            window = (float(m.group(1)), float(m.group(2))) if m else (0.0, 12.0)
            answer = json.dumps(qwen_script_for(window))
        try:
            self.reply(200, {"id": "chatcmpl-test", "object": "chat.completion", "model": body.get("model", ""),
                             "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}],
                             "usage": {"prompt_tokens": 1200 * max(1, frames), "completion_tokens": 80}})
        except Exception:
            pass  # the tab aborted the request (stop / navigation)


def start_gemini(tmp):
    """Start the mock on a free port with a certificate for both API hostnames."""
    cert, key = Path(tmp) / "cert.pem", Path(tmp) / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
                    "-subj", f"/CN={GEMINI_HOST}", "-addext", f"subjectAltName=DNS:{GEMINI_HOST},DNS:{DASHSCOPE_HOST}"], check=True, capture_output=True)
    class Quiet(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            pass  # a tab closed the connection mid-request (stop, navigation): expected

    server = Quiet(("127.0.0.1", 0), Gemini)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


# ---------------------------------------------------------------- page helpers
LOGGER = """
(() => {
  window.__log = [];
  const seen = new WeakMap();
  const obs = new MutationObserver(() => {
    document.querySelectorAll('[data-scenevoice="live"]').forEach((el) => {
      const text = el.textContent.trim();
      if (text && seen.get(el) !== text) {
        seen.set(el, text);
        const v = document.querySelector('video');
        window.__log.push({ text, vt: v ? v.currentTime : -1, live: el.getAttribute('aria-live'), at: performance.now() });
      } else if (!text) seen.set(el, '');
    });
  });
  const start = () => obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();
"""

AXE = (ROOT / "node_modules" / "axe-core" / "axe.min.js").read_text()


TAB_UNREACHABLE = """() => [...document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')]
  .filter((el) => el.offsetParent !== null && !el.disabled && el.tabIndex < 0 && el.id !== 'main' && !['H1', 'H2'].includes(el.tagName))
  .map((el) => el.id || el.textContent.trim().slice(0, 30) || el.tagName)"""


def settle():
    """After switching the colour scheme: buttons transition their colours (ui.css), and
    axe would otherwise measure contrast half-way between the light and dark values."""
    time.sleep(0.6)


def tab_reachable(page, label):
    missing = page.evaluate(TAB_UNREACHABLE)
    check(not missing, f"{label}: every visible control is in the Tab order ({missing})")


def axe(page, label, context="document"):
    res = page.evaluate(
        f"async () => (await axe.run({context}, {{ runOnly: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice'] }}))"
        ".violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help,"
        " where: v.nodes.slice(0, 4).map(n => n.target.join(' ') + ((n.any[0] || n.all[0] || {}).message ? ': ' + (n.any[0] || n.all[0]).message : ''))}))"
    )
    for v in res:
        print(f"       axe {label}: {v['impact']} {v['id']} x{v['nodes']} — {v['help']}")
        for where in v["where"]:
            print(f"           {where[:160]}")
    check(not res, f"{label}: no accessibility violations (axe, WCAG 2.2 AA and best practice)")
    return res


def log_texts(page):
    return [e["text"] for e in page.evaluate("window.__log")]


def wait_for_log(page, pattern, timeout=30):
    rx = re.compile(pattern, re.I)
    end = time.time() + timeout
    while time.time() < end:
        for e in page.evaluate("window.__log"):
            if rx.search(e["text"]):
                return e
        time.sleep(0.2)
    return None


def wait_until(page, js, timeout=10):
    """Poll a JS function. Works on extension pages, whose CSP blocks wait_for_function."""
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate(js):
            return True
        time.sleep(0.15)
    return False


def find_page(ctx, sw, needle, timeout):
    """Find an open page by URL. Pumps Playwright's event loop, since pages the
    extension opens only show up once events are processed."""
    end = time.time() + timeout
    while time.time() < end:
        sw.evaluate("0")
        for pg in ctx.pages:
            if needle in pg.url:
                return pg
        time.sleep(0.25)
    return None


def video(page, js):
    return page.evaluate(f"(() => {{ const v = document.querySelector('video'); {js} }})()")


def launch(p, tmp, ext, port, profile):
    """Headless Chromium with the extension from `ext` installed fresh (a new profile:
    the install event fires), both model hostnames pointed at the mock, and axe on
    every page. Returns (context, service worker, extension id)."""
    ctx = p.chromium.launch_persistent_context(
        str(Path(tmp) / profile),
        headless=True,
        channel="chromium",
        ignore_https_errors=True,
        args=[
            f"--disable-extensions-except={ext}",
            f"--load-extension={ext}",
            f"--host-resolver-rules=MAP {GEMINI_HOST} 127.0.0.1:{port}, MAP {DASHSCOPE_HOST} 127.0.0.1:{port}",
            "--ignore-certificate-errors",
            # The mock lives on loopback; Chrome 142+ otherwise asks the page for local-network permission.
            "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests",
            "--no-proxy-server",
            "--autoplay-policy=no-user-gesture-required",
        ],
        locale="en-US",
        viewport={"width": 1100, "height": 900},
    )
    ctx.add_init_script(AXE)
    ctx.on("request", lambda r: PAGE_REQUESTS.append(r.url))
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    ext_id = sw.url.split("/")[2]
    print(f"extension {ext_id}")
    return ctx, sw, ext_id


def chinese_run(p, tmp, port):
    """A fresh install with only the Chinese strings: what a listener in China gets on
    the welcome page, the settings page and the popup. Short: the behaviour is the
    same, only the words differ."""
    print("\n[Chinese interface]")
    console_errors = []
    ext = chinese_only_copy(tmp)
    ctx, sw, ext_id = launch(p, tmp, ext, port, "profile-zh")
    wel = find_page(ctx, sw, "welcome.html", 15)
    check(wel is not None, "zh: welcome page opens on install")
    if wel is None:
        wel = ctx.new_page()
        wel.goto(f"chrome-extension://{ext_id}/welcome.html")
    wel.on("console", lambda m: m.type == "error" and console_errors.append(f"welcome: {m.text}"))
    wel.wait_for_load_state()
    check(wel.locator("h1").inner_text() == "欢迎使用 SceneVoice", "zh: welcome page is in Chinese")
    check(wel.evaluate("document.documentElement.lang") == "zh-CN", "zh: the page declares its language as zh-CN")
    check(wait_until(wel, "() => document.activeElement && document.activeElement.id === 'title'", 5), "zh: focus starts on the heading")
    check(wel.inner_text("#sample") == "听一段示例", "zh: the sample button is named in Chinese")
    axe(wel, "zh welcome page")
    tab_reachable(wel, "zh welcome page")
    wel.click("#sample")
    # The sample follows the browser's language (@@ui_locale), so on an English CI machine it stays English.
    check(wait_until(wel, "() => document.getElementById('sampleOut').textContent.length > 10", 3), f"zh: the sample button fills the live region ({wel.inner_text('#sampleOut')[:30]})")
    wel.screenshot(path=str(OUT / "welcome-zh.png"), full_page=True)
    wel.close()

    opt = ctx.new_page()
    opt.on("console", lambda m: m.type == "error" and console_errors.append(f"options: {m.text}"))
    opt.goto(f"chrome-extension://{ext_id}/options.html")
    opt.wait_for_load_state()
    check(opt.inner_text("#h-key") == "1. 连接 AI 模型", "zh: options page is in Chinese")
    check(opt.inner_text("#h-desc") == "2. 口述内容", "zh: section headings are translated")
    axe(opt, "zh options page")
    tab_reachable(opt, "zh options page")
    opt.close()

    pop = ctx.new_page()
    pop.on("console", lambda m: m.type == "error" and console_errors.append(f"popup: {m.text}"))
    pop.set_viewport_size({"width": 380, "height": 900})
    pop.goto(f"chrome-extension://{ext_id}/popup.html")
    pop.wait_for_load_state()
    time.sleep(0.6)
    check(pop.inner_text("#videoHeading") == "当前视频", "zh: popup is in Chinese")
    check("B 站" in pop.inner_text("#videoStatus"), f"zh: popup explains what to do away from a video ({pop.inner_text('#videoStatus')[:40]})")
    check(pop.is_visible("#keyBanner") and pop.inner_text("#setupKey") == "开始设置", "zh: popup shows the setup banner on a fresh install, pointing at the welcome page")
    axe(pop, "zh popup")
    tab_reachable(pop, "zh popup")
    pop.screenshot(path=str(OUT / "popup-zh.png"), full_page=True)
    pop.close()

    noisy = [c for c in console_errors if "favicon" not in c and "Failed to load resource" not in c]
    for c in noisy:
        print("      ", c)
    check(not noisy, "zh: no console errors from the extension")
    ctx.close()


def main():
    global CURRENT_PAGE
    console_errors = []
    with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
        ext = english_only_copy(tmp)
        port = start_gemini(tmp)
        print(f"mock Gemini at {GEMINI} and mock DashScope at https://{DASHSCOPE_HOST} -> 127.0.0.1:{port}")
        ctx, sw, ext_id = launch(p, tmp, ext, port, "profile")

        # Messages to the content script go through the service worker. `nth` picks
        # among the tabs that answer, in tab order; `platform` limits them to one
        # site ('youtube' | 'bilibili'). The extension has no "tabs" permission, so
        # tabs carry no URL here: a site is found by asking each tab what it is.
        def tab_call(msg, nth=0, platform=None):
            return sw.evaluate("""async ([msg, nth, platform]) => {
              const out = [];
              for (const t of await chrome.tabs.query({})) {
                try {
                  if (platform) {
                    const s = await chrome.tabs.sendMessage(t.id, { type: 'sv:tab-state' });
                    if (!s || s.platform !== platform) continue;
                  }
                  const r = await chrome.tabs.sendMessage(t.id, msg);
                  if (r) out.push(r);
                } catch (e) {}
              }
              return out[nth] || null; }""", [msg, nth, platform])

        def tab_action(action, nth=0, platform=None):
            return tab_call({"type": "sv:tab-action", "action": action}, nth, platform)

        def tab_state(nth=0, platform=None):
            return tab_call({"type": "sv:tab-state"}, nth, platform)

        # A keyboard shortcut, as the service worker relays it to the tab after
        # chrome.commands fires (headless Chromium does not turn key presses into
        # extension commands). Commands answer nothing, so the tab is found by site.
        def tab_command(command, platform):
            sw.evaluate("""async ([command, platform]) => {
              for (const t of await chrome.tabs.query({})) {
                try {
                  const s = await chrome.tabs.sendMessage(t.id, { type: 'sv:tab-state' });
                  if (s && s.platform === platform) await chrome.tabs.sendMessage(t.id, { type: 'sv:command', command });
                } catch (e) {}
              } }""", [command, platform])

        # The popup, rendered as a tab, asks for the active tab of its window: bring
        # the video tab to the front first, then load the popup behind it.
        def open_popup(front):
            pg = ctx.new_page()
            pg.on("console", lambda m: m.type == "error" and console_errors.append(f"popup: {m.text}"))
            pg.set_viewport_size({"width": 380, "height": 900})
            pg.goto(f"chrome-extension://{ext_id}/popup.html")
            front.bring_to_front()
            pg.reload()
            pg.wait_for_load_state()
            time.sleep(0.6)
            return pg

        def settings(patch):
            sw.evaluate("""async (patch) => {
              const s = (await chrome.storage.sync.get('settings')).settings || {};
              await chrome.storage.sync.set({ settings: { ...s, ...patch } }); }""", patch)
            time.sleep(0.3)

        def local(patch):
            sw.evaluate("""async (patch) => {
              const l = (await chrome.storage.local.get('local')).local || {};
              await chrome.storage.local.set({ local: { ...l, ...patch } }); }""", patch)

        # ---------------- welcome page: first run
        print("\n[welcome page]")
        wel = find_page(ctx, sw, "welcome.html", 15)
        check(wel is not None, "welcome page opens on install")
        if wel is None:
            wel = ctx.new_page()
            wel.goto(f"chrome-extension://{ext_id}/welcome.html")
        wel.on("console", lambda m: m.type == "error" and console_errors.append(f"welcome: {m.text}"))
        wel.wait_for_load_state()
        check(wait_until(wel, "() => document.activeElement && document.activeElement.id === 'title'", 5), "focus starts on the welcome heading")
        check(wel.locator("h1").inner_text() == "Welcome to SceneVoice", "welcome page is localized")
        check(has_key(wel.inner_text("#shortcutText"), "D"), "step 3 names the real shortcut")
        axe(wel, "welcome page")
        tab_reachable(wel, "welcome page")
        wel.emulate_media(color_scheme="dark"); settle()
        axe(wel, "welcome page (dark)")
        wel.emulate_media(color_scheme="light"); settle()
        check(wel.get_attribute("#sampleOut", "role") == "status" and wel.inner_text("#sampleOut") == "", "the sample's live region is empty until asked")
        before = len(REQUESTS)
        wel.click("#sample")
        # The sample comes in the browser's language (@@ui_locale follows the machine, not the
        # strings on offer): English on CI, the machine's own language elsewhere.
        check(wait_until(wel, "() => /How to repot a plant|怎样给植物换盆|幫植物換盆/.test(document.getElementById('sampleOut').textContent) || (!chrome.i18n.getUILanguage().match(/^(en|zh)/) && document.getElementById('sampleOut').textContent.length > 10)", 3), f"the sample button fills the live region with the first sample description ({wel.inner_text('#sampleOut')[:40]})")
        check(wel.get_attribute("#sampleOut", "aria-live") == "polite", "the sample is read politely, through the screen reader")
        check(len(REQUESTS) == before, "the sample asks no model anything")
        wel.check("input[name=source][value=own]")
        check(wel.is_visible("#ownKey") and wel.is_hidden("#startFree"), "choosing a key of one's own shows the settings link and hides Start free")
        # A Chinese browser is sent to the Qwen key (Gemini needs Google); any other to the Gemini key.
        zh_ui = wel.evaluate("chrome.i18n.getUILanguage()").startswith("zh")
        want_hash, want = ("#qwen", "qwenApiKey") if zh_ui else ("#gemini", "apiKey")
        check((wel.get_attribute("#ownKey", "href") or "").endswith(f"options.html{want_hash}"), f"the own-key link goes to options.html{want_hash}")
        wel.click("#ownKey")
        wel.wait_for_url(f"**/options.html{want_hash}", timeout=10000)
        wel.wait_for_load_state()

        # ---------------- options page, opened from the welcome page
        print("\n[options page]")
        opt = wel
        opt.on("console", lambda m: m.type == "error" and console_errors.append(f"options: {m.text}"))
        check(wait_until(opt, f"() => document.activeElement && document.activeElement.id === '{want}'", 5), f"settings open with focus in the key field the link named ({want})")
        check(opt.locator("h1").inner_text().startswith("SceneVoice"), "options page is localized")
        opt.fill("#apiKey", "wrong-key")
        opt.click("#saveKey")
        check(wait_until(opt, "() => document.querySelector('#keyStatus').className === 'status-bad'", 10), "a wrong key is rejected")
        check("not accepted" in opt.inner_text("#keyStatus"), "a wrong key gives a clear message")
        opt.fill("#apiKey", "test-key")
        opt.click("#saveKey")
        check(wait_until(opt, "() => document.querySelector('#keyStatus').className === 'status-good'", 10), "a valid key is accepted")
        status = opt.inner_text("#keyStatus")
        check("gemini-3.5-flash" in status, f"key test picks the recommended model ({status})")
        check(opt.eval_on_selector("#model", "s => s.value") == "gemini-3.5-flash", "model list shows the recommended model selected")
        check(opt.locator("#model option").count() == 4, "model list hides models that cannot describe video")
        check(opt.locator("#shortcuts tr").count() >= 8, "shortcut table lists all commands")
        check(opt.locator("input[name=density]").count() == 3 and opt.is_checked("input[name=density][value=standard]"), "options page offers the how-much setting with Standard selected")
        check(opt.is_checked("input[data-setting=announceProgress]"), "options page has 'Announce generation progress', on by default")
        # Every command has a default key now: four set by Chrome, eight handled on the page.
        check(opt.locator("#shortcuts kbd").count() == 12, f"all twelve default shortcuts are set (got {opt.locator('#shortcuts kbd').count()})")
        opt.check("input[name=output][value=tts]")
        time.sleep(0.3)
        check(opt.is_visible("#ttsOptions") and not opt.is_visible("#srOptions"), "voice options follow the chosen output")
        opt.check("input[name=output][value=screenreader]")
        # Sliders: dragging must not write to storage on every step.
        before_duck = sw.evaluate("async () => ((await chrome.storage.sync.get('settings')).settings || {}).duckLevel")
        opt.eval_on_selector("#duckLevel", "el => { el.value = '0.6'; el.dispatchEvent(new Event('input', { bubbles: true })); }")
        time.sleep(0.3)
        check(opt.inner_text("#duckOut") == "60%", "slider shows its live value while moving")
        check(sw.evaluate("async () => ((await chrome.storage.sync.get('settings')).settings || {}).duckLevel") == before_duck, "moving a slider does not save yet")
        opt.eval_on_selector("#duckLevel", "el => el.dispatchEvent(new Event('change', { bubbles: true }))")
        time.sleep(0.4)
        check(sw.evaluate("async () => ((await chrome.storage.sync.get('settings')).settings || {}).duckLevel") == 0.6, "releasing the slider saves")
        opt.eval_on_selector("#duckLevel", "el => { el.value = '0.35'; el.dispatchEvent(new Event('change', { bubbles: true })); }")
        opt.locator('summary[data-i18n="opt_advanced"]').click()
        opt.fill("#apiBase", "not a url")
        opt.click("#saveEndpoint")
        check("https://" in opt.inner_text("#keyStatus"), "an invalid API address is rejected with guidance")
        opt.click("#resetEndpoint")
        check(wait_until(opt, "() => document.querySelector('#keyStatus').className === 'status-good'", 10), "resetting the API address re-tests the key")
        axe(opt, "options page")
        tab_reachable(opt, "options page")
        guide = ctx.new_page()
        guide.goto(f"chrome-extension://{ext_id}/guide.html#qwen")
        guide.wait_for_load_state()
        check(wait_until(guide, "() => document.activeElement && document.activeElement.id === 'qwen'", 5), "the key guide opened at #qwen starts at that part")
        axe(guide, "key guide")
        tab_reachable(guide, "key guide")
        guide.close()
        opt.screenshot(path=str(OUT / "options.png"), full_page=True)
        opt.emulate_media(color_scheme="dark"); settle()
        axe(opt, "options page (dark)")
        opt.screenshot(path=str(OUT / "options-dark.png"), full_page=True)
        opt.close()

        # ---------------- popup page (rendered standalone)
        print("\n[popup]")
        pop = ctx.new_page()
        pop.on("console", lambda m: m.type == "error" and console_errors.append(f"popup: {m.text}"))
        pop.set_viewport_size({"width": 380, "height": 900})
        pop.goto(f"chrome-extension://{ext_id}/popup.html")
        pop.wait_for_load_state()
        time.sleep(0.6)
        check(pop.is_hidden("#keyBanner"), "popup hides the setup banner once a key exists")
        check("YouTube" in pop.inner_text("#videoStatus"), "popup explains what to do outside YouTube")
        check(has_key(pop.inner_text("#shortcutHint"), "D"), "popup shows the real shortcuts")
        check(pop.is_hidden("#progressBox") and pop.is_hidden("#stop"), "popup hides the progress bar and Stop when nothing is generating")
        axe(pop, "popup")
        tab_reachable(pop, "popup")
        pop.screenshot(path=str(OUT / "popup.png"), full_page=True)
        pop.emulate_media(color_scheme="dark"); settle()
        axe(pop, "popup (dark)")
        pop.close()

        # ---------------- fake YouTube
        video_bytes = (FIX / "video.webm").read_bytes()

        def serve_video(route):
            # Chromium only allows seeking when the server supports byte ranges.
            m = re.match(r"bytes=(\d+)-(\d*)", route.request.headers.get("range") or "")
            total = len(video_bytes)
            if m:
                a = int(m.group(1))
                b = min(int(m.group(2)) if m.group(2) else total - 1, total - 1)
                route.fulfill(status=206, body=video_bytes[a:b + 1], headers={"content-type": "video/webm", "accept-ranges": "bytes", "content-range": f"bytes {a}-{b}/{total}", "content-length": str(b - a + 1)})
            else:
                route.fulfill(status=200, body=video_bytes, headers={"content-type": "video/webm", "accept-ranges": "bytes", "content-length": str(total)})

        def route_youtube(route):
            url = route.request.url
            if "/__fixture/video.webm" in url:
                serve_video(route)
            elif "/watch" in url:
                route.fulfill(status=200, body=(FIX / "watch.html").read_text(), headers={"content-type": "text/html; charset=utf-8"})
            elif url.rstrip("/") == "https://www.youtube.com":
                route.fulfill(status=200, body="<!doctype html><title>Home</title><p>home", headers={"content-type": "text/html; charset=utf-8"})
            else:
                route.fulfill(status=404, body="")

        ctx.route("https://www.youtube.com/**", route_youtube)

        # Fake Bilibili: the video page, the same video on the page's own origin (a
        # cross-origin video would taint the canvas frames are taken from), and the
        # CC subtitle file on Bilibili's file host, which the page's player "loads".
        subtitle = json.dumps({"font_size": 0.4, "body": [
            {"from": 0.2, "to": 1.6, "location": 2, "content": "大家好，今天包饺子。"},
            {"from": 120, "to": 122, "location": 2, "content": "面团要醒二十分钟。"},
        ]})

        def route_bilibili(route):
            url = route.request.url
            if "/__fixture/video.webm" in url:
                serve_video(route)
            elif "/video/" in url:
                route.fulfill(status=200, body=(FIX / "bilibili.html").read_text(), headers={"content-type": "text/html; charset=utf-8"})
            else:
                route.fulfill(status=404, body="")

        def route_subtitle(route):
            if route.request.url == BILI_SUBTITLE:
                route.fulfill(status=200, body=subtitle, headers={"content-type": "application/json", "access-control-allow-origin": "*"})
            else:
                route.fulfill(status=404, body="")

        ctx.route("https://www.bilibili.com/**", route_bilibili)
        ctx.route("https://i0.hdslb.com/**", route_subtitle)

        def open_watch():
            pg = ctx.new_page()
            pg.on("console", lambda m: m.type == "error" and console_errors.append(f"page: {m.text}"))
            pg.on("pageerror", lambda e: console_errors.append(f"page error: {e}"))
            pg.add_init_script(LOGGER)
            pg.goto(WATCH)
            pg.wait_for_selector("[data-scenevoice=announcer]", state="attached", timeout=10000)
            wait_until(pg, "() => document.querySelector('video').readyState >= 1", 15)
            return pg

        page = open_watch()
        CURRENT_PAGE = page
        print("\n[watch page]")
        check(page.locator(".scenevoice-button").count() == 1, "player gets a SceneVoice button")
        check(page.get_attribute(".scenevoice-button", "aria-pressed") == "true", "button reports its state (aria-pressed)")
        check(has_key(page.get_attribute(".scenevoice-button", "title"), "D"), "button tooltip shows the real shortcut")
        check(round(video(page, "return v.duration;")) == 570, "fake video loaded (9.5 minutes)")

        # First play without descriptions: a hint.
        video(page, "v.play();")
        e = wait_for_log(page, r"No audio description yet", 8)
        check(e is not None and has_key(e["text"], "D"), "first play announces how to create descriptions")
        video(page, "v.pause(); v.currentTime = 0;")

        # ---------------- generation (waits for an ad first)
        print("\n[generation]")
        DELAY["seconds"] = 3.0
        before = len(REQUESTS)
        page.evaluate("document.getElementById('movie_player').classList.add('ad-showing')")
        tab_action("generate")
        check(wait_for_log(page, r"Waiting for the ad", 5) is not None, "generation waits while an ad is showing")
        time.sleep(1.2)
        check(len(REQUESTS) == before, "no request is made during the ad")
        page.evaluate("document.getElementById('movie_player').classList.remove('ad-showing')")
        e = wait_for_log(page, r"SceneVoice is creating descriptions", 5)
        check(e is not None, "announces that generation started once the ad ends")
        check(e is not None and e["text"].startswith("AI-generated audio description follows."), "and says first that the descriptions are made by AI")
        pill = "document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('.progress')"
        check(wait_until(page, f"() => !{pill}.hidden", 3), "a progress bar appears on the player while generating")
        time.sleep(1.0)
        check("1 of 2" in page.evaluate(f"{pill}.textContent"), f"it names the section being worked on ({page.evaluate(f'{pill}.textContent').strip()})")
        check(page.evaluate(f"{pill}.getAttribute('aria-hidden')") == "true", "the visual progress bar is hidden from screen readers (they hear announcements)")
        geo = page.evaluate(f"""() => {{ const b = {pill}.getBoundingClientRect(), p = document.querySelector('#movie_player').getBoundingClientRect();
          return {{ font: parseFloat(getComputedStyle({pill}).fontSize), top: b.top - p.top, bottom: p.bottom - b.bottom, h: p.height }}; }}""")
        check(geo["font"] >= 15, f"progress text is at least 15px ({geo['font']}px)")
        check(geo["top"] > geo["h"] / 2 and geo["bottom"] >= 60, f"progress sits low in the player, above the control bar ({geo})")
        check("%" in page.evaluate(f"{pill}.textContent"), "progress shows a percentage")
        st = tab_state()
        check(st and st["status"] == "generating" and st["total"] == 2 and isinstance(st["percent"], int), f"tab state carries percent and total for the popup ({st and st.get('percent')}%)")
        shown = int(re.search(r"(\d+)%", page.evaluate(f"{pill}.querySelector('.percent').textContent")).group(1))
        check(st and abs(shown - st["percent"]) <= 3, f"the popup gets the percentage the page shows (page {shown}%, popup {st and st['percent']}%)")
        page.evaluate("window.__log = []")
        tab_action("toggle-descriptions")
        e = wait_for_log(page, r"\d+% done, working on section 1 of 2", 4)
        check(e is not None, f"pressing the button during generation reports the percentage ({e and e['text'][:80]})")
        check(not any("Descriptions off" in t for t in log_texts(page)), "and does not switch descriptions off")
        e = wait_for_log(page, r"ready for the first 5 minutes", 15)
        check(e is not None and "(4 so far)" in e["text"], f"announces partial readiness after the first chunk, with the count ({e and e['text'][:60]})")
        check(e is not None and e["text"].startswith("You can start watching"), "the first-minutes message says you can start watching")
        e = wait_for_log(page, r"Descriptions ready: 5 in total", 20)
        check(e is not None, "announces completion with the count")
        check(e is not None and has_key(e["text"], "S"), "completion message teaches the describe-now shortcut")
        gen = REQUESTS[before:]
        check(len(gen) == 2, f"two chunk requests for a 9.5-minute video (got {len(gen)})")
        if len(gen) == 2:
            first, second = gen[0]["body"], gen[1]["body"]
            check(gen[0]["origin"].startswith("chrome-extension://"), f"requests come from the extension's offscreen document, not the YouTube page ({gen[0]['origin'][:30]})")
            check(gen[0]["path"].startswith("/v1beta/models/gemini-3.5-flash:generateContent"), "uses the selected model")
            check(first["contents"][0]["parts"][0]["videoMetadata"] == {"startOffset": "0s", "endOffset": "300s", "fps": 0.5}, "chunk 1 covers 0–300s at half a frame a second")
            meta2 = second["contents"][0]["parts"][0]["videoMetadata"]
            check(meta2 == {"startOffset": "300s", "endOffset": "571s", "fps": 0.5}, f"chunk 2 covers 300s to the end ({meta2})")
            check("Chef Lin (woman in a white apron)" in second["contents"][0]["parts"][1]["text"], "chunk 2 is told about people found in chunk 1")
            check("Dumplings 101 with Chef Lin" in first["contents"][0]["parts"][1]["text"], "page title is sent as context")
            check(first["contents"][0]["parts"][0]["fileData"]["fileUri"] == WATCH, "the video is passed by YouTube URL")
            check(first["generationConfig"]["maxOutputTokens"] == 32768, "output limit matches the model generation")
            check(first["generationConfig"].get("thinkingConfig") == {"thinkingLevel": "low"}, "Gemini 3 gets a low thinking level")
            check("temperature" not in first["generationConfig"], "Gemini 3 keeps its default temperature")
        st = tab_state()
        check(st and st["status"] == "ready" and st["cueCount"] == 5 and st["complete"], f"tab state is ready ({st and st['status']})")
        check(page.evaluate(f"{pill}.hidden"), "the progress bar disappears when generation finishes")
        DELAY["seconds"] = 1.0

        # ---------------- playback in "keep playing" mode
        print("\n[playback: keep playing]")
        page.evaluate("window.__log = []")
        video(page, "v.currentTime = 0; v.play();")
        e1 = wait_for_log(page, r"Chef Lin enters the kitchen in a white apron", 8)
        check(e1 is not None, "cue at 0:01 spoken (standard length fits the 4 s pause)")
        if e1:
            check(0.9 <= e1["vt"] <= 1.8, f"spoken on time (video at {e1['vt']:.2f}s)")
            check(e1["live"] == "polite", "scheduled descriptions are polite by default")
        e2 = wait_for_log(page, r"Dumplings 101", 10)
        check(e2 is not None, "on-screen text cue read")
        vol = video(page, "return v.volume;")
        check(vol < 0.6, f"video volume ducked while describing ({vol})")
        time.sleep(1.2)
        check(video(page, "return v.volume;") > 0.95, "volume restored afterwards")
        # The 0.5 s gap at 0:12 is too short even for the brief version: skipped, not spoken over dialogue.
        check(wait_until(page, "() => document.querySelector('video').currentTime > 13.5", 12), "playback passes 0:13")
        check(not any("folds a dumpling" in t for t in log_texts(page)), "tight 0.5 s gap: description skipped rather than talking over dialogue")

        # Density: the priority-3 "tray" cue at 0:20 is skipped at the default, spoken on "everything".
        page.evaluate("window.__log = []")
        video(page, "v.currentTime = 18.5;")
        time.sleep(2.6)
        check(not any("tray" in t for t in log_texts(page)), "standard density skips atmosphere-only (priority 3) descriptions")
        settings({"density": "full"})
        page.evaluate("window.__log = []")
        video(page, "v.currentTime = 18.5;")
        e = wait_for_log(page, r"tray of twenty dumplings", 5)
        check(e is not None, "'everything' speaks priority-3 descriptions too")
        settings({"density": "standard"})

        # Seek into chunk 2: relative timestamps were converted (10 s -> 310 s).
        video(page, "v.currentTime = 307;")
        e4 = wait_for_log(page, r"Steam rises", 10)
        check(e4 is not None and 309.8 <= e4["vt"] <= 311, f"chunk-2 cue fires at 5:10 ({e4 and round(e4['vt'], 2)})")

        # Seeking past cues does not replay a backlog.
        page.evaluate("window.__log = []")
        video(page, "v.currentTime = 30;")
        time.sleep(1.5)
        check(not any("Chef Lin" in t or "tray" in t for t in log_texts(page)), "no flood of old descriptions after a seek")

        # 2x playback: the 4 s gap at 0:01 is only 2 s of real time, so the brief version is used.
        settings({"readerSpeed": 1})
        page.evaluate("window.__log = []")
        video(page, "v.pause(); v.playbackRate = 2; v.currentTime = 0.2; v.play();")
        e = wait_for_log(page, r"Chef Lin enters", 6)
        check(e is not None and e["text"] == "Chef Lin enters.", f"at 2x speed a shorter description is chosen ({e and e['text']})")
        video(page, "v.pause(); v.playbackRate = 1;")
        settings({"readerSpeed": 1.6})

        # ---------------- pause mode
        print("\n[playback: pause mode]")
        settings({"mode": "pause", "detail": "detailed"})
        page.evaluate("window.__log = []")
        video(page, "v.currentTime = 10.5; v.play();")
        e = wait_for_log(page, r"eight neat pleats", 6)
        check(e is not None, "pause mode speaks the detailed description")
        time.sleep(0.4)
        check(video(page, "return v.paused;"), "video paused while the long description is read")
        # Describe-now while we hold the video paused must not strand it.
        tab_action("describe-now")
        check(wait_until(page, "() => !document.querySelector('video').paused", 25), "video resumes on its own after the descriptions")
        settings({"mode": "gaps", "detail": "standard"})

        # ---------------- describe now and repeat
        print("\n[describe now / repeat / ask]")
        video(page, "v.pause(); v.currentTime = 2.5;")
        time.sleep(0.4)
        page.evaluate("window.__log = []")
        tab_action("describe-now")
        e = wait_for_log(page, r"Chef Lin enters", 4)
        check(e is not None and e["live"] == "assertive", "describe-now speaks the current cue at once (assertive)")
        before = len(REQUESTS)
        video(page, "v.currentTime = 200;")
        time.sleep(0.4)
        tab_action("describe-now")
        e = wait_for_log(page, r"holds a finished dumpling", 10)
        check(e is not None, "describe-now asks Gemini when no cue is near")
        check(e is not None and e["text"].startswith("At 3:18: "), f"the answer says which moment it is about ({e and e['text'][:30]})")
        if len(REQUESTS) > before:
            meta = REQUESTS[-1]["body"]["contents"][0]["parts"][0]["videoMetadata"]
            check(meta == {"startOffset": "180s", "endOffset": "204s"}, f"question uses a short clip around the moment ({meta})")
            schema = REQUESTS[-1]["body"]["generationConfig"].get("responseSchema") or {}
            check(schema.get("propertyOrdering") == ["time", "confidence", "answer"], "questions ask for the moment and how sure Gemini is")
        page.evaluate("window.__log = []")
        tab_action("repeat-last")
        check(wait_for_log(page, r"holds a finished dumpling", 4) is not None, "repeat-last repeats")

        # During an ad, describe-now refuses politely instead of describing the ad.
        page.evaluate("document.getElementById('movie_player').classList.add('ad-showing')")
        page.evaluate("window.__log = []")
        before = len(REQUESTS)
        tab_action("describe-now")
        check(wait_for_log(page, r"An ad is playing", 4) is not None and len(REQUESTS) == before, "describe-now during an ad says so and asks nothing")
        page.evaluate("document.getElementById('movie_player').classList.remove('ad-showing')")

        # Ask dialog
        video(page, "v.play();")
        time.sleep(0.3)
        tab_action("ask-question")
        time.sleep(0.5)
        dlg = page.locator("[data-scenevoice=ui] dialog")
        check(dlg.count() == 1 and dlg.is_visible(), "ask dialog opens")
        check(video(page, "return v.paused;"), "video pauses while asking")
        check(page.evaluate("document.activeElement?.shadowRoot?.activeElement?.tagName") == "TEXTAREA", "focus moves into the question field")
        check(page.evaluate("document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('.answer').getAttribute('aria-live')") == "polite", "answer region exists before the first answer")
        axe(page, "ask dialog", "document.querySelector('[data-scenevoice=ui]').shadowRoot")
        page.emulate_media(color_scheme="dark"); settle()
        axe(page, "ask dialog (dark)", "document.querySelector('[data-scenevoice=ui]').shadowRoot")
        page.emulate_media(color_scheme="light"); settle()
        page.keyboard.type("What is she holding?")
        check(video(page, "return v.paused;"), "typing letters like k or j does not trigger YouTube shortcuts")
        page.keyboard.press("Enter")
        check(wait_until(page, "() => document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('.answer').textContent.includes('dumpling')", 10), "answer appears in the dialog's live region")
        q = REQUESTS[-1]["body"]["contents"][0]["parts"][1]["text"]
        check("What is she holding?" in q, "the typed question is sent")
        jump = "document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('[data-act=jump]')"
        check(page.evaluate(f"!{jump}.hidden && {jump}.textContent.startsWith('Go to ')"), "the answer offers to go to its moment")
        page.screenshot(path=str(OUT / "ask-dialog.png"))
        page.keyboard.press("Escape")
        time.sleep(0.5)
        check(dlg.count() == 0, "Escape closes the dialog")
        check(not video(page, "return v.paused;"), "video resumes after closing the dialog")

        # ---------------- a description marked as wrong
        print("\n[description is wrong]")
        video(page, "v.pause(); v.currentTime = 2.5;")
        time.sleep(0.4)
        tab_action("describe-now")
        check(wait_for_log(page, r"Chef Lin enters", 4) is not None, "the description at 0:01 is heard")
        page.evaluate("window.__log = []")
        before = len(REQUESTS)
        tab_action("report-wrong")
        check(wait_for_log(page, r"Marked the description at 0:01 as wrong", 4) is not None, "marking it says at once which one is marked")
        check(wait_for_log(page, r"Updated\. The description at 0:01 is now: Chef Lin(, in her white apron,)? waves", 10) is not None, "then reads the corrected description")
        fixes = REQUESTS[before:]
        check(len(fixes) == 1, f"only that moment is described again ({len(fixes)} request)")
        if fixes:
            fix = fixes[0]["body"]
            check(fix["contents"][0]["parts"][0]["videoMetadata"] == {"startOffset": "0s", "endOffset": "13s"}, "a short clip around it")
            check("Chef Lin enters the kitchen in a white apron." in fix["contents"][0]["parts"][1]["text"], "Gemini is told which description was reported")
        cues = sw.evaluate(f"async () => (await chrome.storage.local.get('script:{VIDEO_ID}:en'))['script:{VIDEO_ID}:en'].cues.map(c => c.standard)")
        check(cues[0] == "Chef Lin waves at the camera." and len(cues) == 5, "the saved description is replaced, and only that one")
        marks = sw.evaluate(f"async () => (await chrome.storage.local.get('feedback:{VIDEO_ID}:en'))['feedback:{VIDEO_ID}:en']")
        check(bool(marks) and marks[-1]["status"] == "revised", "the mark is kept in the extension's local storage")
        page.evaluate("window.__log = []")
        tab_action("repeat-last")
        check(wait_for_log(page, r"^Chef Lin(, in her white apron,)? waves", 4) is not None, "repeat-last now repeats the corrected description")

        # ---------------- ads / toggle / overlay
        print("\n[ads / toggle / overlay]")
        video(page, "v.pause(); v.currentTime = 0.2;")
        page.evaluate("document.getElementById('movie_player').classList.add('ad-showing')")
        page.evaluate("window.__log = []")
        video(page, "v.play();")
        time.sleep(2.5)
        check(not any("Chef Lin" in t for t in log_texts(page)), "nothing is described while an ad is showing")
        page.evaluate("document.getElementById('movie_player').classList.remove('ad-showing')")
        video(page, "v.pause();")

        page.evaluate("window.__log = []")
        tab_action("toggle-descriptions")
        check(wait_for_log(page, r"Descriptions off", 4) is not None, "toggle announces off")
        check(page.get_attribute(".scenevoice-button", "aria-pressed") == "false", "player button shows off")
        video(page, "v.currentTime = 0.2; v.play();")
        time.sleep(2.2)
        check(not any("Chef Lin" in t for t in log_texts(page)), "no descriptions while off")
        tab_action("toggle-descriptions")
        check(wait_for_log(page, r"Descriptions on", 4) is not None, "toggle announces on")

        settings({"showText": True})
        video(page, "v.pause(); v.currentTime = 5.2; v.play();")
        check(wait_until(page, "() => { const o = document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('.overlay'); return !o.hidden && o.textContent.includes('Dumplings'); }", 6), "on-screen text appears in the large-text overlay")
        check(page.evaluate("document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('.overlay').getAttribute('aria-hidden')") == "true", "overlay is hidden from screen readers (no double reading)")
        page.screenshot(path=str(OUT / "overlay.png"))
        settings({"showText": False})
        video(page, "v.pause();")

        page.evaluate("window.__log = []")
        tab_action("cycle-detail")
        check(wait_for_log(page, r"Detail: detailed", 4) is not None, "cycle-detail announces the new level")
        settings({"detail": "standard"})

        # ---------------- language switch drops the old script
        print("\n[language switch]")
        settings({"language": "zh-CN"})
        time.sleep(0.8)
        st = tab_state()
        check(st and st["lang"] == "zh-CN" and st["status"] == "none" and st["cueCount"] == 0, "switching language drops the English descriptions")
        page.evaluate("window.__log = []")
        video(page, "v.currentTime = 0.2; v.play();")
        time.sleep(2.2)
        check(not any("Chef Lin" in t for t in log_texts(page)), "no English cues play after switching to Chinese")
        video(page, "v.pause();")
        settings({"language": "auto"})
        time.sleep(0.8)
        st = tab_state()
        check(st and st["lang"] == "en" and st["cueCount"] == 5, "switching back restores the cached English descriptions")

        # ---------------- stop and resume
        print("\n[stop and resume]")
        tab_action("delete")
        DELAY["seconds"] = 2.5
        before = len(REQUESTS)
        page.evaluate("window.__log = []")
        tab_action("generate")
        check(wait_for_log(page, r"ready for the first 5 minutes", 10) is not None, "first section done")
        time.sleep(0.5)  # second section is now in flight
        tab_action("stop")
        e = wait_for_log(page, r"Stopped", 5)
        check(e is not None, f"stopping is announced ({e and e['text'][:70]})")
        st = tab_state()
        check(st and st["status"] in ("partial", "none") and not st["complete"], f"after stopping the script is incomplete ({st and st['status']}, {st and st['completedUntil']}s saved)")
        check(page.evaluate(f"{pill}.hidden"), "the progress bar is gone after stopping")
        saved_until = st["completedUntil"] if st else 0
        check(saved_until == 300, f"the finished section is kept ({saved_until}s)")
        sent = len(REQUESTS) - before
        DELAY["seconds"] = 1.0
        tab_action("generate")
        check(wait_for_log(page, r"Descriptions ready: 5", 20) is not None, "generating again finishes the video")
        check(len(REQUESTS) - before - sent == 1, f"resuming only requests the remaining section ({len(REQUESTS) - before - sent} request)")
        check(REQUESTS[-1]["body"]["contents"][0]["parts"][0]["videoMetadata"]["startOffset"] == "300s", "and it starts where the saved part ends")

        # ---------------- two tabs on the same video share one job
        print("\n[two tabs]")
        tab_action("delete")
        DELAY["seconds"] = 2.5
        before = len(REQUESTS)
        page.evaluate("window.__log = []")
        page2 = open_watch()
        time.sleep(0.8)
        tab_action("generate", 0)
        check(wait_for_log(page, r"creating descriptions", 5) is not None, "tab 1 starts the job")
        time.sleep(0.5)
        page2.evaluate("window.__log = []")
        tab_action("generate", 1)
        time.sleep(0.6)
        st2 = tab_state(1)
        check(st2 and st2["status"] == "generating" and st2["total"] == 2, f"tab 2 joins the running job ({st2 and st2['status']}, {st2 and st2['total']} sections)")
        check(len(REQUESTS) - before == 1, f"and no second request is made ({len(REQUESTS) - before} in flight)")
        e = wait_for_log(page2, r"ready for the first 5 minutes", 8)
        check(e is not None, "tab 2 hears the first section finish")
        check(wait_for_log(page2, r"Descriptions ready: 5", 10) is not None, "tab 2 announces readiness")
        check(wait_for_log(page, r"Descriptions ready: 5", 5) is not None, "so does tab 1")
        st2 = tab_state(1)
        check(st2 and st2["status"] == "ready" and st2["cueCount"] == 5, "tab 2 has the descriptions")
        check(len(REQUESTS) - before == 2, f"the video was described only once ({len(REQUESTS) - before} requests)")
        page2.close()
        DELAY["seconds"] = 1.0

        # ---------------- the job outlives the tab: leave mid-way, come back to a finished script
        print("\n[job survives navigation]")
        tab_action("delete")
        DELAY["seconds"] = 2.0
        before = len(REQUESTS)
        page.evaluate("window.__log = []")
        tab_action("generate")
        check(wait_for_log(page, r"creating descriptions", 5) is not None, "job started")
        page.goto("https://www.youtube.com/")
        time.sleep(0.5)
        page.goto(WATCH)
        page.wait_for_selector("[data-scenevoice=announcer]", state="attached", timeout=10000)
        check(wait_for_log(page, r"Descriptions ready: 5", 15) is not None, "after leaving and returning, the descriptions finish and are announced")
        check(len(REQUESTS) - before == 2, f"without any extra requests ({len(REQUESTS) - before})")
        DELAY["seconds"] = 1.0

        # ---------------- cache and errors
        print("\n[cache and errors]")
        before = len(REQUESTS)
        page.reload()
        page.wait_for_selector("[data-scenevoice=announcer]", state="attached", timeout=10000)
        time.sleep(1.5)
        st = tab_state()
        check(st and st["status"] == "ready" and st["cueCount"] == 5, "reloading uses the saved descriptions")
        check(len(REQUESTS) == before, "no new API calls for a cached video")
        e = wait_for_log(page, r"already saved for this video", 4)
        check(e is not None and "5 in total" in e["text"], f"opening a described video says the saved descriptions are loaded ({e and e['text'][:70]})")
        st = tab_state()
        check(st and st["firstCue"] == 1, "tab state reports the first description's time for the popup")

        # Transcript page
        print("\n[transcript]")
        tp = ctx.new_page()
        tp.on("console", lambda m: m.type == "error" and console_errors.append(f"transcript: {m.text}"))
        tp.goto(f"chrome-extension://{ext_id}/transcript.html?v={VIDEO_ID}&lang=en&title=Dumplings%20101")
        tp.wait_for_load_state()
        check(wait_until(tp, "() => document.querySelectorAll('#rows tr').length === 5", 5), "transcript lists every description")
        check("0:12" in tp.inner_text("#rows") and "folding a dumpling" in tp.inner_text("#rows"), "with timestamps and standard text")
        check(tp.locator("#rows .tag").count() == 1, "on-screen text is marked")
        tp.select_option("#detail", "detailed")
        check("eight neat pleats" in tp.inner_text("#rows"), "the length selector switches the text")
        check(tp.get_attribute("#download", "download") == f"scenevoice-{VIDEO_ID}-en.txt" and (tp.get_attribute("#download", "href") or "").startswith("blob:"), "download link is ready")
        axe(tp, "transcript page")
        tp.close()

        # ---------------- empty transcript page (a video never described)
        print("\n[empty transcript]")
        tp = ctx.new_page()
        tp.on("console", lambda m: m.type == "error" and console_errors.append(f"transcript: {m.text}"))
        tp.goto(f"chrome-extension://{ext_id}/transcript.html?v=zzzzzzzzzzz&lang=en")
        tp.wait_for_load_state()
        check(wait_until(tp, "() => !document.getElementById('empty').hidden", 5), "an unknown video says no descriptions are saved")
        check(tp.is_hidden("#table"), "and shows no table")
        # tabIndex reads 0 for any <a>; whether it can take focus is what matters.
        dead = tp.evaluate("() => { const a = document.getElementById('download'); a.focus(); return document.activeElement === a && !a.hasAttribute('href'); }")
        check(not dead, "the Download control is not a focusable dead link")
        check(tp.is_disabled("#copy"), "Copy is disabled when there is nothing to copy")
        axe(tp, "empty transcript page")
        tab_reachable(tp, "empty transcript page")
        tp.close()

        # ---------------- popup: while a job runs, after it ends, without a key
        print("\n[popup states]")
        tab_action("delete")
        DELAY["seconds"] = 4.0
        page.evaluate("window.__log = []")
        tab_action("generate")
        check(wait_for_log(page, r"creating descriptions", 5) is not None, "job started")
        pop = open_popup(page)
        check(wait_until(pop, "() => !document.getElementById('stop').hidden", 5), "popup shows Stop while a job is running")
        check(pop.inner_text("#videoStatus") == "Creating descriptions. Progress is shown below.", f"the status says once that descriptions are being created ({pop.inner_text('#videoStatus')[:60]})")
        check(pop.is_visible("#progressBox") and pop.is_hidden("#generate"), "the progress bar is shown and Create is hidden")
        axe(pop, "popup while generating")
        tab_reachable(pop, "popup while generating")
        seen_status, seen_progress = set(), set()
        for _ in range(7):
            seen_status.add(pop.inner_text("#videoStatus"))
            seen_progress.add(pop.inner_text("#progressText"))
            time.sleep(0.5)
        check(len(seen_progress) >= 2, f"the percentage moves while the job runs ({sorted(seen_progress)[:2]})")
        check(len(seen_status) == 1, f"the status live region does not change while the percentage does ({len(seen_status)} texts)")
        check(wait_until(pop, "() => document.getElementById('stop').hidden", 25), "Stop disappears when the job ends")
        check(pop.inner_text("#videoStatus").startswith("5 descriptions ready"), f"the status says the descriptions are ready ({pop.inner_text('#videoStatus')[:60]})")
        check(pop.is_hidden("#progressBox") and pop.is_visible("#transcript"), "the progress bar is gone and Read all descriptions is offered")
        axe(pop, "popup after the job")
        tab_reachable(pop, "popup after the job")
        DELAY["seconds"] = 1.0
        # No key and no Cloud token at all: the banner sends the listener to the welcome page.
        local({"apiKey": "", "qwenApiKey": "", "cloudToken": ""})
        pop.reload()
        pop.wait_for_load_state()
        time.sleep(0.6)
        check(pop.is_visible("#keyBanner"), "popup shows the setup banner without any key")
        check("welcome page" in pop.inner_text("#setupBody") and pop.inner_text("#setupKey") == "Set up SceneVoice", "the banner points at the welcome page")
        axe(pop, "popup with the setup banner")
        tab_reachable(pop, "popup with the setup banner")
        pop.emulate_media(color_scheme="dark"); settle()
        axe(pop, "popup with the setup banner (dark)")
        pop.close()
        local({"apiKey": "test-key"})

        # ---------------- Bilibili with Qwen: described from frames as it plays
        print("\n[bilibili + qwen]")
        opt = ctx.new_page()
        opt.on("console", lambda m: m.type == "error" and console_errors.append(f"options: {m.text}"))
        opt.goto(f"chrome-extension://{ext_id}/options.html#qwen")
        opt.wait_for_load_state()
        check(wait_until(opt, "() => document.activeElement && document.activeElement.id === 'qwenApiKey'", 5), "options.html#qwen starts in the Qwen key field")
        opt.fill("#qwenApiKey", "wrong-key")
        opt.click("#saveQwenKey")
        check(wait_until(opt, "() => document.querySelector('#qwenKeyStatus').className === 'status-bad'", 10), "a wrong Qwen key is rejected")
        opt.fill("#qwenApiKey", QWEN_KEY)
        opt.click("#saveQwenKey")
        check(wait_until(opt, "() => document.querySelector('#qwenKeyStatus').className === 'status-good'", 10), "a valid Qwen key is accepted")
        check("qwen3-vl-plus" in opt.inner_text("#qwenKeyStatus"), f"and the status names the model ({opt.inner_text('#qwenKeyStatus')[:60]})")
        tests = [r for r in REQUESTS if r.get("host") == DASHSCOPE_HOST]
        check(bool(tests) and tests[-1]["origin"].startswith("chrome-extension://"), "the key test reaches DashScope from the extension")
        # The Gemini key was saved first, so it took over both sites (adoptProviderIfOnlyKey);
        # adding the Qwen key leaves that choice alone. Pick Qwen for Bilibili the way a
        # listener would, in "Which model describes each site".
        opt.select_option("#bilibiliProvider", "qwen")
        check(wait_until(sw, "async () => ((await chrome.storage.sync.get('settings')).settings || {}).bilibiliProvider === 'qwen'", 5), "choosing Qwen for Bilibili is saved")
        opt.close()

        def dash_frames():
            return [r for r in REQUESTS if r.get("host") == DASHSCOPE_HOST and r.get("frames")]

        bili_console = []
        bili = ctx.new_page()
        bili.on("console", lambda m: bili_console.append(m.text) or (m.type == "error" and console_errors.append(f"bilibili: {m.text}")))
        bili.on("pageerror", lambda e: console_errors.append(f"bilibili page error: {e}"))
        bili.add_init_script(LOGGER)
        bili.goto(BILI_WATCH)
        bili.wait_for_selector("[data-scenevoice=announcer]", state="attached", timeout=10000)
        wait_until(bili, "() => document.querySelector('video').readyState >= 1", 15)
        CURRENT_PAGE = bili
        st = tab_state(platform="bilibili")
        check(bool(st) and st["platform"] == "bilibili" and st["provider"] == "qwen" and st["inputMode"] == "frames", f"the Bilibili tab uses Qwen, from frames ({st and (st['provider'], st['inputMode'])})")
        check(bool(st) and st["title"] == "包饺子入门：林师傅的厨房", f"the title comes from the page's own data ({st and st['title']})")
        btn = bili.locator(".bpx-player-control-bottom-right .scenevoice-button")
        check(btn.count() == 1, "the Bilibili player gets a SceneVoice button in its control bar")
        check(btn.count() == 1 and btn.get_attribute("aria-label") == "SceneVoice audio description" and btn.get_attribute("aria-pressed") in ("true", "false"), "the player button has a spoken name and state")
        check(wait_until(bili, "() => performance.getEntriesByType('resource').some(e => e.name.includes('/bfs/subtitle/'))", 5), "the page's player loaded its subtitle file")

        before = len(dash_frames())
        bili.evaluate("window.__log = []")
        video(bili, "v.currentTime = 0; v.play();")
        tab_command("toggle-descriptions", "bilibili")  # Alt+Shift+D
        e = wait_for_log(bili, r"describing as you watch", 6)
        check(e is not None and "Qwen" in e["text"], f"Alt+Shift+D says SceneVoice is describing as you watch, with Qwen ({e and e['text'][:80]})")
        check(e is not None and e["text"].startswith("AI-generated audio description follows."), "and says first that the descriptions are made by AI")
        bpill = "document.querySelector('[data-scenevoice=ui]').shadowRoot.querySelector('.progress')"
        check(wait_until(bili, f"() => !{bpill}.hidden", 3), "a progress box appears on the player")
        check(bili.evaluate(f"{bpill}.querySelector('.label').textContent") == "Describing as you watch", "it says what is happening")
        geo = bili.evaluate(f"""() => {{ const b = {bpill}.getBoundingClientRect(), p = document.querySelector('.bpx-player-container').getBoundingClientRect();
          return {{ top: b.top - p.top, bottom: p.bottom - b.bottom, h: p.height }}; }}""")
        check(geo["top"] > geo["h"] / 2 and geo["bottom"] >= 60, f"the box sits low in the player, above the control bar ({geo})")
        e = wait_for_log(bili, r"lifts the lid of a bamboo steamer", 22)
        check(e is not None, f"a description made from frames is announced within about 20 s (video at {e and round(e['vt'], 1)}s)")
        sent = dash_frames()[before:]
        check(len(sent) >= 1, f"frames went to DashScope ({len(sent)} request)")
        if sent:
            r = sent[0]
            check(r["path"] == QWEN_PATH and r["body"]["model"] == "qwen3-vl-plus", "an OpenAI-compatible chat completion with the default Qwen model")
            check(1 <= r["frames"] <= 6, f"a few pictures per request ({r['frames']})")
            check(r["origin"].startswith("chrome-extension://"), f"sent from the extension, not from the Bilibili page ({r['origin'][:30]})")
            prompt = " ".join(part.get("text", "") for part in r["body"]["messages"][1]["content"] if part.get("type") == "text")
            check("包饺子入门" in prompt and "林家厨房" in prompt, "title and uploader from the page's data go with the frames")
        check(wait_until(bili, f"() => {bpill}.querySelector('.eta').textContent.startsWith('Described up to')", 5), f"the box above the controls says how far it is described ({bili.evaluate(f'{bpill}.textContent').strip()[:60]})")
        check(any("dialogue timing from captions: 2 stretches" in m for m in bili_console), "dialogue timing was read from the subtitle file the player loaded")
        st = tab_state(platform="bilibili")
        check(bool(st) and st["status"] == "live" and (st["describedUpTo"] or 0) > 0, f"tab state is live with how far it is described ({st and st['describedUpTo']}s)")

        # Stop from the popup: no more pictures, what was described stays.
        pop = open_popup(bili)
        check(wait_until(pop, "() => !document.getElementById('stop').hidden", 5), "popup shows Stop while describing as you watch")
        check(pop.inner_text("#videoStatus").startswith("Describing as you watch"), f"popup status says so ({pop.inner_text('#videoStatus')[:50]})")
        check("Described up to" in pop.inner_text("#progressText"), f"popup progress says how far ({pop.inner_text('#progressText')[:60]})")
        bili.evaluate("window.__log = []")
        pop.click("#stop")
        check(wait_for_log(bili, r"No more pictures are sent", 5) is not None, "Stop in the popup is announced on the page")
        check(wait_until(pop, "() => document.getElementById('stop').hidden", 5), "and the popup hides Stop")
        pop.close()
        time.sleep(0.5)
        count = len(dash_frames())
        check(not video(bili, "return v.paused;"), "the video keeps playing")
        time.sleep(15)
        check(len(dash_frames()) == count, f"no further request to DashScope within 15 s of stopping ({len(dash_frames()) - count})")
        check(bili.evaluate(f"{bpill}.hidden"), "the progress box is gone")
        st = tab_state(platform="bilibili")
        check(bool(st) and st["status"] == "partial" and st["cueCount"] >= 1, f"what was described is kept ({st and st['status']}, {st and st['cueCount']})")
        check(not any("api.bilibili.com" in u for u in PAGE_REQUESTS) and not any("bilibili" in r.get("host", "") for r in REQUESTS), "no request goes to api.bilibili.com")
        bili.close()
        CURRENT_PAGE = page

        local({"apiKey": "bad"})
        tab_action("delete")
        page.evaluate("window.__log = []")
        tab_action("generate")
        e = wait_for_log(page, r"was not accepted", 10)
        check(e is not None, "a rejected key is announced in plain words")
        check(find_page(ctx, sw, "options.html", 10) is not None, "settings page opens to fix the key")

        print("\n[console]")
        noisy = [c for c in console_errors if "favicon" not in c and "Failed to load resource" not in c]
        for c in noisy:
            print("      ", c)
        check(not noisy, "no console errors from the extension")
        ctx.close()

        chinese_run(p, tmp, port)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed:")
        for f in FAILURES:
            print(" -", f)
        sys.exit(1)
    print("All end-to-end checks passed.")


if __name__ == "__main__":
    main()
