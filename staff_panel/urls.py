from django.urls import path

from . import views

app_name = "staff"

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("posts/", views.post_list, name="post_list"),
    path("posts/new/", views.post_create, name="post_create"),
    path("posts/<int:pk>/edit/", views.post_edit, name="post_edit"),
]
