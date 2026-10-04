from django.urls import path

from . import views

app_name = "questionnaire"

urlpatterns = [
    path("<int:activity_pk>/", views.form_view, name="form"),
    path("<int:activity_pk>/autosave/", views.autosave_view, name="autosave"),
    path("<int:activity_pk>/submit/", views.submit_view, name="submit"),
    path("<int:activity_pk>/file/<str:question_key>/", views.upload_view, name="upload"),
    path("group/<int:group_pk>/", views.group_form_view, name="group_form"),
    path("group/<int:group_pk>/autosave/", views.group_autosave_view, name="group_autosave"),
    path("group/<int:group_pk>/submit/", views.group_submit_view, name="group_submit"),
    path(
        "group/<int:group_pk>/file/<str:question_key>/",
        views.group_upload_view,
        name="group_upload",
    ),
]
