"""Crops a render to its outline (square, small margin) and saves it at 256 px.
Used for the Poderes button: python3 crop.py out/powers_icon.png ../../ios/Kaemedos/Assets.xcassets/powers_icon.imageset/powers_icon.png
"""
import sys
from PIL import Image

image = Image.open(sys.argv[1]).convert('RGBA')
left, top, right, bottom = image.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
side = int(max(right - left, bottom - top) * 1.04)
cx, cy = (left + right) / 2, (top + bottom) / 2
box = (int(cx - side / 2), int(cy - side / 2), int(cx - side / 2) + side, int(cy - side / 2) + side)
image.crop(box).resize((256, 256), Image.LANCZOS).save(sys.argv[2], optimize=True)

# Markers (the chest's opening) in the cropped image, 0...1 from the top left, for PowersIcon
import json, os
markers_file = os.path.splitext(sys.argv[1])[0] + '.json'
if os.path.exists(markers_file):
    width, height = image.size
    for x, y in json.load(open(markers_file))['markers']:
        print('CGPoint(x: %.3f, y: %.3f),' % ((x * width - box[0]) / side, (y * height - box[1]) / side))
