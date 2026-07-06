import shutil
import tempfile
import zipfile
from datetime import timedelta
from io import BytesIO

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from accounts.models import User
from core.models import Activity
from farewell_show.models import Program
from files.models import MaterialCheck, SubmissionFile
from files.models import MaterialRequirement
from public_portal.models import PublicPost
from common.models import AuditLog
from singer_contest.models import Award, ContestRound, Judge, ScoreRecord, ScoreSummary, SingerRegistration
from voting.models import VoteOption, VoteRecord, VoteSession


class StaffPanelSmokeTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.admin = User.objects.create_user(
            username="admin_user",
            password="pass",
            role=User.Role.ADMIN,
        )
        self.staff = User.objects.create_user(
            username="staff_user",
            password="pass",
            role=User.Role.STAFF,
        )
        self.participant = User.objects.create_user(
            username="participant",
            password="pass",
            role=User.Role.PARTICIPANT,
        )
        self.singer_activity = Activity.objects.create(
            title="Singer Contest",
            activity_type=Activity.Type.SINGER_CONTEST,
            phase=Activity.Phase.REGISTRATION_OPEN,
        )
        self.farewell_activity = Activity.objects.create(
            title="Farewell Show",
            activity_type=Activity.Type.FAREWELL_SHOW,
            phase=Activity.Phase.REGISTRATION_OPEN,
        )

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media_root, ignore_errors=True)

    def test_staff_form_pages_render(self):
        registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Li Hua",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        program = Program.objects.create(
            activity=self.farewell_activity,
            user=self.participant,
            name="Dance",
            program_type=Program.ProgramType.DANCE,
            contact_name="Li Hua",
            contact_phone="13800000000",
            class_name="CS1",
        )
        self.client.force_login(self.staff)
        paths = [
            reverse("staff:post_create"),
            reverse("staff:singer_registration_detail", args=[registration.pk]),
            reverse("staff:program_detail", args=[program.pk]),
            reverse("staff:round_create"),
            reverse("staff:vote_session_create"),
            reverse("staff:incident_create"),
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_admin_can_create_activity_from_staff_panel(self):
        self.client.force_login(self.admin)
        response = self.client.post(reverse("staff:activity_create"), {
            "title": "New Contest",
            "activity_type": Activity.Type.SINGER_CONTEST,
            "phase": Activity.Phase.REGISTRATION_OPEN,
            "is_test_mode": "on",
        })
        self.assertEqual(response.status_code, 302)
        self.assertTrue(Activity.objects.filter(title="New Contest").exists())

    def test_staff_cannot_create_activity(self):
        self.client.force_login(self.staff)
        response = self.client.get(reverse("staff:activity_create"))
        self.assertEqual(response.status_code, 403)

    def test_public_homepage_uses_published_posts(self):
        PublicPost.objects.create(
            title="Registration Open",
            post_type=PublicPost.PostType.ANNOUNCEMENT,
            status=PublicPost.Status.PUBLISHED,
            published_at=timezone.now(),
        )
        response = self.client.get(reverse("public_portal:home"))
        self.assertContains(response, "Registration Open")

    def test_singer_registration_uploads_material_and_checks_completeness(self):
        self.client.force_login(self.participant)
        response = self.client.post(reverse("singer_contest:apply"), {
            "activity_id": self.singer_activity.pk,
            "name": "Li Hua",
            "student_id": "20260001",
            "college": "Info",
            "class_name": "CS1",
            "phone": "13800000000",
            "song_name": "Song",
            "accompaniment": SimpleUploadedFile("song.mp3", b"audio"),
        })
        self.assertEqual(response.status_code, 302)
        registration = SingerRegistration.objects.get(user=self.participant)
        self.assertTrue(registration.files.filter(file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT).exists())
        self.assertTrue(
            MaterialCheck.objects.filter(
                singer_registration=registration,
                item_name="伴奏文件",
                status=MaterialCheck.Status.UPLOADED,
            ).exists()
        )

    def test_farewell_program_uploads_material_and_checks_completeness(self):
        self.client.force_login(self.participant)
        response = self.client.post(reverse("farewell_show:apply"), {
            "activity_id": self.farewell_activity.pk,
            "name": "Dance",
            "program_type": Program.ProgramType.DANCE,
            "contact_name": "Li Hua",
            "contact_phone": "13800000000",
            "class_name": "CS1",
            "accompaniment": SimpleUploadedFile("dance.mp3", b"audio"),
        })
        self.assertEqual(response.status_code, 302)
        program = Program.objects.get(user=self.participant)
        self.assertTrue(program.files.filter(file_purpose=SubmissionFile.Purpose.ACCOMPANIMENT).exists())
        self.assertTrue(
            MaterialCheck.objects.filter(
                program=program,
                item_name="伴奏文件",
                status=MaterialCheck.Status.UPLOADED,
            ).exists()
        )

    def test_scoring_and_voting_basic_flow(self):
        registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Li Hua",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        judge = Judge.objects.create(activity=self.singer_activity, name="Judge A")
        round_ = ContestRound.objects.create(
            activity=self.singer_activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            scoring_mode=ContestRound.ScoringMode.AVERAGE,
            advance_count=1,
        )
        self.client.force_login(self.staff)
        response = self.client.post(reverse("staff:round_score_entry", args=[round_.pk]), {
            f"score_{registration.pk}_{judge.pk}": "91",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(ScoreSummary.objects.get(round=round_, singer=registration).rank, 1)

        vote_session = VoteSession.objects.create(
            activity=self.singer_activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        option = VoteOption.objects.create(vote_session=vote_session, singer=registration)
        visitor = self.client_class()
        self.assertEqual(visitor.post(reverse("voting:vote_entry", args=[vote_session.pk]), {"passcode": "1234"}).status_code, 302)
        self.assertEqual(visitor.post(reverse("voting:vote_cast", args=[vote_session.pk]), {"selected_option": [str(option.pk)]}).status_code, 302)
        self.assertEqual(VoteRecord.objects.filter(vote_session=vote_session).count(), 1)

        qr_page = self.client.get(reverse("staff:qr_generate", args=[self.singer_activity.pk]))
        self.assertEqual(qr_page.status_code, 200)
        qr_image = self.client.get(reverse("staff:qr_image", args=[self.singer_activity.pk, "registration"]))
        self.assertEqual(qr_image.status_code, 200)
        self.assertEqual(qr_image["Content-Type"], "image/png")

    def test_locked_activity_blocks_staff_score_entry(self):
        self.singer_activity.is_locked = True
        self.singer_activity.save()
        registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Li Hua",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        judge = Judge.objects.create(activity=self.singer_activity, name="Judge A")
        round_ = ContestRound.objects.create(
            activity=self.singer_activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
        )
        self.client.force_login(self.staff)
        response = self.client.post(reverse("staff:round_score_entry", args=[round_.pk]), {
            f"score_{registration.pk}_{judge.pk}": "91",
        })
        self.assertEqual(response.status_code, 403)
        self.assertFalse(ScoreRecord.objects.exists())

    def test_locked_activity_blocks_award_creation(self):
        self.singer_activity.is_locked = True
        self.singer_activity.save()
        registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Li Hua",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        self.client.force_login(self.staff)
        response = self.client.post(reverse("staff:award_create"), {
            "activity_id": self.singer_activity.pk,
            "singer_id": registration.pk,
            "name": "Top Singer",
        })
        self.assertEqual(response.status_code, 403)
        self.assertFalse(Award.objects.exists())

    def test_admin_can_unlock_vote_session_and_audit_is_recorded(self):
        vote_session = VoteSession.objects.create(
            activity=self.singer_activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_locked=True,
        )
        self.client.force_login(self.staff)
        self.assertEqual(self.client.post(reverse("staff:vote_session_unlock", args=[vote_session.pk])).status_code, 403)

        self.client.force_login(self.admin)
        response = self.client.post(reverse("staff:vote_session_unlock", args=[vote_session.pk]), {"note": "fix typo"})
        self.assertEqual(response.status_code, 302)
        vote_session.refresh_from_db()
        self.assertFalse(vote_session.is_locked)
        self.assertTrue(
            AuditLog.objects.filter(
                action_type=AuditLog.ActionType.UNLOCK_RESULT,
                target__contains="VoteSession",
                note="fix typo",
            ).exists()
        )

    def test_clear_test_data_preserves_formal_records(self):
        formal_registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Formal",
            student_id="20260002",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Formal Song",
            is_test_data=False,
        )
        test_registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Test",
            student_id="20260003",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Test Song",
            is_test_data=True,
        )
        VoteSession.objects.create(
            activity=self.singer_activity,
            name="Formal Vote",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_test_data=False,
        )
        VoteSession.objects.create(
            activity=self.singer_activity,
            name="Test Vote",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_test_data=True,
        )
        self.client.force_login(self.admin)
        response = self.client.post(reverse("staff:activity_clear_test_data", args=[self.singer_activity.pk]))
        self.assertEqual(response.status_code, 302)
        self.assertTrue(SingerRegistration.objects.filter(pk=formal_registration.pk).exists())
        self.assertFalse(SingerRegistration.objects.filter(pk=test_registration.pk).exists())
        self.assertTrue(VoteSession.objects.filter(name="Formal Vote").exists())
        self.assertFalse(VoteSession.objects.filter(name="Test Vote").exists())

    def test_submission_file_media_url_is_owner_or_staff_only(self):
        other_participant = User.objects.create_user(
            username="other",
            password="pass",
            role=User.Role.PARTICIPANT,
        )
        registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Li Hua",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
        )
        uploaded = SubmissionFile.objects.create(
            singer_registration=registration,
            file=SimpleUploadedFile("song.mp3", b"audio"),
            original_name="song.mp3",
            file_size=5,
            uploaded_by=self.participant,
        )
        self.client.force_login(other_participant)
        self.assertEqual(self.client.get(uploaded.file.url).status_code, 403)

        self.client.force_login(self.participant)
        owner_response = self.client.get(uploaded.file.url)
        self.assertEqual(owner_response.status_code, 200)

        self.client.force_login(self.staff)
        staff_response = self.client.get(uploaded.file.url)
        self.assertEqual(staff_response.status_code, 200)

    def test_packages_include_contest_and_farewell_operational_indexes(self):
        registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Li Hua",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        judge = Judge.objects.create(activity=self.singer_activity, name="Judge A")
        round_ = ContestRound.objects.create(
            activity=self.singer_activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            advance_count=1,
        )
        ScoreRecord.objects.create(round=round_, singer=registration, judge=judge, score=91)
        ScoreSummary.objects.create(round=round_, singer=registration, average_score=91, rank=1, is_advanced=True)
        Award.objects.create(activity=self.singer_activity, singer=registration, name="Top Singer")
        vote_session = VoteSession.objects.create(
            activity=self.singer_activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
        )
        VoteOption.objects.create(vote_session=vote_session, singer=registration)
        SubmissionFile.objects.create(
            singer_registration=registration,
            file=SimpleUploadedFile("song.mp3", b"audio"),
            original_name="song.mp3",
            file_size=5,
            uploaded_by=self.participant,
        )
        PublicPost.objects.create(
            title="Result",
            post_type=PublicPost.PostType.RESULT_PUBLICATION,
            status=PublicPost.Status.PUBLISHED,
            related_activity=self.singer_activity,
            published_at=timezone.now(),
        )
        self.client.force_login(self.staff)
        response = self.client.get(reverse("staff:archive_package_create", args=[self.singer_activity.pk]))
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(BytesIO(response.content)) as zf:
            names = set(zf.namelist())
        self.assertIn("score_results.xlsx", names)
        self.assertIn("vote_results.xlsx", names)
        self.assertIn("award_list.xlsx", names)
        self.assertIn("attachment_index.xlsx", names)
        self.assertIn("public_content_index.xlsx", names)

        Program.objects.create(
            activity=self.farewell_activity,
            user=self.participant,
            name="Dance",
            program_type=Program.ProgramType.DANCE,
            contact_name="Li Hua",
            contact_phone="13800000000",
            class_name="CS1",
            sort_order=1,
        )
        response = self.client.get(reverse("staff:execution_package", args=[self.farewell_activity.pk]))
        self.assertEqual(response.status_code, 200)
        with zipfile.ZipFile(BytesIO(response.content)) as zf:
            names = set(zf.namelist())
        self.assertIn("program_list.xlsx", names)
        self.assertIn("contact_list.xlsx", names)
        self.assertIn("material_checklist.xlsx", names)

    def test_locking_vote_session_generates_popularity_award(self):
        registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Li Hua",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        vote_session = VoteSession.objects.create(
            activity=self.singer_activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        option = VoteOption.objects.create(vote_session=vote_session, singer=registration)
        VoteRecord.objects.create(
            vote_session=vote_session,
            vote_option=option,
            browser_session_key="visitor-1",
            ip_address="127.0.0.1",
        )
        self.client.force_login(self.staff)
        response = self.client.post(reverse("staff:vote_session_lock", args=[vote_session.pk]))
        self.assertEqual(response.status_code, 302)
        self.assertTrue(Award.objects.filter(activity=self.singer_activity, singer=registration, name="最佳人气奖").exists())

    def test_vote_cast_rate_limits_same_ip_briefly(self):
        registration = SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Li Hua",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
            pre_status=SingerRegistration.PreStatus.APPROVED,
        )
        vote_session = VoteSession.objects.create(
            activity=self.singer_activity,
            name="Popularity",
            passcode="1234",
            start_time=timezone.now() - timedelta(minutes=1),
            end_time=timezone.now() + timedelta(minutes=10),
            is_open=True,
        )
        option = VoteOption.objects.create(vote_session=vote_session, singer=registration)
        first = self.client_class()
        second = self.client_class()
        first.post(reverse("voting:vote_entry", args=[vote_session.pk]), {"passcode": "1234"}, REMOTE_ADDR="127.0.0.1")
        self.assertEqual(
            first.post(reverse("voting:vote_cast", args=[vote_session.pk]), {"selected_option": [str(option.pk)]}, REMOTE_ADDR="127.0.0.1").status_code,
            302,
        )
        second.post(reverse("voting:vote_entry", args=[vote_session.pk]), {"passcode": "1234"}, REMOTE_ADDR="127.0.0.1")
        response = second.post(reverse("voting:vote_cast", args=[vote_session.pk]), {"selected_option": [str(option.pk)]}, REMOTE_ADDR="127.0.0.1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(VoteRecord.objects.filter(vote_session=vote_session).count(), 1)

    def test_activity_clone_preserves_configuration_not_runtime_data(self):
        MaterialRequirement.objects.create(
            activity=self.singer_activity,
            applies_to=MaterialRequirement.AppliesTo.SINGER,
            item_name="Lyrics",
            file_purpose=SubmissionFile.Purpose.LYRICS_SCRIPT,
        )
        Judge.objects.create(activity=self.singer_activity, name="Judge A")
        ContestRound.objects.create(
            activity=self.singer_activity,
            round_type=ContestRound.RoundType.PRELIMINARY,
            scoring_mode=ContestRound.ScoringMode.DROP_HIGH_LOW,
            advance_count=2,
            name="Preliminary",
        )
        SingerRegistration.objects.create(
            activity=self.singer_activity,
            user=self.participant,
            name="Runtime Data",
            student_id="20260001",
            college="Info",
            class_name="CS1",
            phone="13800000000",
            song_name="Song",
        )
        self.client.force_login(self.admin)
        response = self.client.post(reverse("staff:activity_clone", args=[self.singer_activity.pk]))
        self.assertEqual(response.status_code, 302)
        clone = Activity.objects.exclude(pk=self.singer_activity.pk).get(activity_type=Activity.Type.SINGER_CONTEST)
        self.assertTrue(MaterialRequirement.objects.filter(activity=clone, item_name="Lyrics").exists())
        self.assertTrue(Judge.objects.filter(activity=clone, name="Judge A").exists())
        self.assertTrue(ContestRound.objects.filter(activity=clone, round_type=ContestRound.RoundType.PRELIMINARY).exists())
        self.assertFalse(SingerRegistration.objects.filter(activity=clone).exists())
