from django.urls import path

from . import views

app_name = "public_portal"

urlpatterns = [
    path("e/<str:public_code>/", views.activity_entry, name="activity_entry"),
    path("e/<str:public_code>/apply/", views.activity_apply, name="activity_apply"),
    path("e/<str:public_code>/live/", views.activity_live, name="activity_live"),
    path("e/<str:public_code>/judge/", views.activity_judge, name="activity_judge"),
    path("", views.home, name="home"),
    path("post/<int:pk>/", views.post_detail, name="post_detail"),
    path("showcase/", views.showcase_list, name="showcase_list"),
    path("announcements/", views.announcement_list, name="announcement_list"),
    path("results/", views.result_list, name="result_list"),
    path("privacy/", views.privacy, name="privacy"),
]
