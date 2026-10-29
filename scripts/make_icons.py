"""Draw the SceneVoice icon (a play frame emitting sound waves) at every size Chrome needs."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

NAVY = (18, 31, 61, 255)
YELLOW = (255, 207, 63, 255)
WHITE = (255, 255, 255, 255)


def draw(size: int) -> Image.Image:
    s = 8  # supersample for smooth edges
    W = size * s
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(W * 0.22)
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=r, fill=NAVY)
    # play triangle
    cx, cy = W * 0.36, W * 0.5
    h = W * 0.36
    d.polygon([(cx - h * 0.42, cy - h / 2), (cx - h * 0.42, cy + h / 2), (cx + h * 0.48, cy)], fill=WHITE)
    # sound waves
    width = max(int(W * 0.065), 2)
    for i, rad in enumerate((0.20, 0.31)):
        rr = W * rad
        box = [W * 0.50 - rr, cy - rr, W * 0.50 + rr, cy + rr]
        if size < 24 and i == 1:
            continue
        d.arc(box, start=-48, end=48, fill=YELLOW, width=width)
    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    draw(size).save(OUT / f"icon{size}.png")
print("icons written to", OUT)
