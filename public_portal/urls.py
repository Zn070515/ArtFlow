from django.urls import path

from . import views

app_name = "public_portal"

urlpatterns = [
    path("", views.home, name="home"),
    path("post/<int:pk>/", views.post_detail, name="post_detail"),
    path("showcase/", views.showcase_list, name="showcase_list"),
    path("announcements/", views.announcement_list, name="announcement_list"),
    path("results/", views.result_list, name="result_list"),
]
