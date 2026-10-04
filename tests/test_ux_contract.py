import types

from django.contrib.auth.models import AnonymousUser
from django.contrib.messages import constants
from django.contrib.messages.storage.base import Message
from django.template.loader import render_to_string
from django.test import RequestFactory, SimpleTestCase
from django.urls import reverse


class GlobalUxContractTests(SimpleTestCase):
    def setUp(self):
        self.request = RequestFactory().get("/")
        self.request.user = AnonymousUser()

    def _render_base(self, messages=()):
        return render_to_string(
            "base.html",
            {
                "messages": list(messages),
                "artflow_organization_name": "",
                "artflow_icp_number": "",
                "artflow_icp_url": "",
            },
            request=self.request,
        )

    def test_message_severity_is_visible_and_announced(self):
        rendered = self._render_base(
            [
                Message(constants.SUCCESS, "保存成功"),
                Message(constants.WARNING, "请注意"),
                Message(constants.ERROR, "保存失败"),
                Message(constants.INFO, "提示信息"),
            ]
        )

        self.assertIn("bg-green-50", rendered)
        self.assertIn("bg-yellow-50", rendered)
        self.assertIn("bg-red-50", rendered)
        self.assertIn("bg-sky-50", rendered)
        self.assertEqual(rendered.count('role="alert"'), 4)
        self.assertIn('aria-hidden="true"', rendered)

    def test_base_template_has_a_no_script_mobile_navigation(self):
        rendered = self._render_base()

        self.assertIn("<details", rendered)
        self.assertIn("md:hidden", rendered)
        self.assertIn("菜单", rendered)
        self.assertIn(reverse("public_portal:result_list"), rendered)

    def test_custom_error_pages_are_generic_and_safe(self):
        from config.error_views import page_not_found, permission_denied, server_error

        cases = (
            (permission_denied(self.request, Exception("secret permission detail")), 403),
            (page_not_found(self.request, Exception("secret missing detail")), 404),
            (server_error(self.request), 500),
        )
        for response, status_code in cases:
            with self.subTest(status_code=status_code):
                body = response.content.decode()
                self.assertEqual(response.status_code, status_code)
                self.assertNotIn("secret", body)
                self.assertNotIn("Traceback", body)

        self.assertIn("不要重复提交敏感信息", cases[-1][0].content.decode())
        self.assertNotIn("请刷新", cases[-1][0].content.decode())


class GroupMaterialPresenceContractTests(SimpleTestCase):
    """The group material page must join the realtime room the backend already mounts.

    ``realtime`` publishes to ``/ws/group/<pk>/materials/`` and the consuming service
    exists, but a page nobody subscribes to is still a dead channel. This pins the
    browser-side glue only; presence stays advisory and never becomes an edit lock.
    """

    def setUp(self):
        self.request = RequestFactory().get("/")
        self.request.user = AnonymousUser()

    def _group(self):
        return types.SimpleNamespace(pk=3, name="第一组", stage=types.SimpleNamespace(name="合唱"))

    def _render(self, *, group):
        return render_to_string(
            "questionnaire/form.html",
            {
                "messages": [],
                "artflow_organization_name": "",
                "artflow_icp_number": "",
                "artflow_icp_url": "",
                "activity": types.SimpleNamespace(title="院十佳决赛"),
                "group": group,
                "current_members": [],
                "completion": {
                    "required": 0,
                    "required_answered": 0,
                    "answered": 0,
                    "upcoming": 0,
                },
                "pages": [],
                "editable": False,
                "preview": False,
                "submitted": False,
                "schema_hash": "test-schema-hash",
                "autosave_url": "/questionnaire/group/3/autosave/",
                "upload_url_template": "/questionnaire/group/3/file/__KEY__/",
                "submit_url": "/questionnaire/group/3/submit/",
            },
            request=self.request,
        )

    def test_group_page_joins_the_material_collaboration_room(self):
        rendered = self._render(group=self._group())

        self.assertIn("data-collab-presence", rendered)
        self.assertIn("/ws/group/3/materials/", rendered)
        self.assertIn("group:3:materials", rendered)
        self.assertIn("group.material_changed", rendered)
        self.assertIn("当前没有其他组员在线", rendered)
        # With DEBUG=False the manifest storage rewrites this to
        # dist/collab_presence.<hash>.js, so match the hash-optional form.
        self.assertRegex(rendered, r"dist/collab_presence(\.[0-9a-f]+)?\.js")

    def test_a_personal_form_does_not_join_a_group_room(self):
        rendered = self._render(group=None)

        self.assertNotIn("data-collab-presence", rendered)
        self.assertNotIn("collab_presence", rendered)
