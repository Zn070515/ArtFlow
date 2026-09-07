from __future__ import annotations

from unittest import skipUnless

from django.conf import settings
from django.contrib.staticfiles.storage import staticfiles_storage
from django.test import TestCase


@skipUnless(not settings.DEBUG, "manifest smoke runs in the DEBUG=False CI profile")
class StaticManifestSmokeTests(TestCase):
    def test_debug_false_manifest_assets_render_and_serve(self):
        response = self.client.get("/")
        css_url = staticfiles_storage.url("css/app.css")
        js_url = staticfiles_storage.url("js/rapid_score.js")

        try:
            self.assertRegex(css_url, r"/static/css/app\.[0-9a-f]+\.css$")
            self.assertContains(response, f'href="{css_url}"')
            for url, expected_status in (
                (css_url, 200),
                (js_url, 200),
                ("/static/does-not-exist.js", 404),
            ):
                asset_response = self.client.get(url)
                try:
                    self.assertEqual(asset_response.status_code, expected_status)
                finally:
                    asset_response.close()
        finally:
            response.close()
