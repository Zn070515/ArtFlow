import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings
from django.urls import reverse

from .models import PublicMedia, PublicPost


class PublicPhotoImportTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.source_root = Path(self.media_root) / "public_photo_imports" / "batch"
        self.source_root.mkdir(parents=True)
        self.outside_source_root = Path(tempfile.mkdtemp())
        self.created_links = []
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()

    def tearDown(self):
        self.override.disable()
        self.remove_created_links()
        shutil.rmtree(self.media_root, ignore_errors=True)
        shutil.rmtree(self.outside_source_root, ignore_errors=True)

    def remove_created_links(self):
        for link_path, link_type in self.created_links:
            if link_type == "symlink":
                try:
                    link_path.unlink()
                except FileNotFoundError:
                    continue
            elif link_type == "junction" and os.name == "nt" and link_path.exists():
                subprocess.run(
                    ["cmd", "/d", "/c", "rmdir", str(link_path)],
                    check=True,
                    capture_output=True,
                    text=True,
                )

    def write_jpeg(self, image_path):
        image_path.write_bytes(
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00H\x00H\x00\x00\xff\xd9"
        )

    def test_import_public_photos_creates_showcase_posts_and_home_gallery(self):
        event_dir = self.source_root / "院十佳"
        event_dir.mkdir()
        self.write_jpeg(event_dir / "photo1.jpg")

        internal_dir = self.source_root / "会议照片"
        internal_dir.mkdir()
        self.write_jpeg(internal_dir / "meeting.jpg")

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

    def test_import_public_photos_rejects_a_source_directory_outside_media_staging(self):
        outside_album = self.outside_source_root / "outside"
        outside_album.mkdir()

        with self.assertRaises(CommandError):
            call_command("import_public_photos", str(self.outside_source_root))

    def test_import_public_photos_skips_symlinked_album_outside_source_batch(self):
        external_album = self.outside_source_root / "external-album"
        external_album.mkdir()
        self.write_jpeg(external_album / "external.jpg")
        linked_album = self.source_root / "linked-album"

        try:
            os.symlink(external_album, linked_album, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Directory symlinks are unavailable: {error}")
        self.created_links.append((linked_album, "symlink"))

        call_command("import_public_photos", str(self.source_root))

        self.assertFalse(PublicPost.objects.filter(title="linked-album").exists())
        self.assertFalse(PublicMedia.objects.exists())
        self.remove_created_links()
        self.assertTrue((external_album / "external.jpg").exists())

    def test_import_public_photos_skips_windows_junction_outside_source_batch(self):
        if os.name != "nt":
            self.skipTest("Windows junctions are only available on Windows.")

        external_album = self.outside_source_root / "external-album"
        external_album.mkdir()
        self.write_jpeg(external_album / "external.jpg")
        linked_album = self.source_root / "linked-album"
        junction = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(linked_album), str(external_album)],
            check=False,
            capture_output=True,
            text=True,
        )
        if junction.returncode != 0:
            self.skipTest(f"Unable to create Windows junction: {junction.stderr}")
        self.created_links.append((linked_album, "junction"))

        call_command("import_public_photos", str(self.source_root))

        self.assertFalse(PublicPost.objects.filter(title="linked-album").exists())
        self.assertFalse(PublicMedia.objects.exists())
        self.remove_created_links()
        self.assertTrue((external_album / "external.jpg").exists())
