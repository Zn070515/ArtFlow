from pathlib import Path

from archive.models import ArchivePackage
from django.core.exceptions import PermissionDenied
from django.http import Http404
from django.shortcuts import get_object_or_404
from exports.models import ExportTask, GeneratedDocument
from files.models import SubmissionFile
from public_portal.models import PublicMedia, PublicPost

from .delivery import get_delivery_backend


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
    """Authorize a media path, then hand delivery to the configured backend.

    Authorization stays here and always runs before any byte is produced: the
    delivery backend is only ever reached for a path this function has already
    approved for this caller.
    """
    relative_path = Path(path).as_posix()
    backend = get_delivery_backend()
    public_posts = PublicPost.published_public()

    submission_file = (
        SubmissionFile.objects.select_related("singer_registration", "program", "uploaded_by")
        .filter(file=relative_path)
        .first()
    )
    if submission_file:
        if not _can_access_submission_file(request.user, submission_file):
            raise PermissionDenied("You do not have access to this file.")
        return backend.deliver(relative_path, download_name=submission_file.original_name)

    if public_posts.filter(cover_image=relative_path).exists():
        return backend.deliver(relative_path)

    if PublicMedia.objects.filter(
        image=relative_path,
        is_published=True,
        post__in=public_posts,
    ).exists():
        return backend.deliver(relative_path)

    if GeneratedDocument.objects.filter(file=relative_path).exists():
        if not request.user.is_authenticated or not request.user.is_staff_or_admin:
            raise PermissionDenied("Generated documents are staff-only.")
        document = get_object_or_404(GeneratedDocument, file=relative_path)
        return backend.deliver(
            relative_path, download_name=Path(document.file.name or relative_path).name
        )

    if (
        ExportTask.objects.filter(file=relative_path).exists()
        or ArchivePackage.objects.filter(file=relative_path).exists()
    ):
        if not request.user.is_authenticated or not request.user.is_staff_or_admin:
            raise PermissionDenied("Export files are staff-only.")
        return backend.deliver(relative_path)

    raise Http404("Media file not registered.")
