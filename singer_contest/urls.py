from django.urls import path

from . import views

app_name = "singer_contest"

urlpatterns = [
    path("apply/", views.apply_view, name="apply"),
    path("my-registrations/", views.my_registrations_view, name="my_registrations"),
    path("my-submission/", views.my_submission_view, name="my_submission"),
    path(
        "registrations/<int:pk>/",
        views.my_registration_detail,
        name="my_registration_detail",
    ),
]
