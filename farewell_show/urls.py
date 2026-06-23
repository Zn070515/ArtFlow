from django.urls import path

from . import views

app_name = "farewell_show"

urlpatterns = [
    path("apply/", views.apply_view, name="apply"),
    path("my-program/", views.my_program_view, name="my_program"),
]
