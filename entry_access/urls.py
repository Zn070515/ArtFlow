from django.urls import path

from . import views

app_name = "entry_access"

urlpatterns = [
    path("grants/redeem/", views.redeem_grant, name="grant_redeem"),
]
