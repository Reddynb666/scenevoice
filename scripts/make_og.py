"""The website's social card as a PNG: render site/assets/og.svg (the editable source)
to site/assets/og.png, 1200 by 630, in headless Chromium. Share previews (X, Facebook,
LinkedIn, Slack, WeChat) show PNG/JPEG/WebP only, never SVG. Run after editing the SVG
and commit the PNG; nothing in the build depends on this script:

    python3 scripts/make_og.py

Needs the same Playwright as scripts/screenshots.py (pip install playwright &&
playwright install chromium). Chinese glyphs come from the machine's own fonts
(PingFang SC on a Mac), so check the result once by eye or ask someone to.
"""
import struct
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "site" / "assets" / "og.svg"
PNG = ROOT / "site" / "assets" / "og.png"
SIZE = (1200, 630)


def png_size(path: Path):
    """Width and height from the IHDR chunk, so the result is checked without Pillow."""
    head = path.read_bytes()[:24]
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} is not a PNG")
    return struct.unpack(">II", head[16:24])


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": SIZE[0], "height": SIZE[1]}, device_scale_factor=1)
        page.goto(SVG.resolve().as_uri())
        page.wait_for_load_state("load")
        page.screenshot(path=str(PNG), full_page=False)
        browser.close()
    size = png_size(PNG)
    if size != SIZE:
        raise SystemExit(f"{PNG} is {size[0]}x{size[1]}, expected {SIZE[0]}x{SIZE[1]}")
    print(f"wrote {PNG.relative_to(ROOT)} ({size[0]}x{size[1]}, {PNG.stat().st_size} bytes)")


if __name__ == "__main__":
    sys.exit(main())
