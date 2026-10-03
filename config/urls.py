from common.views import controlled_media
from django.conf import settings
from django.contrib import admin
from django.urls import include, path

from config.health import healthz, livez, readyz

handler403 = "config.error_views.permission_denied"
handler404 = "config.error_views.page_not_found"
handler500 = "config.error_views.server_error"

urlpatterns = [
    path("livez/", livez, name="livez"),
    path("readyz/", readyz, name="readyz"),
    path("healthz/", healthz, name="healthz"),
    path("", include("public_portal.urls")),
    path("", include("accounts.urls")),
    path("contest/", include("singer_contest.urls")),
    path("contest/register/", include("questionnaire.register_urls")),
    path("questionnaire/", include("questionnaire.urls")),
    path("judge/", include("singer_contest.judge_urls")),
    path("farewell/", include("farewell_show.urls")),
    path("staff/", include("staff_panel.urls")),
    path("staff/tickets/", include("tickets.staff_urls")),
    path("vote/", include("voting.urls")),
    path("entry-access/", include("entry_access.urls")),
    path("tickets/", include("tickets.urls")),
    path("media/<path:path>", controlled_media, name="controlled_media"),
]

if settings.APP_ENV != "production":
    urlpatterns.append(path("admin/", admin.site.urls))
