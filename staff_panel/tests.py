import shutil
import tempfile
from datetime import timedelta

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from accounts.models import User
from core.models import Activity
from farewell_show.models import Program
from files.models import MaterialCheck, SubmissionFile
from public_portal.models import PublicPost
from singer_contest.models import ContestRound, Judge, ScoreSummary, SingerRegistration
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
