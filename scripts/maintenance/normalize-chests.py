#!/usr/bin/env python3
"""Normalize the chest artwork so every rarity is drawn at the same size and centred.

The app draws each chest with .resizable().scaledToFit() in a square frame, so any
difference in canvas size or empty margin shows up as a chest that looks bigger,
smaller or off-centre. This crops each PNG to its visible pixels, scales it to the
same chest width and centres it on the same square transparent canvas.

Usage (from the repo root, needs Pillow):
    python3 scripts/maintenance/normalize-chests.py
"""
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parents[2] / "ios" / "Kaemedos" / "Assets.xcassets"
RARITIES = ["common", "rare", "epic", "legendary"]
# Close to the art's native width (364–383 px), so resampling stays minimal.
CHEST_WIDTH = 368
CANVAS = 420  # ~6 % transparent margin on each side


def normalize(path: Path) -> None:
    image = Image.open(path).convert("RGBA")
    box = image.getchannel("A").getbbox()
    if box is None:
        raise SystemExit(f"{path} is fully transparent")
    chest = image.crop(box)
    height = round(chest.height * CHEST_WIDTH / chest.width)
    if height > CANVAS:
        raise SystemExit(f"{path}: chest too tall ({height}px) for a {CANVAS}px canvas")
    # Premultiplied resize, so transparent pixels don't bleed dark fringes into the edges
    chest = chest.convert("RGBa").resize((CHEST_WIDTH, height), Image.LANCZOS).convert("RGBA")
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(chest, ((CANVAS - CHEST_WIDTH) // 2, (CANVAS - height) // 2))
    canvas.save(path, optimize=True)
    print(f"{path.name}: {image.size} bbox {box} -> {CANVAS}x{CANVAS}, chest {CHEST_WIDTH}x{height}")


if __name__ == "__main__":
    for rarity in RARITIES:
        normalize(ASSETS / f"chest_{rarity}.imageset" / f"chest_{rarity}.png")
