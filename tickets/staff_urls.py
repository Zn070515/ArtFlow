from django.urls import path

from . import views

app_name = "ticket_staff"

urlpatterns = [
    path("", views.ticket_list, name="list"),
    path("issue/", views.issue, name="issue"),
    path("check-in/", views.check_in, name="check_in"),
    path("<int:ticket_id>/void/", views.void, name="void"),
    path("<int:ticket_id>/revoke/", views.revoke, name="revoke"),
]
