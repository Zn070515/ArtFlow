import os
from pathlib import Path

from archive.models import ArchivePackage
from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404
from exports.models import ExportTask, GeneratedDocument
from files.models import SubmissionFile
from public_portal.models import PublicMedia, PublicPost


def _media_file_response(relative_path, download_name=None):
    media_root = os.path.realpath(settings.MEDIA_ROOT)
    full_path = os.path.realpath(os.path.join(media_root, relative_path))
    if not full_path.startswith(f"{media_root}{os.sep}"):
        raise Http404("Invalid media path.")
    if not os.path.isfile(full_path):
        raise Http404("Media file not found.")
    return FileResponse(open(full_path, "rb"), as_attachment=False, filename=download_name)


def _can_access_submission_file(user, submission_file):
    if submission_file.is_public:
        return True
    if not user.is_authenticated:
        return False
    if user.is_staff_or_admin:
        return True
    if submission_file.singer_registration_id:
        return submission_file.singer_registration.user_id == user.pk
    if submission_file.program_id:
        return submission_file.program.user_id == user.pk
    return submission_file.uploaded_by_id == user.pk


def controlled_media(request, path):
    relative_path = Path(path).as_posix()

    submission_file = (
        SubmissionFile.objects.select_related("singer_registration", "program", "uploaded_by")
        .filter(file=relative_path)
        .first()
    )
    if submission_file:
        if not _can_access_submission_file(request.user, submission_file):
            raise PermissionDenied("You do not have access to this file.")
        return _media_file_response(relative_path, submission_file.original_name)

    if PublicPost.objects.filter(
        cover_image=relative_path, status=PublicPost.Status.PUBLISHED
    ).exists():
        return _media_file_response(relative_path)

    if PublicMedia.objects.filter(
        image=relative_path,
        is_published=True,
        post__status=PublicPost.Status.PUBLISHED,
    ).exists():
        return _media_file_response(relative_path)

    if GeneratedDocument.objects.filter(file=relative_path).exists():
        if not request.user.is_authenticated or not request.user.is_staff_or_admin:
            raise PermissionDenied("Generated documents are staff-only.")
        document = get_object_or_404(GeneratedDocument, file=relative_path)
        return _media_file_response(relative_path, Path(document.file.name or relative_path).name)

    if (
        ExportTask.objects.filter(file=relative_path).exists()
        or ArchivePackage.objects.filter(file=relative_path).exists()
    ):
        if not request.user.is_authenticated or not request.user.is_staff_or_admin:
            raise PermissionDenied("Export files are staff-only.")
        return _media_file_response(relative_path)

    raise Http404("Media file not registered.")
