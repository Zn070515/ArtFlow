import shutil
import tempfile
from pathlib import Path

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse

from .models import PublicMedia, PublicPost


class PublicPhotoImportTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.source_root = Path(tempfile.mkdtemp())
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media_root, ignore_errors=True)
        shutil.rmtree(self.source_root, ignore_errors=True)

    def test_import_public_photos_creates_showcase_posts_and_home_gallery(self):
        event_dir = self.source_root / "院十佳"
        event_dir.mkdir()
        (event_dir / "photo1.jpg").write_bytes(
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00H\x00H\x00\x00\xff\xd9"
        )

        internal_dir = self.source_root / "会议照片"
        internal_dir.mkdir()
        (internal_dir / "meeting.jpg").write_bytes(
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00H\x00H\x00\x00\xff\xd9"
        )

        call_command("import_public_photos", str(self.source_root), "--publish")

        post = PublicPost.objects.get(title="院十佳")
        self.assertEqual(post.status, PublicPost.Status.PUBLISHED)
        self.assertEqual(post.post_type, PublicPost.PostType.SHOWCASE)
        self.assertTrue(post.cover_image)
        self.assertEqual(PublicMedia.objects.filter(post=post).count(), 1)
        self.assertFalse(PublicPost.objects.filter(title="会议照片").exists())

        home = self.client.get(reverse("public_portal:home"))
        self.assertContains(home, "活动掠影")
        self.assertContains(home, "院十佳")

        detail = self.client.get(reverse("public_portal:post_detail", args=[post.pk]))
        self.assertContains(detail, "活动相册")
        self.assertContains(detail, "院十佳")
