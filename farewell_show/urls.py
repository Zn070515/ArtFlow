from django.urls import path

from . import views

app_name = "farewell_show"

urlpatterns = [
    path("apply/", views.apply_view, name="apply"),
    path("my-programs/", views.my_programs_view, name="my_programs"),
    path("my-program/", views.my_program_view, name="my_program"),
    path("programs/<int:pk>/", views.my_program_detail, name="my_program_detail"),
]
