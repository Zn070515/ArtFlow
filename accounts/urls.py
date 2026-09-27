from django.urls import path

from . import views

app_name = "accounts"

urlpatterns = [
    path("setup/", views.first_admin_setup_view, name="first_admin_setup"),
    path("login/", views.login_view, name="login"),
    path("admin-login/", views.admin_login_view, name="admin_login"),
    path("register/", views.register_view, name="register"),
    path("logout/", views.logout_view, name="logout"),
    path("me/", views.profile_view, name="profile"),
    path("password-change/", views.password_change_view, name="password_change"),
    path(
        "admin/users/<int:user_id>/reset-password/",
        views.admin_password_reset_view,
        name="admin_password_reset",
    ),
]
