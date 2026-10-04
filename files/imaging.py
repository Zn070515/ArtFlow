"""Metadata-free image derivatives (GOAL §19.3).

The original upload stays ``PRIVATE``; anything handed to a public viewer is a

    validate / decode → strip metadata / re-encode → Approved Public Derivative

re-encode. Phone photos routinely carry EXIF GPS coordinates, so republishing the raw
bytes would publish where the photographer stood. Video is not re-encoded (that needs an
ffmpeg dependency the project does not carry) and non-images pass through untouched.
"""

from __future__ import annotations

import io
from pathlib import PurePath

from django.core.files import File
from django.core.files.base import ContentFile
from PIL import Image, ImageOps, UnidentifiedImageError

IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})

_FORMAT_BY_EXTENSION = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}


def is_image_name(name: str | None) -> bool:
    """Whether this file name is one of the formats the sanitizer can re-encode."""
    return PurePath(str(name or "")).suffix.lower() in IMAGE_EXTENSIONS


def sanitize_image_bytes(raw: bytes, *, name: str) -> bytes | None:
    """Return ``raw`` re-encoded without EXIF/ICC, or ``None`` when it is not usable.

    ``None`` means "keep the original as-is": an upload that Pillow cannot decode has
    already passed the container check, and turning it into an error here would reject a
    file the old path accepted.
    """
    image_format = _FORMAT_BY_EXTENSION.get(PurePath(str(name or "")).suffix.lower())
    if image_format is None:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as image:
            # Bake the EXIF orientation into the pixels first — dropping the metadata
            # without this would rotate every portrait photo on the public page.
            rendered = ImageOps.exif_transpose(image)
            if image_format == "JPEG":
                rendered = rendered.convert("RGB")
            elif rendered.mode not in {"RGB", "RGBA"}:
                rendered = rendered.convert("RGBA")
            buffer = io.BytesIO()
            # Deliberately no exif= / icc_profile= argument: only pixels are written back.
            rendered.save(buffer, format=image_format, optimize=True)
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    return buffer.getvalue()


def sanitize_upload(uploaded_file: File) -> File:
    """Return a sanitized copy of an upload, or the upload itself when nothing to do.

    Safe on any upload: non-images and undecodable payloads are returned unchanged, so
    callers do not need to pre-check the file type.
    """
    name = str(getattr(uploaded_file, "name", "") or "")
    if not is_image_name(name):
        return uploaded_file
    raw = uploaded_file.read()
    try:
        uploaded_file.seek(0)
    except (AttributeError, OSError):
        pass
    cleaned = sanitize_image_bytes(raw, name=name)
    if cleaned is None:
        return uploaded_file
    return ContentFile(cleaned, name=PurePath(name).name)
