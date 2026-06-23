from django import forms
from django.conf import settings
from django.contrib.auth.forms import AuthenticationForm
from django.contrib.auth.forms import UserCreationForm
from django.utils.crypto import constant_time_compare

from .models import User


class RegisterForm(UserCreationForm):
    class Meta:
        model = User
        fields = ["username", "password1", "password2"]


class ParticipantLoginForm(AuthenticationForm):
    error_messages = {
        **AuthenticationForm.error_messages,
        "admin_requires_key": "管理员账号请使用管理员登录入口。",
    }

    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)
        if user.is_admin:
            raise forms.ValidationError(
                self.error_messages["admin_requires_key"],
                code="admin_requires_key",
            )


class AdminLoginForm(AuthenticationForm):
    admin_key = forms.CharField(
        label="管理员密钥",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "current-password"}),
    )
    error_messages = {
        **AuthenticationForm.error_messages,
        "not_admin": "该账号不是管理员账号。",
        "missing_key": "系统尚未配置管理员登录密钥。",
        "invalid_key": "管理员密钥错误。",
    }

    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)
        if not user.is_admin:
            raise forms.ValidationError(self.error_messages["not_admin"], code="not_admin")

    def clean(self):
        cleaned_data = super().clean()
        configured_key = settings.ADMIN_LOGIN_KEY
        submitted_key = self.cleaned_data.get("admin_key", "")
        if not configured_key:
            raise forms.ValidationError(self.error_messages["missing_key"], code="missing_key")
        if not constant_time_compare(submitted_key, configured_key):
            raise forms.ValidationError(self.error_messages["invalid_key"], code="invalid_key")
        return cleaned_data
