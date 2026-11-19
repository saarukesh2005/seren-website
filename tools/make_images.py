"""Turn the AI-upscaled PDF images into sharp, web-ready WebP images for the SEREN site.

Run tools/upscale.py first (it fills source/upscaled/), then:
  /opt/anaconda3/envs/pdf/bin/python tools/make_images.py
"""
import glob, os
from PIL import Image, ImageDraw, ImageFilter

RAW = "source/raw"
UPSCALED = "source/upscaled"
OUT = "src/img"
MAX = 1100            # default longest side, enough for 2x screens at the size it's shown
QUALITY = 86

# id -> (raw file prefix, options)
M = {
 "bomb-tiramisu": ("p013_x6878", {}),
 "bomb-cheesecake": ("p003_x3497", {}),
 "bomb-vanilla": ("p015_x6921", {}),
 "bomb-hazelnut": ("p016_x6932", {}),
 "bomb-strawberry": ("p017_x6940", {}),
 "bomb-chocolate": ("p012_x6870", {}),
 "bomb-miso": ("p018_x6954", {"crop_bottom": 0.16}),
 "cookie-biscoff": ("p021_x6981", {"crop_left": 0.03}),
 "cookie-biscoff-x": ("p021_x6987", {}),
 "cookie-seasalt": ("p022_x6992", {}),
 "cookie-brownie": ("p023_x6999", {}),
 "cookie-triple": ("p024_x7029", {}),
 "cookie-hazelnut": ("p025_x7037", {}),
 "cookie-matcha": ("p026_x7044", {}),
 "cookie-redvelvet": ("p027_x7053", {}),
 "tiramisu": ("p029_x7141", {}),
 "tart-hazelnut": ("p041_x7199", {}),
 "tart-citron": ("p042_x7215", {}),
 "choux-classic": ("p043_x7152", {}),
 "choux-almond": ("p044_x7251", {}),
 "choux-almond-x": ("p045_x7255", {}),
 "choux-matcha": ("p046_x7265", {}),
 "choux-matcha-x": ("p047_x7272", {}),
 "fruit-strawberry": ("p098_x7726", {}),
 "fruit-cocoa": ("p099_x7732", {}),
 "fruit-coconut": ("p089_x7623", {}),
 "fruit-coffee": ("p092_x7637", {}),
 "fruit-pear": ("p081_x7543", {}),
 "fruit-banana": ("p083_x7571", {}),
 "fruit-mango": ("p095_x7683", {"crop": (0, 0, 0.59, 0.89), "cutout": "dark"}),
 "fruit-blueberry": ("p085_x7580", {}),
 "fruit-almond": ("p097_x7693", {"crop": (0.05, 0.08, 0.95, 0.88)}),
 "truffle-classic": ("p147_x8236", {}),
 "truffle-praline": ("p149_x8252", {}),
 "bonbon-caramel": ("p152_x8302", {"cutout": "dark"}),
 "bonbon-almond": ("p153_x8311", {"cutout": "dark"}),
 "bonbon-coconut": ("p154_x8321", {"cutout": "dark"}),
 "bonbon-hazelnut": ("p155_x8349", {"cutout": "dark"}),
 "bonbon-coffee": ("p157_x8395", {"cutout": "dark"}),
 "slab-garlic": ("p117_x7926", {}),
 "slab-pepper": ("p118_x7954", {}),
 "slab-paneer": ("p119_x7960", {}),
 "slab-veg": ("p120_x7965", {}),
 "arancini": ("p105_x7809", {}),
 "croquettes": ("p106_x7835", {}),
 "charred-pizza": ("p109_x7848", {}),
 "brochette": ("p113_x7893", {}),
 "onion-mousse": ("p114_x7896", {}),
 "burrata": ("p115_x7905", {}),
 "risotto-charcoal": ("p127_x8056", {}),
 "risotto-prawn": ("p130_x8074", {}),
 "parmigiana": ("p132_x8109", {}),
 "lasagna": ("p134_x8117", {}),
 "supreme": ("p136_x8127", {}),
 "quail": ("p139_x8168", {}),
 "tacos": ("p141_x8185", {}),
 "wings": ("p144_x8224", {}),
}


BIG = {"choux-almond", "choux-almond-x", "choux-matcha", "choux-matcha-x"}   # shown at half the page width
SMALL = {"bonbon-caramel", "bonbon-almond", "bonbon-coconut", "bonbon-hazelnut", "bonbon-coffee"}


def source(prefix):
    up = f"{UPSCALED}/{prefix}.png"
    if os.path.exists(up):
        return Image.open(up)
    hits = glob.glob(f"{RAW}/{prefix}_*")
    if not hits:
        raise FileNotFoundError(prefix)
    print("  (not upscaled yet, using original)", prefix)
    return Image.open(hits[0])


def cutout_dark(im):
    """Lift a sticker-style subject off a black backdrop with a soft, clean edge (no jagged pixels)."""
    rgb = im.convert("RGB")
    w, h = rgb.size
    work = rgb.copy()
    marker = (255, 0, 255)
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if work.getpixel(seed) != marker:
            ImageDraw.floodfill(work, seed, marker, thresh=70)
    mask = Image.new("L", (w, h), 0)
    mpx, wpx = mask.load(), work.load()
    for y in range(h):
        for x in range(w):
            if wpx[x, y] != marker:
                mpx[x, y] = 255
    mask = mask.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(1.6))
    out = rgb.convert("RGBA")
    out.putalpha(mask)
    return out.crop(out.getbbox())


def process(name, prefix, opt):
    im = source(prefix)
    w, h = im.size
    if opt.get("crop"):
        l, t, r, b = opt["crop"]
        im = im.crop((int(w * l), int(h * t), int(w * r), int(h * b)))
    if opt.get("crop_bottom"):
        im = im.crop((0, 0, im.size[0], int(im.size[1] * (1 - opt["crop_bottom"]))))
    if opt.get("crop_left"):
        im = im.crop((int(im.size[0] * opt["crop_left"]), 0, im.size[0], im.size[1]))
    limit = 1500 if name in BIG else 700 if name in SMALL else MAX
    if opt.get("cutout") == "dark":
        im = cutout_dark(im)
        im.thumbnail((limit, limit), Image.LANCZOS)
        im.save(f"{OUT}/{name}.webp", quality=QUALITY, method=6)
        return
    im = im.convert("RGB")
    im.thumbnail((limit, limit), Image.LANCZOS)
    im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=40, threshold=2))
    im.save(f"{OUT}/{name}.webp", quality=QUALITY, method=6)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(f"{OUT}/*.jpg") + glob.glob(f"{OUT}/*.png"):
        os.remove(old)
    for name, (prefix, opt) in M.items():
        process(name, prefix, opt)
    print(len(M), "images")
