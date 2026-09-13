"""Crop the existing repository logo for platform application icons."""
from pathlib import Path
from PIL import Image

apps = Path(__file__).resolve().parents[1]
with Image.open(apps.parents[1] / 'assets/logo.png') as source:
    edge = round(source.height * .72)
    left = (source.width - edge) // 2
    top = round(source.height * .04)
    resampling = getattr(Image, 'Resampling', Image)
    icon = source.crop((left, top, left + edge, top + edge)).resize((512, 512), resampling.LANCZOS)
    (apps / 'assets').mkdir(exist_ok=True)
    icon.save(apps / 'assets/icon.png')
