from common.views import controlled_media
from django.conf import settings
from django.contrib import admin
from django.urls import include, path

from config.health import healthz

urlpatterns = [
    path("healthz/", healthz, name="healthz"),
    path("", include("public_portal.urls")),
    path("", include("accounts.urls")),
    path("contest/", include("singer_contest.urls")),
    path("farewell/", include("farewell_show.urls")),
    path("staff/", include("staff_panel.urls")),
    path("vote/", include("voting.urls")),
    path("entry-access/", include("entry_access.urls")),
    path("media/<path:path>", controlled_media, name="controlled_media"),
]

if settings.APP_ENV != "production":
    urlpatterns.append(path("admin/", admin.site.urls))
