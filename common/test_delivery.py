"""The delivery backend only ever runs behind the authorization decision."""

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

from core.models import Activity
from django.core.exceptions import ImproperlyConfigured
from django.http import Http404, HttpResponse
from django.test import TestCase, override_settings
from django.urls import reverse
from exports.models import GeneratedDocument
from public_portal.models import PublicPost

from common import delivery
from common.delivery import get_delivery_backend


class _RecordingBackend:
    """A stand-in for a future object-storage backend that redirects to a URL."""

    name = "recording"

    def __init__(self, status: int = 302) -> None:
        self.status = status
        self.calls: list[tuple[str, str | None]] = []

    def deliver(self, relative_path: str, *, download_name: str | None = None) -> HttpResponse:
        self.calls.append((relative_path, download_name))
        return HttpResponse(status=self.status)


class DeliveryBackendTests(TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.media_root = Path(self._directory.name) / "media"
        self.media_root.mkdir()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()
        self.addCleanup(self.override.disable)

    def _write(self, relative_path: str) -> str:
        target = self.media_root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"media-bytes")
        return relative_path

    def test_local_backend_is_the_default(self) -> None:
        backend = get_delivery_backend()

        self.assertIsInstance(backend, delivery.LocalFilesystemDelivery)
        self.assertEqual(backend.name, "local")
        self.assertEqual(delivery.delivery_backend_names(), frozenset({"local"}))

    def test_an_unimplemented_backend_name_is_refused(self) -> None:
        # Settings already reject this at startup; the registry stays defensive
        # so a settings object assembled some other way cannot fall back silently.
        with override_settings(ARTFLOW_DELIVERY_BACKEND="oss"):
            with self.assertRaises(ImproperlyConfigured):
                get_delivery_backend()

    def test_authorized_media_is_handed_to_the_configured_backend(self) -> None:
        relative_path = self._write("public/covers/cover.jpg")
        PublicPost.objects.create(
            title="Cover post",
            cover_image=relative_path,
            status=PublicPost.Status.PUBLISHED,
        )
        backend = _RecordingBackend()

        with patch.dict(delivery._BACKENDS, {"local": backend}):
            response = self.client.get(reverse("controlled_media", kwargs={"path": relative_path}))

        self.assertEqual(response.status_code, 302)
        self.assertEqual(backend.calls, [(relative_path, None)])

    def test_staff_only_media_never_reaches_the_backend_without_authorization(self) -> None:
        relative_path = self._write("generated/report.docx")
        activity = Activity.objects.create(
            title="Delivery activity", activity_type=Activity.Type.GENERAL
        )
        GeneratedDocument.objects.create(activity=activity, file=relative_path)
        backend = _RecordingBackend()

        with patch.dict(delivery._BACKENDS, {"local": backend}):
            response = self.client.get(reverse("controlled_media", kwargs={"path": relative_path}))

        self.assertEqual(response.status_code, 403)
        self.assertEqual(backend.calls, [])

    def test_unregistered_media_never_reaches_the_backend(self) -> None:
        relative_path = self._write("orphan/unknown.bin")
        backend = _RecordingBackend()

        with patch.dict(delivery._BACKENDS, {"local": backend}):
            response = self.client.get(reverse("controlled_media", kwargs={"path": relative_path}))

        self.assertEqual(response.status_code, 404)
        self.assertEqual(backend.calls, [])

    def test_local_backend_still_refuses_a_path_outside_media_root(self) -> None:
        outside = Path(self._directory.name) / "private.txt"
        outside.write_text("private", encoding="utf-8")
        self.assertTrue(os.path.isfile(outside))

        with self.assertRaises(Http404):
            delivery._local_file_response("../private.txt")
