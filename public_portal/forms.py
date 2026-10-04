"""Admin ingestion forms for the public gallery.

GOAL §19.3: what reaches the public site is a metadata-free derivative, never the raw
upload. Unlike participant material there is no separate private original here — these
are staff-uploaded assets that exist only to be published — so the sanitized bytes are
stored in place of the upload.
"""

from __future__ import annotations

from django import forms
from django.core.files.uploadedfile import UploadedFile
from files.imaging import sanitize_upload

from .models import PublicMedia, PublicPost


class PublicMediaForm(forms.ModelForm):
    class Meta:
        model = PublicMedia
        fields = "__all__"

    def clean_image(self):
        # Only a genuinely new upload is re-encoded: an unchanged bound field hands back
        # the stored FieldFile, which must not be read here.
        image = self.cleaned_data.get("image")
        if not isinstance(image, UploadedFile):
            return image
        return sanitize_upload(image)


class PublicPostAdminForm(forms.ModelForm):
    class Meta:
        model = PublicPost
        fields = "__all__"

    def clean_cover_image(self):
        cover_image = self.cleaned_data.get("cover_image")
        if not isinstance(cover_image, UploadedFile):
            return cover_image
        return sanitize_upload(cover_image)
