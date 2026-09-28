from types import SimpleNamespace

from accounts.models import User
from core.models import Activity
from django.test import TestCase

from common.authority import ACCOUNT_AUTHORITY, ACTIVITY_STATE, authority_write
from common.private_test_loader import PrivateTestLoadError, _activity_for_fixture


class PrivateTestLoaderBoundaryTests(TestCase):
    def setUp(self):
        with authority_write(ACCOUNT_AUTHORITY):
            self.operator = User.objects.create_user(
                username="private-loader-operator",
                password="test-password-123!",
                role=User.Role.ADMIN,
            )
        with authority_write(ACTIVITY_STATE):
            self.formal = Activity.objects.create(
                title="ArtFlow 私测｜Synthetic rehearsal",
                subtitle="formal-unrelated-activity",
                activity_type=Activity.Type.SINGER_CONTEST,
                is_test_mode=False,
            )
        self.fixture = SimpleNamespace(
            reference={
                "fixture_id": "synthetic-fixture",
                "event": {"title": "Synthetic rehearsal"},
            }
        )

    def test_formal_activity_with_fixture_title_is_rejected(self):
        with self.assertRaises(PrivateTestLoadError):
            _activity_for_fixture(self.fixture, "synthetic-fixture", self.operator)
