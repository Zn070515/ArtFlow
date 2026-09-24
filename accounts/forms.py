from config.runtime import is_placeholder_value
from django import forms
from django.conf import settings
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm
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


class FirstAdminSetupForm(forms.Form):
    username = forms.CharField(label="管理员用户名", max_length=150)
    password = forms.CharField(
        label="管理员密码",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}),
    )
    password_confirm = forms.CharField(
        label="确认管理员密码",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}),
    )
    setup_key = forms.CharField(
        label="初始化密钥",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "off"}),
    )

    def clean(self):
        cleaned_data = super().clean() or {}
        password = cleaned_data.get("password")
        password_confirm = cleaned_data.get("password_confirm")
        if password and password_confirm and password != password_confirm:
            self.add_error("password_confirm", "两次输入的密码不一致。")

        configured_key = settings.ADMIN_LOGIN_KEY
        submitted_key = cleaned_data.get("setup_key", "")
        if not configured_key or is_placeholder_value(configured_key):
            raise forms.ValidationError("管理员密钥尚未安全配置。")
        if not constant_time_compare(submitted_key, configured_key):
            raise forms.ValidationError("管理员密钥错误。")
        return cleaned_data
