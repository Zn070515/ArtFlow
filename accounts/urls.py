from django.urls import path

from . import views

app_name = "accounts"

urlpatterns = [
    path("login/", views.login_view, name="login"),
    path("login/participant/", views.participant_login_view, name="participant_login"),
    path("login/staff/", views.staff_login_view, name="staff_login"),
    path("login/admin/", views.admin_login_view, name="admin_login"),
    path("register/", views.participant_register_view, name="register"),
    path("register/staff/", views.staff_register_view, name="staff_register"),
    path("register/admin/", views.admin_register_view, name="admin_register"),
    path("logout/", views.logout_view, name="logout"),
    path("me/", views.profile_view, name="profile"),
    path("password-change/", views.password_change_view, name="password_change"),
    path(
        "admin/users/<int:user_id>/reset-password/",
        views.admin_password_reset_view,
        name="admin_password_reset",
    ),
]
