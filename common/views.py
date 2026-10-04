from pathlib import Path

from archive.models import ArchivePackage
from django.core.exceptions import PermissionDenied
from django.db.models import Q
from django.http import Http404
from django.shortcuts import get_object_or_404
from exports.models import ExportTask, GeneratedDocument
from files.models import SubmissionFile
from public_portal.models import PublicMedia, PublicPost

from .delivery import get_delivery_backend


def _submission_file_access(user, submission_file) -> str:
    """Why this caller may read the file: ``"staff"``, ``"owner"``, ``"public"`` or ``""``.

    The reason is not decoration: a caller whose only claim is ``is_public`` is served the
    metadata-free derivative, while staff and the owner keep seeing the private original
    (GOAL §19.3). The owner rule mirrors the previous behaviour exactly — when a
    registration or program is attached, that relation alone decides, and ``uploaded_by``
    is only consulted for an unowned row.
    """
    if user.is_authenticated and user.is_staff_or_admin:
        return "staff"
    if user.is_authenticated:
        if submission_file.singer_registration_id:
            if submission_file.singer_registration.user_id == user.pk:
                return "owner"
        elif submission_file.program_id:
            if submission_file.program.user_id == user.pk:
                return "owner"
        elif submission_file.uploaded_by_id == user.pk:
            return "owner"
    if submission_file.is_public:
        return "public"
    return ""


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
        .filter(Q(file=relative_path) | Q(derivative=relative_path))
        .first()
    )
    if submission_file:
        access = _submission_file_access(request.user, submission_file)
        if not access:
            raise PermissionDenied("You do not have access to this file.")
        if access == "public" and relative_path == submission_file.file.name:
            derivative_name = submission_file.derivative.name if submission_file.derivative else ""
            if derivative_name:
                relative_path = derivative_name
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
