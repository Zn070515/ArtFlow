from typing import cast

from config.runtime import is_placeholder_value
from django import forms
from django.conf import settings
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm
from django.contrib.auth.password_validation import validate_password
from django.utils.crypto import constant_time_compare

from .models import User


class AccountRegisterForm(UserCreationForm):
    class Meta(UserCreationForm.Meta):
        model = User
        fields = ("username", "password1", "password2")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        input_classes = (
            "w-full border border-gray-300 rounded px-3 py-2 text-sm "
            "focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand"
        )
        self.fields["username"].label = "用户名"
        self.fields["password1"].label = "密码"
        self.fields["password2"].label = "确认密码"
        for field in self.fields.values():
            field.widget.attrs["class"] = input_classes
        self.fields["username"].widget.attrs.update({"autocomplete": "username"})
        self.fields["password1"].widget.attrs.update({"autocomplete": "new-password"})
        self.fields["password2"].widget.attrs.update({"autocomplete": "new-password"})


class ParticipantRegisterForm(AccountRegisterForm):
    pass


class AccessKeyRegisterForm(AccountRegisterForm):
    access_key_setting = ""
    access_key_label = "访问密钥"
    access_key_error = "访问密钥错误。"

    access_key = forms.CharField(
        label="访问密钥",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "off"}),
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["access_key"].widget.attrs["class"] = (
            "w-full border border-gray-300 rounded px-3 py-2 text-sm "
            "focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand"
        )
        self.fields["access_key"].label = self.access_key_label

    def clean_access_key(self):
        submitted_key = self.cleaned_data["access_key"]
        configured_key = getattr(settings, self.access_key_setting, "")
        if not configured_key or is_placeholder_value(configured_key):
            raise forms.ValidationError(f"{self.access_key_label}尚未安全配置。")
        if not constant_time_compare(submitted_key, configured_key):
            raise forms.ValidationError(self.access_key_error)
        return submitted_key


class StaffRegisterForm(AccessKeyRegisterForm):
    access_key_setting = "STAFF_ACCESS_KEY"
    access_key_label = "工作人员密钥"
    access_key_error = "工作人员密钥错误。"


class AdminRegisterForm(AccessKeyRegisterForm):
    access_key_setting = "ADMIN_ACCESS_KEY"
    access_key_label = "管理员密钥"
    access_key_error = "管理员密钥错误。"


class RoleLoginForm(AuthenticationForm):
    expected_role = ""
    role_mismatch_message = "该账号不属于此登录入口。"

    error_messages = {
        **AuthenticationForm.error_messages,
        "role_mismatch": "该账号不属于此登录入口。",
    }

    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)
        current_user = cast(User, user)
        if current_user.role != self.expected_role or (
            self.expected_role == User.Role.PARTICIPANT and current_user.is_admin
        ):
            raise forms.ValidationError(
                self.role_mismatch_message,
                code="role_mismatch",
            )


class ParticipantLoginForm(RoleLoginForm):
    expected_role = User.Role.PARTICIPANT
    role_mismatch_message = "该账号不属于选手登录入口。"


class StaffLoginForm(RoleLoginForm):
    expected_role = User.Role.STAFF
    role_mismatch_message = "该账号不属于工作人员登录入口。"
    access_key_setting = "STAFF_ACCESS_KEY"
    access_key_label = "工作人员密钥"
    access_key_error = "工作人员密钥错误。"

    access_key = forms.CharField(
        label="工作人员密钥",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "off"}),
    )

    def clean(self):
        cleaned_data = super().clean()
        _validate_access_key(
            cleaned_data.get("access_key", ""),
            setting_name=self.access_key_setting,
            missing_message="工作人员密钥尚未安全配置。",
            invalid_message=self.access_key_error,
        )
        return cleaned_data


class AdminLoginForm(AuthenticationForm):
    access_key = forms.CharField(
        label="管理员密钥",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "off"}),
    )
    error_messages = {
        **AuthenticationForm.error_messages,
        "not_admin": "该账号不是管理员账号。",
        "missing_key": "系统尚未配置管理员登录密钥。",
        "invalid_key": "管理员密钥错误。",
    }

    def confirm_login_allowed(self, user):
        super().confirm_login_allowed(user)
        if not cast(User, user).is_admin:
            raise forms.ValidationError(self.error_messages["not_admin"], code="not_admin")

    def clean(self):
        cleaned_data = super().clean()
        _validate_access_key(
            cleaned_data.get("access_key", ""),
            setting_name="ADMIN_ACCESS_KEY",
            missing_message=str(self.error_messages["missing_key"]),
            invalid_message=str(self.error_messages["invalid_key"]),
        )
        return cleaned_data


def _validate_access_key(
    submitted_key: str,
    *,
    setting_name: str,
    missing_message: str,
    invalid_message: str,
) -> None:
    configured_key = getattr(settings, setting_name, "")
    if not configured_key or is_placeholder_value(configured_key):
        raise forms.ValidationError(missing_message, code="missing_key")
    if not constant_time_compare(submitted_key, configured_key):
        raise forms.ValidationError(invalid_message, code="invalid_key")


class AdminPasswordResetForm(forms.Form):
    new_password1 = forms.CharField(
        label="新密码",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}),
    )
    new_password2 = forms.CharField(
        label="确认新密码",
        strip=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}),
    )

    def __init__(self, *args, user=None, **kwargs):
        self.user = user
        super().__init__(*args, **kwargs)

    def clean(self):
        cleaned_data = super().clean() or {}
        password = cleaned_data.get("new_password1")
        confirmation = cleaned_data.get("new_password2")
        if password and confirmation and password != confirmation:
            self.add_error("new_password2", "两次输入的密码不一致。")
        if password:
            validate_password(password, user=self.user)
        return cleaned_data
