import shutil
import zipfile
from functools import partial
from pathlib import Path, PurePath

from accounts.services import require_current_staff
from common.rate_limit import RateLimitExceeded, hit_rate_limit
from core.models import Activity
from core.policies import ActivityAction
from core.services import lock_activity_for_action
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.files.storage import Storage
from django.db import transaction
from django.utils import timezone
from PIL import Image, UnidentifiedImageError

from .models import MaterialCheck, MaterialRequirement, SubmissionFile

VIDEO_PURPOSES = (
    SubmissionFile.Purpose.BACKGROUND_VIDEO,
    SubmissionFile.Purpose.PERFORMANCE_VIDEO,
)


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


def video_upload_cap_bytes(activity) -> int:
    """Deny oversized video direct-uploads for a formal activity.

    Test-mode and non-activity scenarios keep the larger developer cap so local
    rehearsal data still works; a formal activity's performers are not expected
    to source a large file through the browser on the first round.
    """
    if activity is not None and activity.data_lifecycle == Activity.DataLifecycle.FORMAL:
        return settings.ARTFLOW_VIDEO_UPLOAD_MAX_MB * 1024 * 1024
    return max(MAX_UPLOAD_BYTES[purpose] for purpose in VIDEO_PURPOSES)


def large_video_upload_allowed(activity) -> bool:
    """Whether the UI may offer a video direct-upload for this activity.

    A formal activity hides the performer-sourced video field; test-mode or
    unloaded activities keep it available for local rehearsal. The byte cap is
    enforced separately by validate_upload for any crafted request.
    """
    return activity is None or activity.data_lifecycle != Activity.DataLifecycle.FORMAL


def validate_upload(uploaded_file, purpose, *, activity=None):
    if purpose not in MAX_UPLOAD_BYTES:
        raise ValidationError("文件用途无效。")
    if not uploaded_file or not getattr(uploaded_file, "size", 0):
        raise ValidationError("不能上传空文件。")
    if purpose in VIDEO_PURPOSES:
        cap = video_upload_cap_bytes(activity)
        if cap <= 0 or uploaded_file.size > cap:
            raise ValidationError("正式活动不支持大视频直传。")
    elif uploaded_file.size > MAX_UPLOAD_BYTES[purpose]:
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
    _validate_file_signature(uploaded_file, extension)


def _read_upload_header(uploaded_file, limit: int = 4096) -> bytes:
    try:
        uploaded_file.seek(0)
        return uploaded_file.read(limit)
    finally:
        uploaded_file.seek(0)


def _validate_file_signature(uploaded_file, extension: str) -> None:
    """Reject renamed/random bytes before a file reaches persistent storage."""
    header = _read_upload_header(uploaded_file)
    try:
        if extension in {".jpg", ".jpeg", ".png", ".webp"}:
            uploaded_file.seek(0)
            with Image.open(uploaded_file) as image:
                image.verify()
        elif extension == ".mp3":
            valid = header.startswith(b"ID3") or (
                len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0
            )
            if not valid:
                raise ValueError("invalid MP3 frame")
        elif extension == ".wav":
            if not (header.startswith(b"RIFF") and header[8:12] == b"WAVE"):
                raise ValueError("invalid WAV header")
        elif extension == ".flac":
            if not header.startswith(b"fLaC"):
                raise ValueError("invalid FLAC header")
        elif extension == ".m4a":
            if len(header) < 12 or header[4:8] != b"ftyp":
                raise ValueError("invalid M4A container")
        elif extension in {".mp4", ".mov"}:
            if len(header) < 12 or header[4:8] != b"ftyp":
                raise ValueError("invalid MP4/MOV container")
        elif extension == ".webm":
            if not header.startswith(b"\x1a\x45\xdf\xa3"):
                raise ValueError("invalid WebM container")
        elif extension == ".pdf":
            if not header.startswith(b"%PDF-"):
                raise ValueError("invalid PDF header")
        elif extension in {".zip", ".docx"}:
            uploaded_file.seek(0)
            with zipfile.ZipFile(uploaded_file) as archive:
                if archive.testzip() is not None:
                    raise ValueError("corrupt ZIP entry")
                if extension == ".docx" and not {
                    "[Content_Types].xml",
                    "word/document.xml",
                }.issubset(archive.namelist()):
                    raise ValueError("invalid DOCX package")
        elif extension == ".doc":
            if not header.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
                raise ValueError("invalid legacy Word container")
        elif extension == ".txt":
            header.decode("utf-8")
    except (OSError, ValueError, UnicodeDecodeError, UnidentifiedImageError, zipfile.BadZipFile):
        raise ValidationError("文件内容与扩展名不匹配或文件已损坏。") from None
    finally:
        uploaded_file.seek(0)


def _owner_filter(owner):
    if hasattr(owner, "student_id"):
        return {"singer_registration": owner}
    if hasattr(owner, "program_type"):
        return {"program": owner}
    raise ValidationError("文件必须关联到有效的报名或节目。")


@transaction.atomic
def store_submission_file(*, owner, uploaded_file, purpose, uploaded_by):
    validate_upload(uploaded_file, purpose, activity=owner.activity)
    media_root = Path(settings.MEDIA_ROOT)
    media_root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(media_root).free < settings.ARTFLOW_UPLOAD_MIN_FREE_MB * 1024 * 1024:
        raise ValidationError("存储空间不足，暂时无法接收上传。")
    try:
        # The owner is identified by model *and* pk: a singer registration and a farewell
        # show program are separate tables whose ids both start at 1, so a pk-only key let
        # one owner type consume another's throttle budget for the same actor.
        owner_key = f"{type(owner).__name__.lower()}:{owner.pk}"
        hit_rate_limit(
            f"upload:{getattr(uploaded_by, 'pk', 'anonymous')}:{owner_key}:{purpose}",
            limit=settings.ARTFLOW_UPLOAD_RATE_LIMIT,
            window_seconds=settings.ARTFLOW_UPLOAD_RATE_WINDOW_SECONDS,
        )
    except RateLimitExceeded:
        raise ValidationError("上传操作过于频繁，请稍后再试。") from None
    activity = lock_activity_for_action(owner.activity, ActivityAction.UPLOAD_MATERIAL)
    # Serialize all file operations for the same owner, including the first
    # upload where no current submission row yet exists to lock.
    locked_owner = type(owner).objects.select_for_update().get(pk=owner.pk)
    owner_filter = _owner_filter(locked_owner)
    existing_bytes = SubmissionFile.objects.filter(
        **owner_filter, file_purpose=purpose
    ).values_list("file_size", flat=True)
    if sum(existing_bytes) + uploaded_file.size > settings.ARTFLOW_UPLOAD_QUOTA_MB * 1024 * 1024:
        raise ValidationError("该报名此用途的文件存储配额已用尽。")
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
    max_versions = settings.ARTFLOW_UPLOAD_MAX_VERSIONS
    if max_versions < 1:
        raise ValidationError("上传版本保留配置无效。")
    stale_files = list(
        SubmissionFile.objects.filter(**owner_filter, file_purpose=purpose).order_by(
            "-version", "-pk"
        )[max_versions:]
    )
    for stale_file in stale_files:
        stale_storage = stale_file.file.storage
        stale_name = stale_file.file.name
        stale_file.delete()
        if stale_name:
            transaction.on_commit(partial(delete_storage_object, stale_storage, stale_name))
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


def reconcile_singer_material_checks(registration):
    """Recompute a singer registration's MaterialCheck rows under authority.

    Authoritative transaction: locks the Activity (re-checking mutability), then
    the owner row, then reconciles checks against current requirements and prunes
    stale rows (a deleted requirement no longer surfaces as a check).
    """
    return _reconcile_owner_under_authority(
        registration, MaterialRequirement.AppliesTo.SINGER, DEFAULT_SINGER_REQUIREMENTS
    )


def reconcile_program_material_checks(program):
    """Recompute a program's MaterialCheck rows under authority (see above)."""
    return _reconcile_owner_under_authority(
        program, MaterialRequirement.AppliesTo.PROGRAM, DEFAULT_PROGRAM_REQUIREMENTS
    )


@transaction.atomic
def reconcile_activity_material_checks(activity, applies_to):
    """Reconcile every runtime owner of an activity for one requirement scope.

    Used after MaterialRequirement create/update/delete: locks the Activity,
    re-checks mutability, then locks each affected owner and reconciles so added
    requirements surface as new checks and pruned requirements drop their checks.
    """
    locked_activity = lock_activity_for_action(activity)
    _ensure_material_checks_writable(locked_activity)
    if applies_to not in MaterialRequirement.AppliesTo.values:
        raise ValidationError("无效的适用范围。")
    owner_model = _owner_model_for_applies_to(applies_to)
    fallback = (
        DEFAULT_SINGER_REQUIREMENTS
        if applies_to == MaterialRequirement.AppliesTo.SINGER
        else DEFAULT_PROGRAM_REQUIREMENTS
    )
    requirements = _requirements_for(locked_activity, applies_to, fallback)
    for owner in owner_model.objects.filter(activity=locked_activity).select_for_update():
        _reconcile_owner_checks(owner, requirements)
    return locked_activity


@transaction.atomic
def _reconcile_owner_under_authority(owner, applies_to, fallback):
    locked_activity = lock_activity_for_action(owner.activity)
    _ensure_material_checks_writable(locked_activity)
    locked_owner = type(owner).objects.select_for_update().get(pk=owner.pk)
    if locked_owner.activity_id != locked_activity.pk:
        raise PermissionDenied("材料检查项不属于当前活动。")
    requirements = _requirements_for(locked_activity, applies_to, fallback)
    return _reconcile_owner_checks(locked_owner, requirements)


def _ensure_material_checks_writable(activity):
    if activity.phase == Activity.Phase.ARCHIVED:
        raise PermissionDenied("活动已归档，为只读状态。")
    return activity


def _owner_model_for_applies_to(applies_to):
    if applies_to == MaterialRequirement.AppliesTo.SINGER:
        from singer_contest.models import SingerRegistration

        return SingerRegistration
    if applies_to == MaterialRequirement.AppliesTo.PROGRAM:
        from farewell_show.models import Program

        return Program
    raise ValidationError("无效的适用范围。")


def _requirements_for(activity, applies_to, fallback):
    configured = list(
        MaterialRequirement.objects.filter(activity=activity, applies_to=applies_to).values_list(
            "item_name", "file_purpose"
        )
    )
    return configured or fallback


def _reset_matching_check(owner, purpose):
    """A brand-new upload supersedes any prior staff review of that material type.

    Matching is by the check's own ``file_purpose`` snapshot, not by re-deriving the
    purpose from the activity's current requirements: renaming or deleting a requirement
    must not redirect a fresh upload's review reset onto a different material.
    """
    if not purpose:
        return
    owner_filter = _owner_filter(owner)
    MaterialCheck.objects.filter(**owner_filter, file_purpose=purpose).update(
        status=MaterialCheck.Status.UPLOADED,
        review_note="",
        reviewed_by=None,
        reviewed_at=None,
    )


@transaction.atomic
def review_material_check(check, *, status, note, actor):
    """Record a staff review decision on a material check and audit it.

    Authoritative transaction: locks the parent Activity first (re-validating the
    global lock and the REVIEW_REGISTRATION phase action), then the MaterialCheck
    row. A concurrent activity lock/archive therefore either commits before this
    review (which then sees the new state) or blocks/blocks it.
    """
    current_actor = require_current_staff(actor)
    if status not in (MaterialCheck.Status.APPROVED, MaterialCheck.Status.NEEDS_SUPPLEMENT):
        raise ValidationError("无效的审核状态。")
    from common.models import AuditLog

    owner = check.singer_registration or check.program
    if owner is None:
        raise ValidationError("材料检查项未关联有效报名，无法审核。")
    activity = lock_activity_for_action(owner.activity, ActivityAction.REVIEW_REGISTRATION)
    # A left outer join is invalid with FOR UPDATE on PostgreSQL (the nullable
    # singer_registration / program FKs become the null side), so lock the row
    # without select_related and resolve the owner lazily.
    locked_check = MaterialCheck.objects.select_for_update().get(pk=check.pk)
    locked_owner = locked_check.singer_registration or locked_check.program
    if locked_owner is None or locked_owner.activity_id != activity.pk:
        raise ValidationError("材料检查项不属于当前活动。")
    old_status = locked_check.status
    locked_check.status = status
    locked_check.review_note = (note or "").strip()
    locked_check.reviewed_by = current_actor
    locked_check.reviewed_at = timezone.now()
    locked_check.save(update_fields=["status", "review_note", "reviewed_by", "reviewed_at"])
    AuditLog.objects.create(
        operator=current_actor,
        action_type=AuditLog.ActionType.REVIEW_MATERIAL,
        target=f"MaterialCheck:{locked_check.pk}",
        old_value=old_status,
        new_value=f"{status}: {locked_check.review_note}",
        note=locked_check.item_name,
    )
    return locked_check


UNKNOWN_CHECK_MESSAGE = "该材料项不存在或无权提交。"

# §4.6 phase policy: free editing while registration is open; after it closes, only a
# staff-designated supplement check remains writable for the participant.
_PARTICIPANT_FREE_UPLOAD_PHASES = (Activity.Phase.REGISTRATION_OPEN,)
_PARTICIPANT_SUPPLEMENT_PHASES = (
    Activity.Phase.REGISTRATION_CLOSED,
    Activity.Phase.REVIEWING,
)


def participant_uploadable_check_ids(owner) -> set[int]:
    """The file-backed checks this owner's participant may upload to right now.

    A read-only mirror of :func:`submit_participant_material_for_check`'s phase rule for
    rendering only. Hiding a button is never the authorization boundary; a crafted POST
    is judged by the service alone.
    """
    activity = owner.activity
    if activity.is_locked:
        return set()
    if activity.phase in _PARTICIPANT_FREE_UPLOAD_PHASES:
        eligible_status = None
    elif activity.phase in _PARTICIPANT_SUPPLEMENT_PHASES:
        eligible_status = MaterialCheck.Status.NEEDS_SUPPLEMENT
    else:
        return set()
    checks = MaterialCheck.objects.filter(**_owner_filter(owner)).exclude(file_purpose="")
    if eligible_status is not None:
        checks = checks.filter(status=eligible_status)
    return set(checks.values_list("pk", flat=True))


def _require_owner_actor(actor, owner):
    """Re-read the acting account and require it to own ``owner``."""
    actor_pk = getattr(actor, "pk", None)
    if not actor_pk:
        raise PermissionDenied("当前操作者无有效账户。")
    current_actor = get_user_model().objects.filter(pk=actor_pk, is_active=True).first()
    if current_actor is None:
        raise PermissionDenied("当前操作者账户无效。")
    if owner.user_id != current_actor.pk:
        raise ValidationError(UNKNOWN_CHECK_MESSAGE)
    return current_actor


def _ensure_participant_upload_phase(activity) -> None:
    allowed = (*_PARTICIPANT_FREE_UPLOAD_PHASES, *_PARTICIPANT_SUPPLEMENT_PHASES)
    if activity.phase not in allowed:
        raise ValidationError("当前活动阶段不允许选手提交材料。")


@transaction.atomic
def submit_participant_material_for_check(*, owner, check_id, uploaded_file, actor):
    """The participant material authority: one file, one staff-designated check.

    A participant upload is addressed by the *check* it fulfils, never by a
    browser-supplied ``file_purpose``: the purpose is the server-maintained
    :attr:`MaterialCheck.file_purpose` snapshot, so renaming, reordering or deleting a
    :class:`MaterialRequirement` cannot redirect a participant's file into a different
    material type.

    Phase policy (§4.6): while the activity is ``REGISTRATION_OPEN`` the participant may
    freely (re)upload any of their own file-backed checks; from ``REGISTRATION_CLOSED``
    and ``REVIEWING`` onward the only upload authority is a check the staff explicitly set
    to ``NEEDS_SUPPLEMENT``. Everything else — another owner's check, another activity's
    check, a non-file check, a forged id, a locked or archived activity — writes nothing.

    Lock order follows the repository's Activity-first rule (Activity → owner → check →
    SubmissionFile), and the check is re-read under its own lock so a concurrent staff
    review cannot be raced between the read and the write (TOCTOU).
    """
    if not uploaded_file:
        raise ValidationError("请选择要上传的文件。")
    owner_filter = _owner_filter(owner)
    locked_activity = lock_activity_for_action(owner.activity)
    locked_owner = type(owner).objects.select_for_update().get(pk=owner.pk)
    if locked_owner.activity_id != locked_activity.pk:
        raise PermissionDenied("材料检查项不属于当前活动。")
    current_actor = _require_owner_actor(actor, locked_owner)
    _ensure_participant_upload_phase(locked_activity)
    check_token = str(check_id or "").strip()
    locked_check = None
    if check_token.isdigit():
        locked_check = (
            MaterialCheck.objects.select_for_update()
            .filter(pk=int(check_token), **owner_filter)
            .first()
        )
    if locked_check is None or not locked_check.file_purpose:
        raise ValidationError(UNKNOWN_CHECK_MESSAGE)
    if (
        locked_activity.phase in _PARTICIPANT_SUPPLEMENT_PHASES
        and locked_check.status != MaterialCheck.Status.NEEDS_SUPPLEMENT
    ):
        raise ValidationError("该材料项当前未要求补交，请联系工作人员。")
    return store_submission_file(
        owner=locked_owner,
        uploaded_file=uploaded_file,
        purpose=locked_check.file_purpose,
        uploaded_by=current_actor,
    )


def _reconcile_owner_checks(owner, requirements):
    """Reconcile checks for a single already-locked owner; caller owns authority.

    Precondition: the owner row is locked and its Activity authority has been
    validated. Creates/updates one check per effective requirement and deletes any
    check whose requirement no longer exists, so stale rows never display.
    """
    owner_filter = _owner_filter(owner)
    file_queryset = SubmissionFile.objects.filter(**owner_filter)
    current = {c.item_name: c for c in MaterialCheck.objects.filter(**owner_filter)}
    present_names = set()
    checks = []
    for index, (item_name, file_purpose) in enumerate(requirements or []):
        present_names.add(item_name)
        existing = current.get(item_name)
        purpose = file_purpose or ""
        has_file = (
            bool(purpose) and file_queryset.filter(file_purpose=purpose, is_current=True).exists()
        )
        defaults: dict = {"sort_order": index, "file_purpose": purpose}
        if existing is not None and existing.file_purpose != purpose:
            # The requirement's material type changed. A staff approval of the old type
            # must not carry over to a different material (authority leak), so recompute
            # the status from the files that actually exist and drop the stale review.
            defaults["status"] = (
                MaterialCheck.Status.UPLOADED if has_file else MaterialCheck.Status.MISSING
            )
            defaults["review_note"] = ""
            defaults["reviewed_by"] = None
            defaults["reviewed_at"] = None
        elif purpose:
            if not has_file:
                defaults["status"] = MaterialCheck.Status.MISSING
            elif existing is None or existing.status == MaterialCheck.Status.MISSING:
                defaults["status"] = MaterialCheck.Status.UPLOADED
            else:
                # Preserve staff review state; a brand-new upload already resets
                # to UPLOADED in store_submission_file.
                defaults["status"] = existing.status
        else:
            defaults["status"] = existing.status if existing else MaterialCheck.Status.UPLOADED
        check, _ = MaterialCheck.objects.update_or_create(
            item_name=item_name,
            defaults=defaults,
            **owner_filter,
        )
        checks.append(check)
    stale = [c for name, c in current.items() if name not in present_names]
    if stale:
        MaterialCheck.objects.filter(pk__in=[c.pk for c in stale]).delete()
    return checks
