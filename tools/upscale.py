"""AI-upscale the SEREN product images (Real-ESRGAN x4) into source/upscaled/.

Run with the `video` conda env (has torch + spandrel):
  /opt/anaconda3/envs/video/bin/python tools/upscale.py
"""
import glob
import os
import sys

import numpy as np
import torch
from PIL import Image
from spandrel import ModelLoader

sys.path.insert(0, os.path.dirname(__file__))
from make_images import M, RAW  # noqa: E402  (image list lives in one place)

MODEL = os.path.join(os.path.dirname(__file__), "models", "RealESRGAN_x4plus.pth")
OUT = "source/upscaled"
TARGET = 1600          # longest side we keep after upscaling
TILE = 384             # tile size keeps memory low on the GPU


def load_model():
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = ModelLoader().load_from_file(MODEL).to(device).eval()
    return model, device


@torch.inference_mode()
def upscale(model, device, im):
    x = torch.from_numpy(np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0).permute(2, 0, 1)[None]
    _, _, h, w = x.shape
    out = torch.zeros((1, 3, h * 4, w * 4))
    for y0 in range(0, h, TILE):
        for x0 in range(0, w, TILE):
            pad = 16
            ys, xs = max(y0 - pad, 0), max(x0 - pad, 0)
            ye, xe = min(y0 + TILE + pad, h), min(x0 + TILE + pad, w)
            tile = model(x[:, :, ys:ye, xs:xe].to(device)).cpu()
            oy, ox = (y0 - ys) * 4, (x0 - xs) * 4
            th, tw = min(TILE, h - y0) * 4, min(TILE, w - x0) * 4
            out[:, :, y0 * 4:y0 * 4 + th, x0 * 4:x0 * 4 + tw] = tile[:, :, oy:oy + th, ox:ox + tw]
    arr = (out[0].clamp(0, 1).permute(1, 2, 0).numpy() * 255).round().astype(np.uint8)
    return Image.fromarray(arr)


def main():
    os.makedirs(OUT, exist_ok=True)
    model, device = load_model()
    prefixes = sorted({p for p, _ in M.values()} | set(sys.argv[1:]))
    for prefix in prefixes:
        dst = f"{OUT}/{prefix}.png"
        if os.path.exists(dst):
            continue
        hits = glob.glob(f"{RAW}/{prefix}_*")
        if not hits:
            print("missing", prefix)
            continue
        im = Image.open(hits[0])
        if max(im.size) >= TARGET:
            big = im.convert("RGB")
        else:
            big = upscale(model, device, im)
            big.thumbnail((TARGET, TARGET), Image.LANCZOS)
        big.save(dst)
        print("ok", prefix, im.size, "->", big.size, flush=True)


if __name__ == "__main__":
    main()
