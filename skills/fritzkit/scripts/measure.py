"""measure.py - pixel-to-mm helper for fritzkit part measuring (Python 3, Pillow only).

  uv run --with pillow python -I measure.py bbox  top.jpg --width-mm 48 --height-mm 20
  uv run --with pillow python -I measure.py grid  top.jpg --bbox X,Y,W,H --width-mm 48 --height-mm 20 --out grid.png
  uv run --with pillow python -I measure.py holes top.jpg --bbox X,Y,W,H --width-mm 48 --height-mm 20 --out holes.png

Pixel values printed (bbox) are in ORIGINAL image pixels; hole positions are part-frame mm
(origin = top-left of the board bbox, x right, y down). Run it on the same image you read.
"""

import argparse
import sys
from collections import deque

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont


def load(path):
    img = Image.open(path)
    img.load()
    return img.convert("RGB")


def parse_bbox(text):
    try:
        x, y, w, h = (int(round(float(v))) for v in text.split(","))
    except ValueError:
        sys.exit("--bbox must be x,y,w,h (pixels), e.g. 212,140,1050,890")
    return x, y, w, h


def detect_bbox(img, thr=235, work=900):
    """Flood-fill the near-white background from the four corners; bbox of the rest."""
    s = min(1.0, work / max(img.size))
    small = img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))))
    r, g, b = small.split()
    low = ImageChops.darker(ImageChops.darker(r, g), b)  # min channel
    mask = low.point(lambda v: 255 if v >= thr else 0).filter(ImageFilter.MedianFilter(5))
    w, h = mask.size
    for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if mask.getpixel(corner) == 255:
            ImageDraw.floodfill(mask, corner, 128)
    board = mask.point(lambda v: 0 if v == 128 else 255)
    box = board.getbbox()
    if box is None:
        sys.exit("no board found (image looks like all background); pass --bbox by hand")
    x0, y0, x1, y1 = (round(v / s) for v in box)
    return x0, y0, min(img.width, x1) - x0, min(img.height, y1) - y0


def scale_report(bbox, args):
    _, _, w, h = bbox
    lines = []
    if args.width_mm:
        lines.append("px/mm (from width)  = %.3f" % (w / args.width_mm))
    if args.height_mm:
        lines.append("px/mm (from height) = %.3f" % (h / args.height_mm))
    if args.width_mm and args.height_mm:
        a, b = w / args.width_mm, h / args.height_mm
        lines.append("disagreement = %.1f%% (over ~3%% means perspective or a wrong outline)"
                     % (100 * abs(a - b) / max(a, b)))
    return lines


def need_dims(args):
    if not (args.bbox and args.width_mm and args.height_mm):
        sys.exit("this subcommand needs --bbox x,y,w,h --width-mm N --height-mm N")
    return parse_bbox(args.bbox)


def font(px):
    try:
        return ImageFont.load_default(size=px)
    except TypeError:  # old Pillow
        return ImageFont.load_default()


def cmd_bbox(args):
    img = load(args.image)
    box = detect_bbox(img, args.thr)
    print("image %dx%d px" % img.size)
    print("bbox x,y,w,h = %d,%d,%d,%d" % box)
    for line in scale_report(box, args):
        print(line)
    print("NOTE: a drop shadow or a protruding connector can inflate the bbox; check by eye.")


def cmd_grid(args):
    bx, by, bw, bh = need_dims(args)
    img = load(args.image)
    m = 20
    crop = img.crop((bx - m, by - m, bx + bw + m, by + bh + m))
    k = max(1.0, 1800 / crop.width)
    crop = crop.resize((round(crop.width * k), round(crop.height * k)), Image.LANCZOS)
    sx, sy = bw * k / args.width_mm, bh * k / args.height_mm  # output px per mm
    ox, oy = m * k, m * k
    over = Image.new("RGBA", crop.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    f = font(max(12, round(sy * 0.9)))
    for i in range(int(args.width_mm) + 1):
        x = ox + i * sx
        major = i % 5 == 0
        d.line([(x, oy), (x, oy + bh * k)], fill=(255, 0, 0, 200 if major else 70),
               width=2 if major else 1)
        if major:
            d.text((x + 2, 2), str(i), fill=(255, 0, 0, 255), font=f)
    for j in range(int(args.height_mm) + 1):
        y = oy + j * sy
        major = j % 5 == 0
        d.line([(ox, y), (ox + bw * k, y)], fill=(0, 0, 255, 200 if major else 70),
               width=2 if major else 1)
        if major:
            d.text((2, y + 2), str(j), fill=(0, 0, 255, 255), font=f)
    Image.alpha_composite(crop.convert("RGBA"), over).convert("RGB").save(args.out)
    print("wrote %s (1 mm grid, labels every 5 mm; red = x, blue = y, origin = board top-left)"
          % args.out)


def components(mask):
    """Connected components of a binary 'L' mask (255 = on): (area, x0, y0, x1, y1, cx, cy)."""
    w, h = mask.size
    px = mask.load()
    seen = bytearray(w * h)
    for y0 in range(h):
        for x0 in range(w):
            if px[x0, y0] != 255 or seen[y0 * w + x0]:
                continue
            q = deque([(x0, y0)])
            seen[y0 * w + x0] = 1
            n, sx, sy, mnx, mny, mxx, mxy = 0, 0, 0, x0, y0, x0, y0
            while q:
                x, y = q.popleft()
                n, sx, sy = n + 1, sx + x, sy + y
                mnx, mny, mxx, mxy = min(mnx, x), min(mny, y), max(mxx, x), max(mxy, y)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny] == 255 and not seen[ny * w + nx]:
                        seen[ny * w + nx] = 1
                        q.append((nx, ny))
            yield n, mnx, mny, mxx, mxy, sx / n, sy / n


def cmd_holes(args):
    bx, by, bw, bh = need_dims(args)
    img = load(args.image)
    crop = img.crop((bx, by, bx + bw, by + bh))
    k = min(1.0, 700 / crop.width)  # work at <= 700 px wide
    small = crop.resize((max(1, round(crop.width * k)), max(1, round(crop.height * k))))
    mask = small.convert("L").filter(ImageFilter.MedianFilter(3))
    mask = mask.point(lambda v: 255 if v < args.dark else 0)
    pmm = small.width / args.width_mm  # work px per mm
    found = []
    for n, x0, y0, x1, y1, cx, cy in components(mask):
        w, h = x1 - x0 + 1, y1 - y0 + 1
        dia = (w + h) / 2 / pmm
        fill = n / (w * h)
        if args.min_d <= dia <= args.max_d and 0.75 <= w / h <= 1.33 and 0.6 <= fill <= 0.92:
            found.append((cx / pmm, cy / (small.height / args.height_mm), dia))
    out = crop.copy()
    d = ImageDraw.Draw(out)
    f = font(max(12, out.width // 80))
    for i, (x, y, dia) in enumerate(sorted(found), 1):
        print("hole %d: x=%.2f y=%.2f mm  diameter ~%.2f mm" % (i, x, y, dia))
        cx, cy = x * bw / args.width_mm, y * bh / args.height_mm
        r = max(6, dia * bw / args.width_mm / 2 + 4)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 0, 0), width=3)
        d.text((cx + r + 2, cy - r), str(i), fill=(255, 0, 0), font=f)
    if not found:
        print("no circular dark blobs found; try --dark 90, or read pads off the grid image")
    if args.out:
        out.save(args.out)
        print("wrote %s" % args.out)


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("bbox", cmd_bbox), ("grid", cmd_grid), ("holes", cmd_holes)):
        s = sub.add_parser(name)
        s.add_argument("image")
        s.add_argument("--bbox", help="x,y,w,h in pixels (from the bbox subcommand)")
        s.add_argument("--width-mm", type=float)
        s.add_argument("--height-mm", type=float)
        s.add_argument("--out")
        s.add_argument("--thr", type=int, default=235, help="bbox: background min-channel level")
        s.add_argument("--dark", type=int, default=60, help="holes: luma below this is dark")
        s.add_argument("--min-d", type=float, default=0.5, help="holes: min diameter, mm")
        s.add_argument("--max-d", type=float, default=4.0, help="holes: max diameter, mm")
        s.set_defaults(fn=fn)
    args = p.parse_args()
    if args.cmd == "grid" and not args.out:
        args.out = "grid.png"
    args.fn(args)


if __name__ == "__main__":
    main()
