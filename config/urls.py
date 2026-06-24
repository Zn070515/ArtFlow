from django.contrib import admin
from django.urls import include, path

from common.views import controlled_media

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("public_portal.urls")),
    path("", include("accounts.urls")),
    path("contest/", include("singer_contest.urls")),
    path("farewell/", include("farewell_show.urls")),
    path("staff/", include("staff_panel.urls")),
    path("vote/", include("voting.urls")),
    path("media/<path:path>", controlled_media, name="controlled_media"),
]
