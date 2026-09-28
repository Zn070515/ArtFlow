from django.urls import path

from . import views

app_name = "questionnaire"

urlpatterns = [
    path("<int:activity_pk>/", views.form_view, name="form"),
    path("<int:activity_pk>/autosave/", views.autosave_view, name="autosave"),
    path("<int:activity_pk>/submit/", views.submit_view, name="submit"),
    path("<int:activity_pk>/file/<str:question_key>/", views.upload_view, name="upload"),
]
