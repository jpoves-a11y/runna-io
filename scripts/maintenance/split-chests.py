#!/usr/bin/env python3
"""Cut each chest illustration into the pieces the 3D opening is textured with.

The opening (ios/Kaemedos/Components/ChestOpening3D.swift) builds the chest in 3D seen from the
same angle the illustration is drawn from, and paints the picture onto it from that viewpoint
(camera projection mapping): at rest the chest is exactly the picture, and when the lid swings
open on its hinge the picture moves with it. This script cuts every `chest_<rarity>.png` into
the pieces that move separately, on the same 420 x 420 canvas:

    chest_<rarity>_lid     the domed lid and the hasp hanging from it
    chest_<rarity>_base    the body, with the padlock and hasp removed and the wood behind them
                           painted back in
    chest_<rarity>_lock    the padlock (body and shackle)

The inside of the chest and of the lid, which the pictures don't show, is wood generated in code.

The outlines below were traced by hand on each picture; `ChestArt` in ChestOpening3D.swift uses
the front-left corner of the top and the size of the hasp and padlock, so keep them in sync if
the art changes.

Usage (from the repo root, needs Pillow and NumPy):
    python3 scripts/maintenance/split-chests.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ASSETS = Path(__file__).resolve().parents[2] / "ios" / "Kaemedos" / "Assets.xcassets"
CANVAS = 420

# Per rarity, in pixels of the 420 px picture:
#   cut     the top edge of the body (the band under the lid), left to right; the lid is above it
#   hasp    (left, top, right, bottom) of the hasp plate, which goes up with the lid
#   lock    shackle (left, right, top) and body (left, right, top, side bottom, tip x, tip y)
#   front   x range of the plain front planks either side of the padlock, used to paint the wood
#           back in behind it
#   opening front-left, front-right and back-right corners of the top of the body
CHESTS = {
    "common": dict(
        cut=[(0, 171), (82, 171), (84, 177), (234, 184), (236, 189), (318, 190), (320, 185), (362, 168), (364, 165), (420, 165)],
        hasp=(123, 162, 202, 197),
        lock=dict(shackle=(126, 188, 191), body=(111, 207, 234, 288, 152, 313)),
        front=((86, 110), (209, 233)),
        opening=((32, 172), (306, 190), (392, 165)),
    ),
    "rare": dict(
        cut=[(0, 170), (80, 170), (82, 176), (230, 182), (232, 186), (318, 188), (320, 183), (362, 166), (364, 162), (420, 162)],
        hasp=(120, 162, 201, 195),
        lock=dict(shackle=(121, 189, 188), body=(107, 205, 230, 285, 150, 310)),
        front=((84, 106), (207, 229)),
        opening=((30, 171), (304, 188), (391, 162)),
    ),
    "epic": dict(
        cut=[(0, 171), (82, 171), (84, 177), (234, 184), (236, 188), (318, 190), (320, 185), (362, 170), (364, 166), (420, 166)],
        hasp=(123, 165, 202, 197),
        lock=dict(shackle=(125, 188, 190), body=(111, 207, 236, 285, 152, 314)),
        front=((86, 110), (209, 233)),
        opening=((30, 172), (306, 190), (392, 166)),
    ),
    "legendary": dict(
        cut=[(0, 178), (82, 178), (84, 184), (241, 190), (243, 193), (318, 194), (320, 190), (362, 175), (364, 171), (420, 171)],
        hasp=(126, 170, 202, 198),
        lock=dict(shackle=(128, 195, 194), body=(114, 210, 234, 290, 156, 316)),
        front=((86, 113), (212, 240)),
        opening=((34, 179), (308, 194), (392, 171)),
    ),
}


def polygon_mask(points, size=(CANVAS, CANVAS)) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).polygon([tuple(map(float, p)) for p in points], fill=255)
    return mask


def above_cut(chest) -> Image.Image:
    """Everything above the top edge of the body."""
    return polygon_mask([(0, 0), (CANVAS, 0)] + list(reversed(chest["cut"])))


def hasp_mask(chest) -> Image.Image:
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(chest["hasp"], radius=5, fill=255)
    return mask


def lock_points(chest):
    sl, sr, st = chest["lock"]["shackle"]
    bl, br, bt, sb, tx, ty = chest["lock"]["body"]
    points = []
    # Shackle: an arch from the left leg over the top to the right leg
    cx, rx = (sl + sr) / 2, (sr - sl) / 2
    ry = bt - st
    for i in range(0, 19):
        angle = np.pi * i / 18
        points.append((cx - rx * np.cos(angle), bt - ry * np.sin(angle)))
    # Body: right side down, the tip, left side up
    points += [(br - 5, bt + 1), (br - 2, bt + 5), (br - 2, sb), (tx, ty - 1), (bl + 2, sb), (bl + 2, bt + 5), (bl + 5, bt + 1)]
    return points


def lock_mask(chest) -> Image.Image:
    return polygon_mask(lock_points(chest))


def paint_wood_back(image: Image.Image, hole: Image.Image, chest) -> Image.Image:
    """Fills the hole behind the padlock and the hasp with the front planks either side of them.

    The planks and bands run (almost) horizontally along the front, so each row of the hole takes
    the colour of the same row in the plain strips left and right of the padlock (their median,
    so a rivet or a crack doesn't smear across), blended from one side to the other and following
    the slight slope of the front; then the grain of those strips is laid back on top.
    """
    pixels = np.asarray(image.convert("RGBA")).astype(np.float32)
    holes = np.asarray(hole) > 127
    (l0, l1), (r0, r1) = chest["front"]
    (fx0, fy0), (fx1, fy1) = chest["opening"][0], chest["opening"][1]
    slope = (fy1 - fy0) / (fx1 - fx0)
    out = pixels.copy()
    # Wood grain: noise stretched along the rows
    rng = np.random.default_rng(3)
    noise = Image.fromarray((rng.normal(128, 40, (CANVAS, CANVAS // 8))).clip(0, 255).astype(np.uint8))
    noise = noise.resize((CANVAS, CANVAS), Image.BICUBIC).filter(ImageFilter.GaussianBlur((3, 0.6)))
    grain = ((np.asarray(noise).astype(np.float32) - 128) * 0.12)[..., None]

    def strip(x0, x1, y_at_x0):
        """Median colour and the pixels themselves of a sloped row of a strip."""
        xs = np.arange(x0, x1)
        ys = np.clip(np.round(y_at_x0 + slope * (xs - x0)).astype(int), 0, CANVAS - 1)
        row = pixels[ys, xs]
        return np.median(row, axis=0), row

    ys, xs = np.nonzero(holes)
    for y, x in zip(ys, xs):
        median_l, row_l = strip(l0, l1, y + slope * (l0 - x))
        median_r, row_r = strip(r0, r1, y + slope * (r0 - x))
        t = min(max((x - l1) / max(1, r0 - l1), 0), 1)
        t = t * t * (3 - 2 * t)
        color = median_l * (1 - t) + median_r * t
        # A faint grain along the row, so it isn't flat
        color[:3] += grain[y, x]
        out[y, x] = color
    filled = Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGBA")
    # Smooth it a little along the rows, inside the hole only
    soft = filled.filter(ImageFilter.BoxBlur(1))
    edge = hole.filter(ImageFilter.GaussianBlur(1.5))
    blended = Image.composite(soft, filled, edge.point(lambda v: int(v * 0.5)))
    return Image.composite(blended, image, hole.filter(ImageFilter.GaussianBlur(1)))


def average_color(image: Image.Image, mask: Image.Image):
    pixels = np.asarray(image.convert("RGBA")).astype(np.float32)
    selected = (np.asarray(mask) > 127) & (pixels[..., 3] > 200)
    return pixels[selected][:, :3].mean(axis=0)


def save(image: Image.Image, name: str) -> None:
    folder = ASSETS / f"{name}.imageset"
    folder.mkdir(exist_ok=True)
    image.save(folder / f"{name}.png", optimize=True)
    (folder / "Contents.json").write_text(
        '{\n  "images" : [\n    {\n      "filename" : "%s.png",\n      "idiom" : "universal",\n      "scale" : "1x"\n    },\n'
        '    {\n      "idiom" : "universal",\n      "scale" : "2x"\n    },\n    {\n      "idiom" : "universal",\n      "scale" : "3x"\n    }\n'
        '  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n' % name
    )


def split(rarity: str) -> None:
    chest = CHESTS[rarity]
    image = Image.open(ASSETS / f"chest_{rarity}.imageset" / f"chest_{rarity}.png").convert("RGBA")
    assert image.size == (CANVAS, CANVAS), image.size
    transparent = Image.new("RGBA", image.size, (0, 0, 0, 0))

    lock = lock_mask(chest)
    above = above_cut(chest)
    hasp = hasp_mask(chest)
    lid = ImageChops.subtract(ImageChops.lighter(above, hasp), lock)

    lock_layer = Image.composite(image, transparent, lock.filter(ImageFilter.GaussianBlur(0.5)))
    lid_layer = Image.composite(image, transparent, lid.filter(ImageFilter.GaussianBlur(0.4)))

    # The body: everything below the cut, with the padlock and the hasp painted over with wood
    # A couple of pixels under the lid too, so no gap shows along the seam (the lid covers them)
    body = ImageChops.invert(above).filter(ImageFilter.MaxFilter(5))
    # Repaint the whole front between the plain strips, so no shadow of the padlock is left
    (_, l1), (r0, _) = chest["front"]
    (fx0, fy0), (fx1, fy1) = chest["opening"][0], chest["opening"][1]
    slope = (fy1 - fy0) / (fx1 - fx0)
    front = polygon_mask([(l1, fy0 + slope * (l1 - fx0) - 12), (r0, fy0 + slope * (r0 - fx0) - 12), (r0, CANVAS), (l1, CANVAS)])
    hole = ImageChops.multiply(front, body)
    base = paint_wood_back(image, hole, chest)
    base_layer = Image.composite(base, transparent, body)
    # The padlock's tip hangs below the body, over the floor: keep the picture's own outline
    base_layer.putalpha(ImageChops.multiply(base_layer.getchannel("A"), image.getchannel("A")))

    save(lid_layer, f"chest_{rarity}_lid")
    save(base_layer, f"chest_{rarity}_base")
    save(lock_layer, f"chest_{rarity}_lock")
    # The metal of the bands, for the rims the picture doesn't show
    band = polygon_mask([(chest["opening"][0][0], chest["opening"][0][1] + 3), (chest["opening"][1][0] - 70, chest["opening"][1][1] - 2),
                         (chest["opening"][1][0] - 70, chest["opening"][1][1] + 8), (chest["opening"][0][0], chest["opening"][0][1] + 12)])
    print(rarity, "band colour", tuple(round(c / 255, 2) for c in average_color(image, band)))
    print(f"{rarity}: layers written")


if __name__ == "__main__":
    for rarity in CHESTS:
        split(rarity)
