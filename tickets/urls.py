from typing import Any

from django.urls import path

from . import views

app_name = "tickets"

urlpatterns: list[Any] = [
    path("scan/", views.scan, name="scan"),
    path("redeem/", views.redeem, name="redeem"),
]
