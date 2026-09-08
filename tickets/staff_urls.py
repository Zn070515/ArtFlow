from django.urls import path

from . import views

app_name = "ticket_staff"

urlpatterns = [
    path("", views.ticket_list, name="list"),
    path("manage/", views.ticket_list_page, name="list_page"),
    path("issue/", views.issue, name="issue"),
    path("issue-page/", views.issue_page, name="issue_page"),
    path("check-in/", views.check_in, name="check_in"),
    path("check-in-page/", views.check_in_page, name="check_in_page"),
    path("<int:ticket_id>/detail/", views.detail_page, name="detail"),
    path("<int:ticket_id>/action/", views.action_page, name="action"),
    path("<int:ticket_id>/void/", views.void, name="void"),
    path("<int:ticket_id>/revoke/", views.revoke, name="revoke"),
]
