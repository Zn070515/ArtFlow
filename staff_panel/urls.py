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
    path("rounds/", views.round_list, name="round_list"),
    path("rounds/new/", views.round_create, name="round_create"),
    path("rounds/<int:pk>/scores/", views.round_score_entry, name="round_score_entry"),
    path("rounds/<int:pk>/ranking/", views.round_ranking, name="round_ranking"),
    path("rounds/<int:pk>/lock/", views.round_lock, name="round_lock"),
    path("rounds/<int:pk>/unlock/", views.round_unlock, name="round_unlock"),
    path("judges/", views.judge_list, name="judge_list"),
    path("judges/new/", views.judge_create, name="judge_create"),
    path("awards/", views.award_list, name="award_list"),
    path("awards/new/", views.award_create, name="award_create"),
]
