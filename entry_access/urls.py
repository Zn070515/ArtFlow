from django.urls import path

from . import views

app_name = "entry_access"

urlpatterns = [
    path("grants/issue/", views.issue_grant, name="grant_issue"),
    path("grants/redeem/", views.redeem_grant, name="grant_redeem"),
    path("grants/<int:grant_id>/revoke/", views.revoke_grant, name="grant_revoke"),
    path("sessions/<int:session_id>/revoke/", views.revoke_session, name="session_revoke"),
]
