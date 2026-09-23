import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from accounts.models import User
from common.authority import (
    ACCOUNT_AUTHORITY,
    ACTIVITY_STATE,
    RULESET_FREEZE,
    STAGE_RESULT_CONFIRM,
    authority_write,
)
from common.models import AuditLog
from core.models import Activity
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from ruleset.models import ContestRuleset, RulesetVersion
from singer_contest.models import StageResult

from .models import PublicMedia, PublicPost, ResultRelease


def _close_file_response_resources(response):
    """Close the streamed file without firing request_finished in TestCase."""
    closers = getattr(response, "_resource_closers", [])
    filelikes = []
    filelike = getattr(response, "file_to_stream", None)
    if filelike is not None and hasattr(filelike, "read") and hasattr(filelike, "close"):
        filelikes.append(filelike)
    for closer in closers:
        resource = getattr(closer, "__self__", None)
        if (
            resource is not None
            and hasattr(resource, "read")
            and hasattr(resource, "close")
            and all(resource is not existing for existing in filelikes)
        ):
            filelikes.append(resource)
    if not filelikes:
        return
    for filelike in filelikes:
        filelike.close()
    response.file_to_stream = None
    closers.clear()


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

    @override_settings(ARTFLOW_ORGANIZATION_NAME="示例主办方")
    def test_home_uses_configured_organization_without_institution_branding(self):
        response = self.client.get(reverse("public_portal:home"))
        self.assertContains(response, "示例主办方")
        self.assertNotContains(response, "浙江工业大学")
        self.assertNotContains(response, "信息工程学院")


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

    def test_active_release_requires_result_publication_post(self):
        announcement = PublicPost.objects.create(
            title="Announcement Cannot Carry Result Authority",
            post_type=PublicPost.PostType.ANNOUNCEMENT,
            status=PublicPost.Status.PUBLISHED,
            related_activity=self.activity,
        )
        release = self.make_release(post=announcement)
        with self.assertRaises(ValidationError):
            release.full_clean()

    def test_active_release_requires_published_result_post(self):
        draft = PublicPost.objects.create(
            title="Draft Cannot Carry Active Result Authority",
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.DRAFT,
            related_activity=self.activity,
        )
        release = self.make_release(post=draft)
        with self.assertRaises(ValidationError):
            release.full_clean()


class ResultReleaseVisibilityTests(ResultReleaseModelTests):
    def confirm_stage_result(self):
        with authority_write(STAGE_RESULT_CONFIRM):
            self.stage_result.status = StageResult.Status.CONFIRMED
            self.stage_result.confirmed_by = self.operator
            self.stage_result.confirmed_at = timezone.now()
            self.stage_result.save(update_fields=["status", "confirmed_by", "confirmed_at"])

    def create_public_media(self):
        return PublicMedia.objects.create(
            post=self.post,
            related_activity=self.activity,
            image="public/gallery/result.jpg",
            caption="Result media",
        )

    def test_published_result_without_active_release_is_private_everywhere(self):
        media = self.create_public_media()
        home = self.client.get(reverse("public_portal:home"))
        result_list = self.client.get(reverse("public_portal:result_list"))
        self.client.raise_request_exception = False
        detail = self.client.get(reverse("public_portal:post_detail", args=[self.post.pk]))

        self.assertNotIn(self.post, list(home.context["results"]))
        self.assertNotIn(self.post, list(home.context["activity_photos"]))
        self.assertNotContains(result_list, self.post.title)
        self.assertNotEqual(detail.status_code, 200)
        self.assertTrue(PublicMedia.objects.filter(pk=media.pk).exists())

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            media_path = Path(media_root) / "public/gallery/result.jpg"
            media_path.parent.mkdir(parents=True)
            media_path.write_bytes(b"private-result-media")
            response = self.client.get(
                reverse("controlled_media", kwargs={"path": "public/gallery/result.jpg"})
            )
            _close_file_response_resources(response)
        self.assertNotEqual(response.status_code, 200)

    def test_active_release_is_visible_through_all_public_result_paths(self):
        self.confirm_stage_result()
        release = self.make_release()
        release.save()
        media = self.create_public_media()

        home = self.client.get(reverse("public_portal:home"))
        result_list = self.client.get(reverse("public_portal:result_list"))
        detail = self.client.get(reverse("public_portal:post_detail", args=[self.post.pk]))

        self.assertIn(self.post, list(home.context["results"]))
        self.assertIn(media, list(home.context["activity_photos"]))
        self.assertContains(result_list, self.post.title)
        self.assertEqual(detail.status_code, 200)
        self.assertIn(media, list(detail.context["media_items"]))

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            media_path = Path(media_root) / "public/gallery/result.jpg"
            media_path.parent.mkdir(parents=True)
            media_path.write_bytes(b"public-result-media")
            response = self.client.get(
                reverse("controlled_media", kwargs={"path": "public/gallery/result.jpg"})
            )
            _close_file_response_resources(response)
        self.assertEqual(response.status_code, 200)

    def test_revoked_and_superseded_releases_are_not_public(self):
        for status in (ResultRelease.Status.REVOKED, ResultRelease.Status.SUPERSEDED):
            with self.subTest(status=status):
                release = self.make_release(status=status)
                release.save()
                self.client.raise_request_exception = False
                response = self.client.get(
                    reverse("public_portal:post_detail", args=[self.post.pk])
                )
                self.assertEqual(response.status_code, 404)
                release.delete()

    def test_release_is_hidden_after_post_version_changes(self):
        self.confirm_stage_result()
        release = self.make_release()
        release.save()
        self.post.version += 1
        self.post.save(update_fields=["version"])

        self.client.raise_request_exception = False
        response = self.client.get(reverse("public_portal:post_detail", args=[self.post.pk]))
        self.assertEqual(response.status_code, 404)

    def test_release_is_hidden_when_a_newer_stage_result_exists(self):
        self.confirm_stage_result()
        release = self.make_release()
        release.save()
        StageResult.objects.create(
            activity=self.activity,
            ruleset_version=self.ruleset_version,
            stage_key=self.stage_result.stage_key,
            status=StageResult.Status.READY_TO_CONFIRM,
            ruleset_hash=self.ruleset_version.authority_hash,
            input_fingerprint="c" * 64,
            result_version=self.stage_result.result_version + 1,
            is_test_data=False,
        )

        self.client.raise_request_exception = False
        response = self.client.get(reverse("public_portal:post_detail", args=[self.post.pk]))
        self.assertEqual(response.status_code, 404)

    def test_release_is_hidden_for_non_current_ruleset_snapshot(self):
        self.confirm_stage_result()
        alternate_version = RulesetVersion.objects.create(
            ruleset=self.ruleset,
            version=2,
            definition=(
                '{"schema_version": 1, "nodes": ['
                '{"key": "alternate-stage", "type": "ASSESS", '
                '"source": "entry", "vote_source": "alternate-source"}]}'
            ),
            authority_hash="c" * 64,
        )
        release = self.make_release()
        release.ruleset_version = alternate_version
        release.save()

        self.client.raise_request_exception = False
        response = self.client.get(reverse("public_portal:post_detail", args=[self.post.pk]))
        self.assertEqual(response.status_code, 404)

    def test_active_release_for_test_activity_is_not_public(self):
        with authority_write(ACTIVITY_STATE):
            test_activity = Activity.objects.create(
                title="Test Result Activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                phase=Activity.Phase.RESULTS_PUBLISHED,
                is_test_mode=True,
            )
        test_ruleset = ContestRuleset.objects.create(
            activity=test_activity,
            name="Test Release Ruleset",
            stage_key="final",
            is_test_data=True,
        )
        with authority_write(RULESET_FREEZE):
            test_version = RulesetVersion.objects.create(
                ruleset=test_ruleset,
                version=1,
                definition=(
                    '{"schema_version": 1, "nodes": ['
                    '{"key": "test-stage", "type": "ASSESS", '
                    '"source": "entry", "vote_source": "test-source"}]}'
                ),
                status=RulesetVersion.Status.FROZEN,
                is_current=True,
                authority_hash="d" * 64,
            )
        test_stage = StageResult.objects.create(
            activity=test_activity,
            ruleset_version=test_version,
            stage_key="final",
            status=StageResult.Status.READY_TO_CONFIRM,
            ruleset_hash=test_version.authority_hash,
            input_fingerprint="e" * 64,
            is_test_data=True,
        )
        test_post = PublicPost.objects.create(
            title="Test Result",
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.PUBLISHED,
            related_activity=test_activity,
        )
        ResultRelease.objects.create(
            post=test_post,
            stage_result=test_stage,
            post_version=test_post.version,
            result_version=test_stage.result_version,
            ruleset_version=test_version,
            authority_hash=test_version.authority_hash,
            input_fingerprint=test_stage.input_fingerprint,
            released_by=self.operator,
            note="Test release",
        )

        self.client.raise_request_exception = False
        response = self.client.get(reverse("public_portal:post_detail", args=[test_post.pk]))
        self.assertEqual(response.status_code, 404)


class ResultReleaseServiceTests(ResultReleaseModelTests):
    def confirm_stage_result(self):
        with authority_write(STAGE_RESULT_CONFIRM):
            self.stage_result.status = StageResult.Status.CONFIRMED
            self.stage_result.confirmed_by = self.operator
            self.stage_result.confirmed_at = timezone.now()
            self.stage_result.save(update_fields=["status", "confirmed_by", "confirmed_at"])

    @patch(
        "public_portal.services.build_result_closure",
        return_value=SimpleNamespace(closeable=True),
    )
    def test_release_requires_confirmed_closed_current_result(self, closure):
        self.confirm_stage_result()

        from .services import release_result_post

        release = release_result_post(
            self.post,
            self.stage_result,
            self.operator,
            note="校对完成后正式公示",
        )

        self.assertEqual(release.status, ResultRelease.Status.ACTIVE)
        self.assertEqual(release.post_id, self.post.pk)
        self.assertEqual(release.stage_result_id, self.stage_result.pk)
        self.assertEqual(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.RELEASE_RESULT,
                target=f"PublicPost:{self.post.pk}",
            ).count(),
            1,
        )
        closure.assert_called_once()

    @patch(
        "public_portal.services.build_result_closure",
        return_value=SimpleNamespace(closeable=True),
    )
    def test_duplicate_release_is_idempotent_without_duplicate_audit(self, closure):
        self.confirm_stage_result()

        from .services import release_result_post

        first = release_result_post(
            self.post,
            self.stage_result,
            self.operator,
            note="首次发布",
        )
        second = release_result_post(
            self.post,
            self.stage_result,
            self.operator,
            note="重复点击发布",
        )

        self.assertEqual(first.pk, second.pk)
        self.assertEqual(
            ResultRelease.objects.filter(status=ResultRelease.Status.ACTIVE).count(), 1
        )
        self.assertEqual(
            AuditLog.objects.filter(action_type=AuditLog.ActionType.RELEASE_RESULT).count(),
            1,
        )
        self.assertEqual(closure.call_count, 2)

    def test_release_rejects_missing_note_and_non_admin(self):
        from .services import release_result_post

        with self.assertRaises(ValidationError):
            release_result_post(self.post, self.stage_result, self.operator, note=" ")

        with authority_write(ACCOUNT_AUTHORITY):
            staff = User.objects.create_user(
                username="result-release-staff",
                password="pass",
                role=User.Role.STAFF,
            )
        with self.assertRaises(PermissionDenied):
            release_result_post(
                self.post,
                self.stage_result,
                staff,
                note="staff cannot release",
            )

    @patch(
        "public_portal.services.build_result_closure",
        return_value=SimpleNamespace(closeable=True),
    )
    def test_revoke_preserves_history_and_hides_result(self, closure):
        self.confirm_stage_result()

        from .services import release_result_post, revoke_result_release

        release = release_result_post(
            self.post,
            self.stage_result,
            self.operator,
            note="首发",
        )
        revoked = revoke_result_release(self.post, self.operator, note="发现内容需修订")

        self.assertEqual(revoked.pk, release.pk)
        self.assertEqual(revoked.status, ResultRelease.Status.REVOKED)
        self.assertEqual(revoked.transition_by_id, self.operator.pk)
        self.assertEqual(ResultRelease.objects.count(), 1)
        self.assertEqual(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.REVOKE_RESULT,
                target=f"PublicPost:{self.post.pk}",
            ).count(),
            1,
        )
        self.client.raise_request_exception = False
        self.assertEqual(
            self.client.get(reverse("public_portal:post_detail", args=[self.post.pk])).status_code,
            404,
        )
        closure.assert_called_once()

    @patch(
        "public_portal.services.build_result_closure",
        return_value=SimpleNamespace(closeable=True),
    )
    def test_unlock_supersedes_active_release_in_same_transaction(self, closure):
        self.confirm_stage_result()

        from singer_contest.services import unlock_stage_result

        from .services import release_result_post

        release = release_result_post(
            self.post,
            self.stage_result,
            self.operator,
            note="首发",
        )
        unlocked = unlock_stage_result(
            self.stage_result,
            operator=self.operator,
            note="发现结果需要复核",
        )

        release.refresh_from_db()
        self.assertEqual(unlocked.status, StageResult.Status.READY_TO_CONFIRM)
        self.assertEqual(release.status, ResultRelease.Status.SUPERSEDED)
        self.assertEqual(release.transition_by_id, self.operator.pk)
        self.assertEqual(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.SUPERSEDE_RESULT_RELEASE,
                target=f"ResultRelease:{release.pk}",
            ).count(),
            1,
        )
        closure.assert_called_once()

    @patch(
        "public_portal.services.build_result_closure",
        return_value=SimpleNamespace(closeable=True),
    )
    def test_newer_persisted_result_supersedes_old_release(self, closure):
        self.confirm_stage_result()

        from ruleset.resolver import ResolveResult, ResolverState
        from singer_contest.services import persist_stage_result

        from .services import release_result_post

        release = release_result_post(
            self.post,
            self.stage_result,
            self.operator,
            note="首发",
        )
        newer = persist_stage_result(
            self.ruleset_version,
            self.activity,
            ResolveResult(
                status=ResolverState.READY,
                input_fingerprint="c" * 64,
                content_hash="d" * 64,
            ),
            stage_key=self.stage_result.stage_key,
            computed_by=self.operator,
        )

        release.refresh_from_db()
        self.assertEqual(newer.result_version, self.stage_result.result_version + 1)
        self.assertEqual(release.status, ResultRelease.Status.SUPERSEDED)
        self.assertEqual(release.transition_by_id, self.operator.pk)
        self.assertEqual(closure.call_count, 1)
