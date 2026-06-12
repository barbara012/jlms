from pathlib import Path

from PIL import Image, ImageDraw
import subprocess
import shutil


ROOT = Path("/Users/hwh/apps/fk_surge/src-tauri/icons")
ROOT.mkdir(parents=True, exist_ok=True)

CANVAS = 1024
BACKGROUND = (7, 9, 13, 255)
LEFT = (82, 216, 240)
RIGHT = (138, 240, 140)


def lerp_color(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_gradient_bar(
    img: Image.Image,
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    width: int,
    height: int,
) -> None:
    radius = width // 2
    gradient = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    gradient_draw = ImageDraw.Draw(gradient)
    for row in range(height):
        t = row / max(1, height - 1)
        color = lerp_color(LEFT, RIGHT, t) + (255,)
        gradient_draw.rectangle((0, row, width, row + 1), fill=color)

    mask = Image.new("L", (width, height), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((0, 0, width, height), radius=radius, fill=255)
    img.paste(gradient, (x, y), mask)


def build_icon() -> Image.Image:
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = 58
    draw.rounded_rectangle(
        (margin, margin, CANVAS - margin, CANVAS - margin),
        radius=168,
        fill=BACKGROUND,
    )

    bars = [
        (250, 585, 74, 176),
        (368, 470, 74, 333),
        (486, 255, 74, 517),
        (604, 205, 74, 470),
        (722, 350, 74, 170),
    ]
    for bar in bars:
        rounded_gradient_bar(img, draw, *bar)

    return img


def save_sizes(img: Image.Image) -> None:
    mapping = {
        "icon.png": 1024,
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }

    for name, size in mapping.items():
        img.resize((size, size), Image.Resampling.LANCZOS).save(ROOT / name)

    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(ROOT / "icon.ico", sizes=ico_sizes)


def save_icns(img: Image.Image) -> None:
    iconset = ROOT / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()

    mapping = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for name, size in mapping.items():
        img.resize((size, size), Image.Resampling.LANCZOS).save(iconset / name)

    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(ROOT / "icon.icns")],
        check=True,
    )
    shutil.rmtree(iconset)


def main() -> None:
    img = build_icon()
    save_sizes(img)
    save_icns(img)
    print("icons updated")


if __name__ == "__main__":
    main()
