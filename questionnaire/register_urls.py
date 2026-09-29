from django.urls import path

from . import views

app_name = "register"

urlpatterns = [
    path("", views.register_entry, name="choose"),
    path("<int:activity_pk>/", views.register_entry, name="activity"),
]
