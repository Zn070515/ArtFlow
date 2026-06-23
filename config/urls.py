from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("public_portal.urls")),
    path("", include("accounts.urls")),
    path("contest/", include("singer_contest.urls")),
    path("farewell/", include("farewell_show.urls")),
    path("staff/", include("staff_panel.urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
