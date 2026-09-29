import json
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
from questionnaire.schema import FILE_TYPE

from .models import MaterialCheck, MaterialRequirement, SubmissionFile
from .policies import FILE_PURPOSE_POLICIES

VIDEO_PURPOSES = (
    SubmissionFile.Purpose.BACKGROUND_VIDEO,
    SubmissionFile.Purpose.PERFORMANCE_VIDEO,
)


def delete_storage_object(storage: Storage, name: str) -> None:
    storage.delete(name)


MAX_UPLOAD_BYTES = {
    purpose: policy.max_mb * 1024 * 1024 for purpose, policy in FILE_PURPOSE_POLICIES.items()
}
ALLOWED_EXTENSIONS = {
    purpose: set(policy.extensions) for purpose, policy in FILE_PURPOSE_POLICIES.items()
}
ALLOWED_CONTENT_TYPES = {
    purpose: set(policy.content_types) for purpose, policy in FILE_PURPOSE_POLICIES.items()
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


def validate_upload(uploaded_file, purpose, *, activity=None, allowed_extensions=None):
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
    if allowed_extensions is not None and extension not in {
        str(item).lower() for item in allowed_extensions
    }:
        raise ValidationError("文件扩展名不符合该问卷题目的允许列表。")
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


def questionnaire_material_authority_active(activity) -> bool:
    """Whether a frozen singer questionnaire owns the activity's materials."""
    from ruleset.services import current_frozen_version

    version = current_frozen_version(activity)
    if version is None:
        return False
    try:
        root = json.loads(version.definition)
    except (TypeError, ValueError):
        # A malformed frozen definition must not reopen the legacy writer. The frozen
        # ruleset is already unhealthy; fail closed until staff repairs it through the
        # ruleset authority.
        return True
    return isinstance(root, dict) and root.get("questionnaire") is not None


def _ensure_legacy_singer_materials_allowed(registration) -> None:
    from singer_contest.models import SingerRegistration

    if isinstance(registration, SingerRegistration) and questionnaire_material_authority_active(
        registration.activity
    ):
        raise ValidationError("当前报名由已确认问卷管理，请使用问卷题目上传或审核材料。")


def _slot_filter(owner_filter, *, purpose, question_key):
    """Which uploaded file this one replaces.

    A legacy upload occupies the ``(owner, purpose)`` slot — the one it has always
    occupied. A questionnaire upload occupies its own question's slot, so replacing the
    second round's accompaniment demotes the second round's and nothing else.
    """
    if question_key:
        return {**owner_filter, "question_key": question_key}
    return {**owner_filter, "file_purpose": purpose, "question_key": ""}


@transaction.atomic
def _store_file(
    *,
    owner,
    uploaded_file,
    purpose,
    uploaded_by,
    question_key="",
    source_ruleset_version=None,
    max_mb=None,
    owner_total_quota=False,
    allowed_extensions=None,
):
    """The one storage path both the legacy and the questionnaire uploads go through.

    Callers differ in two places only: which slot the new file occupies, and whether the
    storage quota is counted per slot (legacy, unchanged) or across everything the owner
    has (questionnaire — otherwise every question would hand out a fresh copy of the whole
    per-purpose budget and multiply the disk ceiling by the number of questions).
    """
    validate_upload(
        uploaded_file,
        purpose,
        activity=owner.activity,
        allowed_extensions=allowed_extensions,
    )
    if max_mb is not None and uploaded_file.size > max_mb * 1024 * 1024:
        raise ValidationError(f"文件超过该题目的上限 {max_mb} MB。")
    media_root = Path(settings.MEDIA_ROOT)
    media_root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(media_root).free < settings.ARTFLOW_UPLOAD_MIN_FREE_MB * 1024 * 1024:
        raise ValidationError("存储空间不足，暂时无法接收上传。")
    try:
        # The owner is identified by model *and* pk: a singer registration and a farewell
        # show program are separate tables whose ids both start at 1, so a pk-only key let
        # one owner type consume another's throttle budget for the same actor. The throttle
        # stays keyed on the *purpose*: keying it per question would hand a participant one
        # full upload budget per question they happen to be asked.
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
    slot = _slot_filter(owner_filter, purpose=purpose, question_key=question_key)
    quota_filter = owner_filter if owner_total_quota else slot
    existing_bytes = SubmissionFile.objects.filter(**quota_filter).values_list(
        "file_size", flat=True
    )
    if sum(existing_bytes) + uploaded_file.size > settings.ARTFLOW_UPLOAD_QUOTA_MB * 1024 * 1024:
        raise ValidationError(
            "该报名的文件存储配额已用尽。"
            if owner_total_quota
            else "该报名此用途的文件存储配额已用尽。"
        )
    SubmissionFile.objects.select_for_update().filter(**slot, is_current=True).update(
        is_current=False
    )
    latest = (
        SubmissionFile.objects.filter(**slot)
        .order_by("-version")
        .values_list("version", flat=True)
        .first()
        or 0
    )
    original_name = PurePath(str(uploaded_file.name)).name
    created = SubmissionFile.objects.create(
        **owner_filter,
        question_key=question_key,
        file_purpose=purpose,
        file=uploaded_file,
        original_name=original_name,
        file_size=uploaded_file.size,
        source_ruleset_version=source_ruleset_version,
        uploaded_by=uploaded_by,
        is_test_data=activity.is_test_mode,
        is_current=True,
        version=latest + 1,
    )
    max_versions = settings.ARTFLOW_UPLOAD_MAX_VERSIONS
    if max_versions < 1:
        raise ValidationError("上传版本保留配置无效。")
    stale_files = list(
        SubmissionFile.objects.filter(**slot).order_by("-version", "-pk")[max_versions:]
    )
    for stale_file in stale_files:
        stale_storage = stale_file.file.storage
        stale_name = stale_file.file.name
        stale_file.delete()
        if stale_name:
            transaction.on_commit(partial(delete_storage_object, stale_storage, stale_name))
    _reset_matching_check(locked_owner, purpose, question_key=question_key)
    return created


@transaction.atomic
def store_submission_file(*, owner, uploaded_file, purpose, uploaded_by):
    """Store a legacy, purpose-identified upload (unchanged behaviour)."""
    _ensure_legacy_singer_materials_allowed(owner)
    return _store_file(
        owner=owner,
        uploaded_file=uploaded_file,
        purpose=purpose,
        uploaded_by=uploaded_by,
    )


@transaction.atomic
def store_questionnaire_file(
    *,
    registration,
    question_key,
    uploaded_file,
    actor,
    expected_schema_hash="",
):
    """Store one questionnaire answer file, deriving its technical purpose from the question.

    The caller names a *question*, never a purpose: the current FROZEN questionnaire decides
    which file purpose that question accepts, so a forged ``file_purpose`` is not a case to
    defend against — it is not an input. The schema hash is checked too, so a browser
    holding a form from before the questionnaire changed cannot file an answer under a
    question that means something else now.
    """
    from questionnaire.registration import questionnaire_plan
    from ruleset.services import current_frozen_version

    version = current_frozen_version(registration.activity)
    if version is None:
        raise ValidationError("当前活动没有已确认的赛制，无法上传材料。")
    plan = questionnaire_plan(version)
    if expected_schema_hash and expected_schema_hash != plan.schema_hash:
        raise ValidationError("问卷已更新，请刷新后重试。")
    question = plan.question(question_key)
    if question is None:
        raise ValidationError(f"问卷中没有这一题：{question_key!r}。")
    if question["type"] != FILE_TYPE:
        raise ValidationError(f"这一题不是文件题：{question_key!r}。")
    # Files obey the same phase and supplement authority as text answers. Without this the
    # rules disagreed: after submitting, a participant could not correct their phone number
    # but could still replace their accompaniment.
    from questionnaire.registration import writable_question_keys

    writable = writable_question_keys(
        activity=registration.activity, registration=registration, plan=plan
    )
    if writable is not None and question_key not in writable:
        raise ValidationError(f"当前阶段不可上传该题目的材料：{question_key!r}。")
    config = question["file"]
    stored = _store_file(
        owner=registration,
        uploaded_file=uploaded_file,
        purpose=config["purpose"],
        uploaded_by=actor,
        question_key=question_key,
        source_ruleset_version=version,
        max_mb=config["max_mb"],
        owner_total_quota=True,
        allowed_extensions=config["extensions"],
    )
    from common.models import AuditLog

    AuditLog.objects.create(
        operator=actor,
        action_type=AuditLog.ActionType.UPLOAD_FILE,
        target=f"SubmissionFile:{stored.pk}",
        new_value=stored.original_name,
        note=f"questionnaire:{question_key}",
    )
    return stored


@transaction.atomic
def delete_submission_file(submission_file: SubmissionFile) -> None:
    owner_filter = _owner_filter(submission_file.singer_registration or submission_file.program)
    storage = submission_file.file.storage
    stored_name = submission_file.file.name
    was_current = submission_file.is_current
    purpose = submission_file.file_purpose
    question_key = submission_file.question_key
    submission_file.delete()
    if was_current:
        replacement = (
            SubmissionFile.objects.select_for_update()
            .filter(**_slot_filter(owner_filter, purpose=purpose, question_key=question_key))
            .order_by("-version", "-pk")
            .first()
        )
        if replacement:
            replacement.is_current = True
            replacement.save(update_fields=["is_current"])
    if stored_name:
        transaction.on_commit(partial(delete_storage_object, storage, stored_name))


# Legacy. The fallback material table for a singer activity that has neither configured
# requirements nor a frozen questionnaire. A ruleset that carries a questionnaire is the
# authority on what a singer must submit; this remains for the activities that do not have
# one yet, and is not the place to add a new requirement.
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
    _ensure_legacy_singer_materials_allowed(registration)
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
    if (
        applies_to == MaterialRequirement.AppliesTo.SINGER
        and questionnaire_material_authority_active(locked_activity)
    ):
        raise ValidationError("当前活动的选手材料由已确认问卷管理。")
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


def _reset_matching_check(owner, purpose, *, question_key=""):
    """A brand-new upload supersedes any prior staff review of that material.

    Matching is by the check's own ``file_purpose`` snapshot, not by re-deriving the
    purpose from the activity's current requirements: renaming or deleting a requirement
    must not redirect a fresh upload's review reset onto a different material.

    A questionnaire upload narrows that to its own question. Matching on purpose alone
    would be a real bug the moment four rounds share the accompaniment purpose — replacing
    the second round's file would clear the review of all four.
    """
    if not purpose:
        return
    owner_filter = _owner_filter(owner)
    matching = MaterialCheck.objects.filter(**owner_filter, file_purpose=purpose)
    matching = matching.filter(question_key=question_key)
    matching.update(
        status=MaterialCheck.Status.UPLOADED,
        review_note="",
        reviewed_by=None,
        reviewed_at=None,
    )


@transaction.atomic
def reconcile_questionnaire_material_checks(*, registration, version, plan):
    """One material check per questionnaire question, identified by its question key.

    This is the questionnaire's counterpart to :func:`_reconcile_owner_checks`, and it is
    what makes a staff review possible at all: without it a questionnaire registration has
    no checks, so the staff detail page shows nothing and a supplement can never be granted.

    ``question_key`` is the identity. ``item_name`` is only a label snapshot for display and
    history — matching on it would drift the moment a question was renamed. A file question
    carries the technical purpose it accepts; a text question carries none, because its
    check stands for "was this answered" rather than "was this uploaded".

    Staff review state survives a reconcile, and is dropped only when the material the check
    stands for actually changes: an approval of the old thing must not carry over to a new
    one.
    """
    from questionnaire.models import QuestionnaireResponse
    from questionnaire.runtime import resolve_question_value
    from questionnaire.schema import NOTICE_TYPE

    owner_filter = _owner_filter(registration)
    response = QuestionnaireResponse.objects.filter(
        singer_registration=registration, ruleset_version=version
    ).first()
    answers = (response.answers if response else {}) or {}
    present = {
        row.question_key: row
        for row in SubmissionFile.objects.filter(**owner_filter, is_current=True).exclude(
            question_key=""
        )
    }
    current = {
        check.question_key: check
        for check in MaterialCheck.objects.filter(**owner_filter).exclude(question_key="")
    }

    seen = set()
    checks = []
    for index, question in enumerate(plan.questions):
        if question["type"] == NOTICE_TYPE:
            continue
        key = question["key"]
        seen.add(key)
        purpose = (question.get("file") or {}).get("purpose") or ""
        value = resolve_question_value(
            question, answers=answers, registration=registration, files=present
        )
        # A file question is satisfied by a stored file; anything else by a non-blank
        # answer, using the same rule that decides whether a required question is missing.
        from questionnaire.conditions import is_blank

        satisfied = bool(purpose) and key in present
        if not purpose:
            satisfied = not is_blank(value)
        existing = current.get(key)
        defaults: dict = {
            "sort_order": index,
            "item_name": question["label"],
            "file_purpose": purpose,
            "source_ruleset_version": version,
        }
        if existing is not None and existing.file_purpose != purpose:
            # The question no longer asks for the material the check was approved for.
            defaults["status"] = (
                MaterialCheck.Status.UPLOADED if satisfied else MaterialCheck.Status.MISSING
            )
            defaults["review_note"] = ""
            defaults["reviewed_by"] = None
            defaults["reviewed_at"] = None
        elif existing is None:
            defaults["status"] = (
                MaterialCheck.Status.UPLOADED if satisfied else MaterialCheck.Status.MISSING
            )
        elif existing.status == MaterialCheck.Status.MISSING and satisfied:
            defaults["status"] = MaterialCheck.Status.UPLOADED
        elif existing.status != MaterialCheck.Status.MISSING and not satisfied:
            # Something that was there is gone. The participant's own edits reset their
            # review in the storage services; this catches the rest.
            defaults["status"] = MaterialCheck.Status.MISSING
        else:
            defaults["status"] = existing.status
        check, _created = MaterialCheck.objects.update_or_create(
            question_key=key, defaults=defaults, **owner_filter
        )
        checks.append(check)
    stale = [check for key, check in current.items() if key not in seen]
    if stale:
        MaterialCheck.objects.filter(pk__in=[check.pk for check in stale]).delete()
    return checks


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
    # A questionnaire check carries its question, so the replacement occupies that
    # question's slot: uploading the second round's accompaniment must not demote the
    # first round's, which is exactly what a purpose-scoped write would do.
    return _store_file(
        owner=locked_owner,
        uploaded_file=uploaded_file,
        purpose=locked_check.file_purpose,
        uploaded_by=current_actor,
        question_key=locked_check.question_key,
        source_ruleset_version=locked_check.source_ruleset_version,
        owner_total_quota=bool(locked_check.question_key),
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
