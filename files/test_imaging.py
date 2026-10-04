"""GOAL §19.3: the public rendition of an image carries no metadata."""

from io import BytesIO

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase
from PIL import Image

from .imaging import IMAGE_EXTENSIONS, is_image_name, sanitize_image_bytes, sanitize_upload

_DESCRIPTION_TAG = 0x010E
_GPS_TAG = 0x8825


def _jpeg_with_metadata() -> bytes:
    image = Image.new("RGB", (24, 16), (10, 120, 200))
    exif = Image.Exif()
    exif[_DESCRIPTION_TAG] = "GPS 39.9,116.3"
    exif[0x0112] = 6  # Orientation: rotate 90° clockwise on display
    buffer = BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    return buffer.getvalue()


class SanitizeImageTests(SimpleTestCase):
    def test_image_names_are_recognised_by_extension(self):
        for name in ("a.jpg", "a.JPEG", "a.png", "a.webp"):
            self.assertTrue(is_image_name(name), name)
        for name in ("a.mp3", "a.mp4", "a.pdf", "", None):
            self.assertFalse(is_image_name(name), name)
        self.assertEqual(IMAGE_EXTENSIONS, frozenset({".jpg", ".jpeg", ".png", ".webp"}))

    def test_re_encode_strips_metadata_and_bakes_in_the_orientation(self):
        source = _jpeg_with_metadata()
        with Image.open(BytesIO(source)) as original:
            self.assertIn(_DESCRIPTION_TAG, original.getexif())

        cleaned = sanitize_image_bytes(source, name="poster.jpg")

        self.assertIsNotNone(cleaned)
        with Image.open(BytesIO(cleaned)) as derived:  # type: ignore[arg-type]
            # Orientation 6 was baked into the pixels. Dropping the tag without this
            # would rotate every portrait photo on the public page.
            self.assertEqual(derived.size, (16, 24))
            self.assertEqual(len(derived.getexif()), 0)

    def test_re_encode_of_an_upright_image_keeps_its_dimensions(self):
        buffer = BytesIO()
        Image.new("RGB", (24, 16), (10, 120, 200)).save(buffer, format="JPEG")

        cleaned = sanitize_image_bytes(buffer.getvalue(), name="poster.jpg")

        self.assertIsNotNone(cleaned)
        with Image.open(BytesIO(cleaned)) as derived:  # type: ignore[arg-type]
            self.assertEqual(derived.size, (24, 16))

    def test_an_undecodable_payload_is_left_alone(self):
        self.assertIsNone(sanitize_image_bytes(b"not an image", name="poster.jpg"))

    def test_a_non_image_name_is_left_alone(self):
        self.assertIsNone(sanitize_image_bytes(b"ID3\x00", name="song.mp3"))

    def test_sanitize_upload_passes_a_non_image_through_untouched(self):
        upload = SimpleUploadedFile("song.mp3", b"ID3\x00", content_type="audio/mpeg")

        self.assertIs(sanitize_upload(upload), upload)

    def test_sanitize_upload_replaces_an_image_with_clean_bytes(self):
        upload = SimpleUploadedFile("poster.jpg", _jpeg_with_metadata(), content_type="image/jpeg")

        cleaned = sanitize_upload(upload)

        self.assertIsNot(cleaned, upload)
        self.assertEqual(cleaned.name, "poster.jpg")
        with Image.open(BytesIO(cleaned.read())) as derived:  # type: ignore[union-attr, arg-type]
            self.assertEqual(len(derived.getexif()), 0)
