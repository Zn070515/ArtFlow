from functools import partial
from pathlib import PurePath

from common.business_rules import ensure_activity_unlocked
from common.test_data import lock_activity_for_runtime_data
from django.core.exceptions import ValidationError
from django.core.files.storage import Storage
from django.db import transaction
from django.utils import timezone

from .models import MaterialCheck, MaterialRequirement, SubmissionFile


def delete_storage_object(storage: Storage, name: str) -> None:
    storage.delete(name)


MAX_UPLOAD_BYTES = {
    SubmissionFile.Purpose.PROGRAM_IMAGE: 10 * 1024 * 1024,
    SubmissionFile.Purpose.PUBLIC_IMAGE: 10 * 1024 * 1024,
    SubmissionFile.Purpose.SHOWCASE_IMAGE: 10 * 1024 * 1024,
    SubmissionFile.Purpose.ACCOMPANIMENT: 100 * 1024 * 1024,
    SubmissionFile.Purpose.BACKGROUND_VIDEO: 500 * 1024 * 1024,
    SubmissionFile.Purpose.PERFORMANCE_VIDEO: 500 * 1024 * 1024,
    SubmissionFile.Purpose.LYRICS_SCRIPT: 20 * 1024 * 1024,
    SubmissionFile.Purpose.HOST_MATERIAL: 20 * 1024 * 1024,
    SubmissionFile.Purpose.OTHER: 50 * 1024 * 1024,
}

ALLOWED_EXTENSIONS = {
    SubmissionFile.Purpose.PROGRAM_IMAGE: {".jpg", ".jpeg", ".png", ".webp"},
    SubmissionFile.Purpose.PUBLIC_IMAGE: {".jpg", ".jpeg", ".png", ".webp"},
    SubmissionFile.Purpose.SHOWCASE_IMAGE: {".jpg", ".jpeg", ".png", ".webp"},
    SubmissionFile.Purpose.ACCOMPANIMENT: {".mp3", ".wav", ".m4a", ".flac"},
    SubmissionFile.Purpose.BACKGROUND_VIDEO: {".mp4", ".mov", ".webm"},
    SubmissionFile.Purpose.PERFORMANCE_VIDEO: {".mp4", ".mov", ".webm"},
    SubmissionFile.Purpose.LYRICS_SCRIPT: {".txt", ".doc", ".docx", ".pdf"},
    SubmissionFile.Purpose.HOST_MATERIAL: {".txt", ".doc", ".docx", ".pdf"},
    SubmissionFile.Purpose.OTHER: {".txt", ".doc", ".docx", ".pdf", ".zip"},
}

ALLOWED_CONTENT_TYPES = {
    SubmissionFile.Purpose.PROGRAM_IMAGE: {"image/jpeg", "image/png", "image/webp"},
    SubmissionFile.Purpose.PUBLIC_IMAGE: {"image/jpeg", "image/png", "image/webp"},
    SubmissionFile.Purpose.SHOWCASE_IMAGE: {"image/jpeg", "image/png", "image/webp"},
    SubmissionFile.Purpose.ACCOMPANIMENT: {
        "audio/flac",
        "audio/mp4",
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
    },
    SubmissionFile.Purpose.BACKGROUND_VIDEO: {"video/mp4", "video/quicktime", "video/webm"},
    SubmissionFile.Purpose.PERFORMANCE_VIDEO: {"video/mp4", "video/quicktime", "video/webm"},
    SubmissionFile.Purpose.LYRICS_SCRIPT: {
        "application/msword",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
    },
    SubmissionFile.Purpose.HOST_MATERIAL: {
        "application/msword",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
    },
    SubmissionFile.Purpose.OTHER: {
        "application/msword",
        "application/pdf",
        "application/zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
    },
}


def validate_upload(uploaded_file, purpose):
    if purpose not in MAX_UPLOAD_BYTES:
        raise ValidationError("文件用途无效。")
    if not uploaded_file or not getattr(uploaded_file, "size", 0):
        raise ValidationError("不能上传空文件。")
    if uploaded_file.size > MAX_UPLOAD_BYTES[purpose]:
        raise ValidationError("文件超过该用途允许的大小限制。")
    extension = PurePath(str(uploaded_file.name)).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS[purpose]:
        raise ValidationError("文件类型不符合该用途的允许列表。")
    content_type = str(getattr(uploaded_file, "content_type", "") or "").lower()
    if (
        content_type not in {"", "application/octet-stream"}
        and content_type not in ALLOWED_CONTENT_TYPES[purpose]
    ):
        raise ValidationError("文件媒体类型不符合该用途的允许列表。")


def _owner_filter(owner):
    if hasattr(owner, "student_id"):
        return {"singer_registration": owner}
    if hasattr(owner, "program_type"):
        return {"program": owner}
    raise ValidationError("文件必须关联到有效的报名或节目。")


@transaction.atomic
def store_submission_file(*, owner, uploaded_file, purpose, uploaded_by):
    validate_upload(uploaded_file, purpose)
    activity = lock_activity_for_runtime_data(owner.activity)
    ensure_activity_unlocked(activity)
    # Serialize all file operations for the same owner, including the first
    # upload where no current submission row yet exists to lock.
    locked_owner = type(owner).objects.select_for_update().get(pk=owner.pk)
    owner_filter = _owner_filter(locked_owner)
    SubmissionFile.objects.select_for_update().filter(
        **owner_filter, file_purpose=purpose, is_current=True
    ).update(is_current=False)
    latest = (
        SubmissionFile.objects.filter(**owner_filter, file_purpose=purpose)
        .order_by("-version")
        .values_list("version", flat=True)
        .first()
        or 0
    )
    original_name = PurePath(str(uploaded_file.name)).name
    created = SubmissionFile.objects.create(
        **owner_filter,
        file=uploaded_file,
        original_name=original_name,
        file_size=uploaded_file.size,
        file_purpose=purpose,
        uploaded_by=uploaded_by,
        is_test_data=activity.is_test_mode,
        is_current=True,
        version=latest + 1,
    )
    _reset_matching_check(locked_owner, purpose)
    return created


@transaction.atomic
def delete_submission_file(submission_file: SubmissionFile) -> None:
    owner_filter = _owner_filter(submission_file.singer_registration or submission_file.program)
    storage = submission_file.file.storage
    stored_name = submission_file.file.name
    was_current = submission_file.is_current
    purpose = submission_file.file_purpose
    submission_file.delete()
    if was_current:
        replacement = (
            SubmissionFile.objects.select_for_update()
            .filter(**owner_filter, file_purpose=purpose)
            .order_by("-version", "-pk")
            .first()
        )
        if replacement:
            replacement.is_current = True
            replacement.save(update_fields=["is_current"])
    if stored_name:
        transaction.on_commit(partial(delete_storage_object, storage, stored_name))


DEFAULT_SINGER_REQUIREMENTS = [
    ("基本信息", ""),
    ("联系方式", ""),
    ("伴奏文件", SubmissionFile.Purpose.ACCOMPANIMENT),
]

DEFAULT_PROGRAM_REQUIREMENTS = [
    ("基本信息", ""),
    ("负责人联系方式", ""),
    ("伴奏文件", SubmissionFile.Purpose.ACCOMPANIMENT),
]


def sync_singer_material_checks(registration):
    requirements = _requirements_for(
        registration.activity,
        MaterialRequirement.AppliesTo.SINGER,
        DEFAULT_SINGER_REQUIREMENTS,
    )
    return _sync_checks(registration=registration, requirements=requirements)


def sync_program_material_checks(program):
    requirements = _requirements_for(
        program.activity,
        MaterialRequirement.AppliesTo.PROGRAM,
        DEFAULT_PROGRAM_REQUIREMENTS,
    )
    return _sync_checks(program=program, requirements=requirements)


def _requirements_for(activity, applies_to, fallback):
    configured = list(
        MaterialRequirement.objects.filter(activity=activity, applies_to=applies_to).values_list(
            "item_name", "file_purpose"
        )
    )
    return configured or fallback


def _owner_applies_to(owner):
    if hasattr(owner, "student_id"):
        return MaterialRequirement.AppliesTo.SINGER
    if hasattr(owner, "program_type"):
        return MaterialRequirement.AppliesTo.PROGRAM
    return None


def _reset_matching_check(owner, purpose):
    """A brand-new upload supersedes any prior staff review for that purpose."""
    applies_to = _owner_applies_to(owner)
    if applies_to is None or not purpose:
        return
    owner_filter = _owner_filter(owner)
    fallback = (
        DEFAULT_SINGER_REQUIREMENTS
        if applies_to == MaterialRequirement.AppliesTo.SINGER
        else DEFAULT_PROGRAM_REQUIREMENTS
    )
    requirements = _requirements_for(owner.activity, applies_to, fallback)
    reset_names = [item_name for item_name, file_purpose in requirements if file_purpose == purpose]
    if not reset_names:
        return
    MaterialCheck.objects.filter(**owner_filter, item_name__in=reset_names).update(
        status=MaterialCheck.Status.UPLOADED,
        review_note="",
        reviewed_by=None,
        reviewed_at=None,
    )


def review_material_check(check, *, status, note, actor):
    """Record a staff review decision on a material check and audit it."""
    if status not in (MaterialCheck.Status.APPROVED, MaterialCheck.Status.NEEDS_SUPPLEMENT):
        raise ValidationError("无效的审核状态。")
    from common.models import AuditLog

    old_status = check.status
    check.status = status
    check.review_note = (note or "").strip()
    check.reviewed_by = actor
    check.reviewed_at = timezone.now()
    check.save(update_fields=["status", "review_note", "reviewed_by", "reviewed_at"])
    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.REVIEW_MATERIAL,
        target=f"MaterialCheck:{check.pk}",
        old_value=old_status,
        new_value=f"{status}: {check.review_note}",
        note=check.item_name,
    )
    return check


def _sync_checks(registration=None, program=None, requirements=None):
    owner_filter = {"singer_registration": registration} if registration else {"program": program}
    file_queryset = SubmissionFile.objects.filter(**owner_filter)
    current = {c.item_name: c for c in MaterialCheck.objects.filter(**owner_filter)}
    checks = []
    for index, (item_name, file_purpose) in enumerate(requirements or []):
        existing = current.get(item_name)
        if file_purpose:
            has_file = file_queryset.filter(file_purpose=file_purpose, is_current=True).exists()
            if not has_file:
                desired: str = MaterialCheck.Status.MISSING
            elif existing is None:
                desired = MaterialCheck.Status.UPLOADED
            elif existing.status == MaterialCheck.Status.MISSING:
                desired = MaterialCheck.Status.UPLOADED
            else:
                # Preserve staff review state; a brand-new upload already resets
                # to UPLOADED in store_submission_file.
                desired = existing.status
        else:
            desired = existing.status if existing else MaterialCheck.Status.UPLOADED
        check, _ = MaterialCheck.objects.update_or_create(
            item_name=item_name,
            defaults={"status": desired, "sort_order": index},
            **owner_filter,
        )
        checks.append(check)
    return checks
