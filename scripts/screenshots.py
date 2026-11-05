"""Store screenshots: load dist/ as an unpacked extension in headless Chromium and
save 1280x800 PNGs of the extension's pages, plus the 440x280 promo tile, into
docs/store/. Run after `npm run build`:

    npm run screenshots                       English, into docs/store/
    python3 scripts/screenshots.py zh_CN      Chinese, into docs/store/zh-CN/

Chrome takes the interface language from the machine, not from Playwright's
locale, so the extension is copied with only the wanted language and that
language as the manifest's default_locale. The pages are shown with a stub key
in chrome.storage.local, so the settings page reads as connected, and a sample
script in the cache, so the transcript page has lines to show. No model is
called and nothing leaves the machine. Pages that another build may not have
yet (welcome.html) are skipped with a note.
"""
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
OUT = ROOT / "docs" / "store"
SIZE = (1280, 800)
NAVY = (18, 31, 61)
YELLOW = (255, 207, 63)
WHITE = (255, 255, 255)
VIDEO_ID = "store0sample"
# The same shape the extension saves (src/shared/cache.js, SCRIPT_VERSION 2).
SAMPLE_SCRIPT = {
    "version": 2,
    "videoId": VIDEO_ID,
    "lang": "en",
    "duration": 95,
    "complete": True,
    "characters": [{"label": "Chef Lin", "description": "woman in a white apron"}],
    "cues": [
        {"start": 1, "gap": 4, "kind": "visual", "priority": 1, "confidence": "high",
         "brief": "Chef Lin enters.", "standard": "Chef Lin enters the kitchen in a white apron.",
         "detailed": "Chef Lin, a woman in a white apron, enters a bright kitchen lined with copper pans."},
        {"start": 6, "gap": 1.5, "kind": "text", "priority": 2, "confidence": "high", "onScreenText": "Dumplings 101",
         "brief": "Title: Dumplings 101", "standard": "Title card: Dumplings 101", "detailed": "A title card reads: Dumplings 101, episode one."},
        {"start": 12, "gap": 0.5, "kind": "visual", "priority": 1, "confidence": "high",
         "brief": "She folds a dumpling.", "standard": "She pinches the dough into pleats, folding a dumpling.",
         "detailed": "Holding a round wrapper in her left hand, she spoons in filling and pinches the edge into eight neat pleats."},
        {"start": 20, "gap": 8, "kind": "visual", "priority": 3, "confidence": "medium",
         "brief": "A tray of dumplings.", "standard": "A tray of twenty dumplings sits on the counter.",
         "detailed": "A wooden tray holds twenty plump dumplings in neat rows on the marble counter."},
        {"start": 41, "gap": 5, "kind": "visual", "priority": 1, "confidence": "high",
         "brief": "Steam rises.", "standard": "Steam rises from the bamboo basket.",
         "detailed": "Thick steam rises from the bamboo basket as Chef Lin lifts the lid."},
    ],
}


def font(size, bold=False):
    """A system font that has Latin glyphs; Pillow's default bitmap font is the fallback."""
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def canvas(color=NAVY):
    return Image.new("RGB", SIZE, color)


def compose_popup(popup_png: Path, out: Path):
    """The 380px-wide popup on a 1280x800 canvas with a caption, like a store screenshot."""
    img = canvas()
    popup = Image.open(popup_png).convert("RGB")
    if popup.height > 700:
        popup = popup.crop((0, 0, popup.width, 700))
    x = 760
    y = (SIZE[1] - popup.height) // 2
    shadow = Image.new("RGB", (popup.width + 16, popup.height + 16), (8, 14, 30))
    img.paste(shadow, (x - 8, y - 8))
    img.paste(popup, (x, y))
    d = ImageDraw.Draw(img)
    d.text((80, 260), "One key, one shortcut.", font=font(48, bold=True), fill=WHITE)
    for i, line in enumerate(["Alt+Shift+D starts descriptions.", "Status, progress and every setting", "are read by your screen reader."]):
        d.text((80, 340 + i * 44), line, font=font(28), fill=YELLOW if i == 0 else WHITE)
    img.save(out)


def promo_tile(out: Path):
    """440x280 small promo tile: icon, name, one line."""
    img = Image.new("RGB", (440, 280), NAVY)
    icon = Image.open(ROOT / "static" / "icons" / "icon128.png").convert("RGBA").resize((96, 96), Image.LANCZOS)
    img.paste(icon, (32, 40), icon)
    d = ImageDraw.Draw(img)
    d.text((148, 52), "SceneVoice", font=font(40, bold=True), fill=WHITE)
    d.text((148, 102), "AI audio description", font=font(22), fill=YELLOW)
    for i, line in enumerate(["Any YouTube or Bilibili video,", "described in the pauses,", "through your own screen reader."]):
        d.text((32, 164 + i * 32), line, font=font(22), fill=WHITE)
    img.save(out)


def shot(page, out: Path):
    page.set_viewport_size({"width": SIZE[0], "height": SIZE[1]})
    page.wait_for_load_state()
    time.sleep(0.5)
    page.screenshot(path=str(out), full_page=False)
    print("  wrote", out.relative_to(ROOT))


def one_language_copy(tmp, lang):
    """dist/ with only one _locales folder, made the default, so Chrome shows that language whatever the machine's is."""
    ext = Path(tmp) / "ext"
    shutil.copytree(DIST, ext)
    if not (ext / "_locales" / lang).exists():
        sys.exit(f"dist/_locales/{lang} does not exist; languages: {sorted(p.name for p in (ext / '_locales').iterdir())}")
    for loc in (ext / "_locales").iterdir():
        if loc.name != lang:
            shutil.rmtree(loc)
    manifest_path = ext / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    manifest["default_locale"] = lang
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf8")
    return ext


def main():
    lang = sys.argv[1] if len(sys.argv) > 1 else "en"
    out = OUT if lang == "en" else OUT / lang.replace("_", "-")
    if not (DIST / "manifest.json").exists():
        sys.exit("dist/ is missing: run `npm run build` first")
    out.mkdir(parents=True, exist_ok=True)
    if lang == "en":
        promo_tile(out / "promo-440x280.png")
        print("  wrote", (out / "promo-440x280.png").relative_to(ROOT))

    with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
        ext = one_language_copy(tmp, lang)
        ctx = p.chromium.launch_persistent_context(
            str(Path(tmp) / "profile"),
            headless=True,
            channel="chromium",
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}", "--no-proxy-server"],
            locale="en-US" if lang == "en" else lang.replace("_", "-"),
            color_scheme="light",
            viewport={"width": SIZE[0], "height": SIZE[1]},
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        base = f"chrome-extension://{ext_id}"

        # Stub state: a key that reads as saved, and one cached script. The
        # settings page tests the key only on Save, so the field shows as filled
        # and nothing is sent anywhere.
        sw.evaluate(
            """async ([videoId, script]) => {
              const l = (await chrome.storage.local.get('local')).local || {};
              await chrome.storage.local.set({
                local: { ...l, apiKey: 'AIza-example-key-not-real-0000000000000', model: 'gemini-3.5-flash' },
                ['script:' + videoId + ':en']: script,
                scriptIndex: { ['script:' + videoId + ':en']: Date.now() },
              }); }""",
            [VIDEO_ID, SAMPLE_SCRIPT],
        )
        # Close the page the install opened, so every page below is ours.
        for pg in list(ctx.pages):
            pg.close()

        page = ctx.new_page()
        page.goto(f"{base}/options.html")
        page.wait_for_load_state()
        try:
            page.wait_for_function("() => document.querySelector('#apiKey') && document.querySelector('#apiKey').value.length > 0", timeout=5000)
        except Exception:
            print("  note: the settings page did not show the stub key; capturing as is")
        shot(page, out / "1-settings-1280x800.png")

        page.goto(f"{base}/popup.html")
        page.set_viewport_size({"width": 380, "height": 800})
        page.wait_for_load_state()
        time.sleep(0.8)
        popup_raw = Path(tmp) / "popup.png"
        page.screenshot(path=str(popup_raw), full_page=True)
        compose_popup(popup_raw, out / "2-popup-1280x800.png")
        print("  wrote", (out / "2-popup-1280x800.png").relative_to(ROOT))

        if (DIST / "welcome.html").exists():
            page.goto(f"{base}/welcome.html")
            shot(page, out / "3-welcome-1280x800.png")
        else:
            print("  note: dist/welcome.html does not exist yet; welcome screenshot skipped")

        page.goto(f"{base}/transcript.html?v={VIDEO_ID}&lang=en&title=Dumplings%20101")
        try:
            page.wait_for_function("() => document.querySelectorAll('#rows tr').length > 0", timeout=5000)
        except Exception:
            print("  note: the transcript page showed no lines; capturing as is")
        shot(page, out / "4-transcript-1280x800.png")

        page.goto(f"{base}/guide.html")
        shot(page, out / "5-key-guide-1280x800.png")
        ctx.close()
    print("done:", out.relative_to(ROOT))


if __name__ == "__main__":
    main()
