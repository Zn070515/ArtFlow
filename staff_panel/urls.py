from django.urls import path

from . import views

app_name = "staff"

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("posts/", views.post_list, name="post_list"),
    path("posts/new/", views.post_create, name="post_create"),
    path("posts/<int:pk>/edit/", views.post_edit, name="post_edit"),
    path("registrations/", views.singer_registration_list, name="singer_registration_list"),
    path("registrations/<int:pk>/", views.singer_registration_detail, name="singer_registration_detail"),
    path("programs/", views.program_list, name="program_list"),
    path("programs/<int:pk>/", views.program_detail, name="program_detail"),
    path("export/registrations/", views.export_registrations, name="export_registrations"),
    path("export/programs/", views.export_programs, name="export_programs"),
]
