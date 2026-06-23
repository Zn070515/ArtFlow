from django.urls import path

from . import views

app_name = "voting"

urlpatterns = [
    path("<int:pk>/", views.vote_entry, name="vote_entry"),
    path("<int:pk>/cast/", views.vote_cast, name="vote_cast"),
    path("<int:pk>/done/", views.vote_done, name="vote_done"),
]
