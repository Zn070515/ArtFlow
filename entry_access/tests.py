from django.apps import apps
from django.test import SimpleTestCase
from django.urls import get_resolver


class EntryAccessScaffoldTests(SimpleTestCase):
    def test_entry_access_app_is_registered(self):
        config = apps.get_app_config("entry_access")

        self.assertEqual(config.name, "entry_access")

    def test_entry_access_url_namespace_is_mounted(self):
        resolver = get_resolver()

        self.assertIn("entry_access", resolver.namespace_dict)
