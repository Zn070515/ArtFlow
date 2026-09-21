import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from accounts.models import User
from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, RULESET_FREEZE, authority_write
from core.models import Activity
from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.urls import reverse
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import StageResult

from .models import PublicMedia, PublicPost, ResultRelease


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


class PublicPortalVisibilityTests(TestCase):
    def setUp(self):
        with authority_write(ACTIVITY_STATE):
            self.formal = Activity.objects.create(
                title="Formal Contest",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=False,
            )
            self.testing = Activity.objects.create(
                title="Test Contest",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.REGISTRATION_OPEN,
                is_test_mode=True,
            )

    def _showcase(self, title, activity):
        return PublicPost.objects.create(
            title=title,
            post_type=PublicPost.PostType.SHOWCASE,
            status=PublicPost.Status.PUBLISHED,
            related_activity=activity,
        )

    def test_home_hides_test_related_published_post(self):
        self._showcase("Test Showcase", self.testing)
        self._showcase("Formal Showcase", self.formal)
        PublicPost.objects.create(
            title="Null Showcase",
            post_type=PublicPost.PostType.SHOWCASE,
            status=PublicPost.Status.PUBLISHED,
        )
        response = self.client.get(reverse("public_portal:home"))
        titles = [post.title for post in response.context["showcases"]]
        self.assertIn("Formal Showcase", titles)
        self.assertIn("Null Showcase", titles)
        self.assertNotIn("Test Showcase", titles)

    def test_post_detail_test_related_published_returns_404(self):
        test_post = self._showcase("Test Showcase", self.testing)
        self.client.raise_request_exception = False
        response = self.client.get(reverse("public_portal:post_detail", args=[test_post.pk]))
        self.assertEqual(response.status_code, 404)

    def test_historical_test_published_row_still_hidden(self):
        # Legacy dirty data: a TEST-related post that was published directly.
        legacy = PublicPost.objects.create(
            title="Legacy Test",
            status=PublicPost.Status.PUBLISHED,
            related_activity=self.testing,
        )
        self.client.raise_request_exception = False
        response = self.client.get(reverse("public_portal:post_detail", args=[legacy.pk]))
        self.assertEqual(response.status_code, 404)
        # It is kept in the DB (not deleted), just never served publicly.
        self.assertTrue(PublicPost.objects.filter(pk=legacy.pk).exists())

    def test_formal_published_post_is_public(self):
        formal_post = self._showcase("Formal Showcase", self.formal)
        response = self.client.get(reverse("public_portal:post_detail", args=[formal_post.pk]))
        self.assertEqual(response.status_code, 200)


class ResultReleaseModelTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="result-release-admin",
                password="pass",
                role=User.Role.ADMIN,
            )
        with authority_write(ACTIVITY_STATE):
            self.activity = Activity.objects.create(
                title="Formal Result Activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.RESULTS_PUBLISHED,
                is_test_mode=False,
            )
            self.other_activity = Activity.objects.create(
                title="Other Formal Activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.RESULTS_PUBLISHED,
                is_test_mode=False,
            )
        self.ruleset = ContestRuleset.objects.create(
            activity=self.activity,
            name="Release Ruleset",
            stage_key="final",
        )
        with authority_write(RULESET_FREEZE):
            self.ruleset_version = RulesetVersion.objects.create(
                ruleset=self.ruleset,
                version=1,
                definition=(
                    '{"schema_version": 1, "nodes": ['
                    '{"key": "release-stage", "type": "ASSESS", '
                    '"source": "entry", "vote_source": "release-source"}]}'
                ),
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                authority_hash="a" * 64,
            )
        self.stage_result = StageResult.objects.create(
            activity=self.activity,
            ruleset_version=self.ruleset_version,
            stage_key="final",
            status=StageResult.Status.READY_TO_CONFIRM,
            ruleset_hash=self.ruleset_version.authority_hash,
            input_fingerprint="b" * 64,
            result_version=3,
            is_test_data=False,
        )
        self.post = PublicPost.objects.create(
            title="Final Result",
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.PUBLISHED,
            related_activity=self.activity,
            version=7,
        )

    def make_release(self, *, post=None, stage_result=None, status=None):
        stage_result = stage_result or self.stage_result
        return ResultRelease(
            post=post or self.post,
            stage_result=stage_result,
            post_version=(post or self.post).version,
            result_version=stage_result.result_version,
            ruleset_version=self.ruleset_version,
            authority_hash=self.ruleset_version.authority_hash,
            input_fingerprint=stage_result.input_fingerprint,
            status=status or ResultRelease.Status.ACTIVE,
            released_by=self.operator,
            note="Reviewed final result release",
        )

    def test_result_release_has_historical_statuses_and_persists_provenance(self):
        self.assertEqual(
            set(ResultRelease.Status.values),
            {"active", "revoked", "superseded"},
        )
        release = self.make_release()
        release.full_clean()
        release.save()

        stored = ResultRelease.objects.get(pk=release.pk)
        self.assertEqual(stored.post_version, 7)
        self.assertEqual(stored.result_version, 3)
        self.assertEqual(stored.authority_hash, "a" * 64)
        self.assertEqual(stored.input_fingerprint, "b" * 64)
        self.assertNotIn("authority_hash", {field.name for field in PublicPost._meta.get_fields()})
        self.assertNotIn(
            "input_fingerprint", {field.name for field in PublicPost._meta.get_fields()}
        )

    def test_only_one_active_release_can_target_each_post(self):
        self.make_release().save()
        duplicate = self.make_release()
        with self.assertRaises((IntegrityError, ValidationError)):
            with transaction.atomic():
                duplicate.save()

    def test_only_one_active_release_can_target_each_stage_result(self):
        self.make_release().save()
        other_post = PublicPost.objects.create(
            title="Other Result Post",
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.PUBLISHED,
            related_activity=self.activity,
        )
        duplicate = self.make_release(post=other_post)
        with self.assertRaises((IntegrityError, ValidationError)):
            with transaction.atomic():
                duplicate.save()

    def test_active_release_rejects_post_and_stage_result_activity_mismatch(self):
        other_post = PublicPost.objects.create(
            title="Foreign Result Post",
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.PUBLISHED,
            related_activity=self.other_activity,
        )
        release = self.make_release(post=other_post)
        with self.assertRaises(ValidationError):
            release.full_clean()
