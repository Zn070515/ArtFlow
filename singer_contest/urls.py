from django.urls import path

from . import views

app_name = "singer_contest"

urlpatterns = [
    path("apply/", views.apply_view, name="apply"),
    path("my-submission/", views.my_submission_view, name="my_submission"),
]
