"""End-to-end test: the built extension in real Chromium, a fake YouTube watch page
with a real (seekable) video, and a mock Gemini API answered through Playwright
request interception. Checks what a screen reader would hear.

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
GEMINI_HOST = "generativelanguage.googleapis.com"
GEMINI = f"https://{GEMINI_HOST}"

REQUESTS = []
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
    """Alt+Shift+<letter> as Chrome shows it: "Alt+Shift+D", or "⌥⇧D" on macOS."""
    return any(k in (text or "") for k in (f"Alt+Shift+{letter}", f"⌥⇧{letter}"))


def english_only_copy(tmp):
    """The built extension with only its English strings. The checks read English text,
    and Chrome picks the interface language from the machine (macOS ignores --lang)."""
    ext = Path(tmp) / "ext"
    shutil.copytree(DIST, ext)
    for loc in (ext / "_locales").iterdir():
        if loc.name != "en":
            shutil.rmtree(loc)
    return ext


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


MODELS = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-pro", "text-embedding-004"]
DELAY = {"seconds": 1.0}
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-goog-api-key", "access-control-allow-methods": "GET, POST, OPTIONS"}


class Gemini(BaseHTTPRequestHandler):
    """Mock Gemini API, served over TLS on the real hostname via --host-resolver-rules,
    so both extension pages and the YouTube content script reach it like the real thing."""

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
        if not self.authorized():
            return
        REQUESTS.append({"path": self.path, "body": body, "origin": self.headers.get("origin", "")})
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


def start_gemini(tmp):
    cert, key = Path(tmp) / "cert.pem", Path(tmp) / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
                    "-subj", f"/CN={GEMINI_HOST}", "-addext", f"subjectAltName=DNS:{GEMINI_HOST}"], check=True, capture_output=True)
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


def axe(page, label, context="document"):
    res = page.evaluate(
        f"async () => (await axe.run({context}, {{ runOnly: ['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice'] }}))"
        ".violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help}))"
    )
    serious = [v for v in res if v["impact"] in ("serious", "critical")]
    for v in res:
        print(f"       axe {label}: {v['impact']} {v['id']} x{v['nodes']} — {v['help']}")
    check(not serious, f"{label}: no serious or critical accessibility violations")
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


def main():
    global CURRENT_PAGE
    console_errors = []
    with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
        ext = english_only_copy(tmp)
        port = start_gemini(tmp)
        print(f"mock Gemini at {GEMINI} -> 127.0.0.1:{port}")
        ctx = p.chromium.launch_persistent_context(
            str(Path(tmp) / "profile"),
            headless=True,
            channel="chromium",
            ignore_https_errors=True,
            args=[
                f"--disable-extensions-except={ext}",
                f"--load-extension={ext}",
                f"--host-resolver-rules=MAP {GEMINI_HOST} 127.0.0.1:{port}",
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
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        print(f"extension {ext_id}")

        # Messages to the content script go through the service worker. `nth` picks
        # among the tabs that answer (YouTube tabs), in tab order.
        def tab_call(msg, nth=0):
            return sw.evaluate("""async ([msg, nth]) => {
              const out = [];
              for (const t of await chrome.tabs.query({})) {
                try { const r = await chrome.tabs.sendMessage(t.id, msg); if (r) out.push(r); } catch (e) {}
              }
              return out[nth] || null; }""", [msg, nth])

        def tab_action(action, nth=0):
            return tab_call({"type": "sv:tab-action", "action": action}, nth)

        def tab_state(nth=0):
            return tab_call({"type": "sv:tab-state"}, nth)

        def settings(patch):
            sw.evaluate("""async (patch) => {
              const s = (await chrome.storage.sync.get('settings')).settings || {};
              await chrome.storage.sync.set({ settings: { ...s, ...patch } }); }""", patch)
            time.sleep(0.3)

        def local(patch):
            sw.evaluate("""async (patch) => {
              const l = (await chrome.storage.local.get('local')).local || {};
              await chrome.storage.local.set({ local: { ...l, ...patch } }); }""", patch)

        # ---------------- options page: first run
        print("\n[options page]")
        opt = find_page(ctx, sw, "options.html", 15)
        check(opt is not None, "options page opens on install")
        if opt is None:
            opt = ctx.new_page()
            opt.goto(f"chrome-extension://{ext_id}/options.html")
        opt.on("console", lambda m: m.type == "error" and console_errors.append(f"options: {m.text}"))
        opt.wait_for_load_state()
        check(wait_until(opt, "() => document.activeElement && document.activeElement.id === 'apiKey'", 5), "focus starts in the API key field")
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
        check(opt.locator("#shortcuts kbd").count() == 4, "four default shortcuts are set")
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
        opt.screenshot(path=str(OUT / "options.png"), full_page=True)
        opt.emulate_media(color_scheme="dark")
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
        pop.screenshot(path=str(OUT / "popup.png"), full_page=True)
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
        check(wait_for_log(page, r"creating descriptions", 5) is not None, "announces that generation started once the ad ends")
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
            check(first["contents"][0]["parts"][0]["videoMetadata"] == {"startOffset": "0s", "endOffset": "300s"}, "chunk 1 covers 0–300s")
            meta2 = second["contents"][0]["parts"][0]["videoMetadata"]
            check(meta2 == {"startOffset": "300s", "endOffset": "571s"}, f"chunk 2 covers 300s to the end ({meta2})")
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

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed:")
        for f in FAILURES:
            print(" -", f)
        sys.exit(1)
    print("All end-to-end checks passed.")


if __name__ == "__main__":
    main()
