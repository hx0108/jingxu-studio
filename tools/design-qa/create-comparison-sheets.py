from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
REFERENCE_DIR = ROOT / "designs" / "jingxu-ai-drama-prototype" / "reference-originals"
OUTPUT_DIR = ROOT / "test-results" / "design-qa"


def newest_implementation_dir() -> Path:
    screenshots = sorted(
        (path for path in (ROOT / "test-results").rglob("01-开始创作.png")),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not screenshots:
        raise RuntimeError("未找到正式应用的十页截图")
    return screenshots[0].parent


def fit(image: Image.Image, width: int, height: int) -> Image.Image:
    copy = image.copy()
    copy.thumbnail((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (width, height), "#080d12")
    canvas.paste(copy, ((width - copy.width) // 2, (height - copy.height) // 2))
    return canvas


def main() -> None:
    implementation_dir = newest_implementation_dir()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    titles = [
        "开始创作",
        "我的作品",
        "故事构思",
        "剧本完善",
        "分镜设计",
        "画面生成",
        "视频生成",
        "合成导出",
        "质量评测",
        "设置",
    ]
    tile_width, tile_height, label_height = 720, 486, 34
    sheet = Image.new("RGB", (tile_width * 2, (tile_height + label_height) * 10), "#05090d")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()

    for index, title in enumerate(titles, start=1):
        reference = Image.open(REFERENCE_DIR / f"page-{index:02d}.png").convert("RGB")
        implementation = Image.open(implementation_dir / f"{index:02d}-{title}.png").convert("RGB")
        top = (index - 1) * (tile_height + label_height)
        sheet.paste(fit(reference, tile_width, tile_height), (0, top + label_height))
        sheet.paste(fit(implementation, tile_width, tile_height), (tile_width, top + label_height))
        draw.text((12, top + 10), f"{index:02d} {title} - source", fill="#ffffff", font=font)
        draw.text((tile_width + 12, top + 10), f"{index:02d} {title} - implementation", fill="#ffffff", font=font)

        pair = Image.new("RGB", (tile_width * 2, tile_height + label_height), "#05090d")
        pair_draw = ImageDraw.Draw(pair)
        pair.paste(fit(reference, tile_width, tile_height), (0, label_height))
        pair.paste(fit(implementation, tile_width, tile_height), (tile_width, label_height))
        pair_draw.text((12, 10), f"{title} - source", fill="#ffffff", font=font)
        pair_draw.text((tile_width + 12, 10), f"{title} - implementation", fill="#ffffff", font=font)
        pair.save(OUTPUT_DIR / f"pair-{index:02d}.png", optimize=True)

    sheet.save(OUTPUT_DIR / "ten-page-comparison.png", optimize=True)
    print(OUTPUT_DIR / "ten-page-comparison.png")


if __name__ == "__main__":
    main()
