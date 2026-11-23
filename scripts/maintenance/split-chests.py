#!/usr/bin/env python3
"""Cut each chest illustration into the layers the opening animation moves.

The opening (ios/Kaemedos/Components/ChestOpening.swift) is drawn with the very same artwork
as the closed chest, so the chest that opens is exactly the one in the picture. This script cuts
every `chest_<rarity>.png` into four layers on the same 420 x 420 canvas:

    chest_<rarity>_lid     the domed lid and the hasp hanging from it
    chest_<rarity>_base    the body, with the padlock and hasp removed and the wood behind them
                           painted back in
    chest_<rarity>_lock    the padlock (body and shackle)
    chest_<rarity>_under   the inside of the lid, seen once it has swung past upright
    chest_<rarity>_inside  the inside of the chest, seen through the opening once the lid lifts

The outlines below were traced by hand on each picture; `ChestArt` in ChestOpening.swift uses the
same numbers (front edge of the opening, hinge, depth), so keep them in sync if the art changes.

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


def inside_layer(image: Image.Image, chest) -> Image.Image:
    """The inside of the body: the top of the walls (lit like the band) around a dark hollow."""
    (flx, fly), (frx, fry), (brx, bry) = chest["opening"]
    depth = np.array([brx - frx, bry - fry], dtype=np.float32)
    fl, fr = np.array([flx, fly], np.float32), np.array([frx, fry], np.float32)
    bl, br = fl + depth, fr + depth
    band = polygon_mask([(flx, fly + 2), (frx, fry + 2), (frx, fry + 14), (flx, fly + 14)])
    rim = average_color(image, band)
    scale = 4
    size = CANVAS * scale
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    def s(p):
        return tuple(float(v) * scale for v in p)

    # Wall tops (the rim), as a slightly lit version of the metal band
    rim_light = tuple(int(min(255, c * 0.95)) for c in rim)
    draw.polygon([s(fl), s(fr), s(br), s(bl)], fill=rim_light + (255,))
    # Hollow: inset by the thickness of the walls (thicker at the front, which is closer)
    across = (fr - fl) / np.linalg.norm(fr - fl)
    back = depth / np.linalg.norm(depth)
    wall = 9.0
    ifl = fl + across * wall + back * wall * 0.6
    ifr = fr - across * wall + back * wall * 0.6
    ibl = bl + across * wall - back * wall * 0.5
    ibr = br - across * wall - back * wall * 0.5
    dark = tuple(int(c * 0.16) for c in rim)
    draw.polygon([s(ifl), s(ifr), s(ibr), s(ibl)], fill=dark + (255,))
    # Inner faces of the back and left walls, a little lighter than the floor
    wall_color = tuple(int(c * 0.3) for c in rim)
    drop = np.array([0, 26], np.float32)
    draw.polygon([s(ibl), s(ibr), s(ibr + drop * 0.55), s(ibl + drop)], fill=wall_color + (255,))
    draw.polygon([s(ifl), s(ibl), s(ibl + drop), s(ifl + drop * 0.4)], fill=tuple(int(c * 0.24) for c in rim) + (255,))
    # Clip everything below the top of the hollow back to the hollow itself (the floor is deeper)
    hollow = polygon_mask([s(ifl), s(ifr), s(ibr), s(ibl)], (size, size))
    rim_mask = polygon_mask([s(fl), s(fr), s(br), s(bl)], (size, size))
    inner = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner.paste(layer, (0, 0), hollow)
    outer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    outer.paste(rim_light + (255,), (0, 0, size, size), rim_mask)
    outer.paste((0, 0, 0, 0), (0, 0, size, size), hollow)
    # A dark edge where the rim meets the hollow, and a soft shade on the hollow
    edge = ImageDraw.Draw(outer)
    edge.line([s(ifl), s(ifr), s(ibr), s(ibl), s(ifl)], fill=tuple(int(c * 0.35) for c in rim) + (255,), width=scale)
    result = Image.alpha_composite(inner, outer)
    return result.resize((CANVAS, CANVAS), Image.LANCZOS)


def under_layer(image: Image.Image, above: Image.Image) -> Image.Image:
    """The inside of the lid: the lid (without the hasp) upside down, in shadow.

    Flipped so the front edge is on top, as when the lid stands open behind the chest; the
    opening animation pins its bottom edge (the lid's top in the picture) to the hinge.
    """
    lid = Image.composite(image, Image.new("RGBA", image.size, (0, 0, 0, 0)), above)
    box = lid.getchannel("A").getbbox()
    flipped = lid.transpose(Image.FLIP_TOP_BOTTOM)
    # Keep the same box: what was at the top of the lid is now at its bottom
    top, bottom = box[1], box[3]
    flipped = flipped.transform(flipped.size, Image.AFFINE, (1, 0, 0, 0, 1, (CANVAS - bottom) - top))
    pixels = np.asarray(flipped).astype(np.float32)
    # In shadow, darker towards the front edge (top), which the light from inside reaches least
    rows = np.linspace(0, 1, CANVAS)[:, None]
    reach = np.clip((rows * CANVAS - top) / max(1, bottom - top), 0, 1)
    shade = 0.2 + 0.2 * reach
    pixels[..., :3] *= shade[..., None]
    return Image.fromarray(pixels.clip(0, 255).astype(np.uint8), "RGBA")


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
    body = ImageChops.invert(above)
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
    save(inside_layer(image, chest), f"chest_{rarity}_inside")
    save(under_layer(image, above), f"chest_{rarity}_under")
    print(f"{rarity}: layers written")


if __name__ == "__main__":
    for rarity in CHESTS:
        split(rarity)
