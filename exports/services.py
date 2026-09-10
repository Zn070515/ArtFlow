from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass
from typing import Any

from accounts.services import require_current_admin
from common.authority import ACTIVITY_STATE, authority_write
from common.business_rules import ensure_activity_unlocked
from common.lifecycle import runtime_is_test, scope_runtime
from common.models import AuditLog
from common.test_data import get_test_data_counts, lock_activity_for_runtime_data
from core.models import Activity
from core.policies import ActivityAction, ensure_activity_action_allowed
from core.services import _enter_archived_phase_locked
from django.core.exceptions import PermissionDenied
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Count, Max
from django.urls import reverse
from django.utils import timezone
from farewell_show.models import Program
from files.models import MaterialCheck, StaffNote, SubmissionFile
from incidents.models import IncidentRecord
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet.worksheet import Worksheet
from public_portal.models import PublicPost
from singer_contest.models import ContestRound, ScoreSummary, SingerRegistration
from singer_contest.services import (
    _eligible_singers,
    authoritative_panel_judges,
    bound_ruleset_version_label,
    missing_score_cells,
    official_stage_award_queryset,
    snapshot_fingerprint,
)
from voting.models import VoteOption, VoteSession

from .models import ArticleTemplate, GeneratedDocument


@dataclass
class PackageArtifact:
    name: str
    content: bytes


def _active_worksheet(workbook: Workbook) -> Worksheet:
    worksheet = workbook.active
    if not isinstance(worksheet, Worksheet):
        raise ValueError("The active workbook sheet must be a worksheet.")
    return worksheet


def _autosize_sheet(worksheet) -> None:
    for column in worksheet.columns:
        letter = column[0].column_letter
        width = max(len(str(cell.value or "")) for cell in column)
        worksheet.column_dimensions[letter].width = min(max(width + 2, 10), 36)


def _xlsx(name: str, workbook: Workbook) -> PackageArtifact:
    stream = io.BytesIO()
    workbook.save(stream)
    return PackageArtifact(f"{name}.xlsx", stream.getvalue())


def build_package_zip(artifacts: list[PackageArtifact]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for artifact in artifacts:
            zf.writestr(artifact.name, artifact.content)
    return buffer.getvalue()


# --- Shared data exports (used by both packages) ---


def _registration_list_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Registration List"
    ws.append(
        [
            "Name",
            "Student ID",
            "College",
            "Class",
            "Phone",
            "Wechat",
            "Song",
            "Original",
            "Pre Status",
            "Live Status",
        ]
    )
    for r in scope_runtime(SingerRegistration.objects.filter(activity=activity), activity):
        ws.append(
            [
                r.name,
                r.student_id,
                r.college,
                r.class_name,
                r.phone,
                r.wechat,
                r.song_name,
                "yes" if r.is_original else "no",
                r.get_pre_status_display(),
                r.get_live_status_display(),
            ]
        )
    _autosize_sheet(ws)
    return wb


def _contact_list_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Contacts"
    ws.append(["Owner Type", "Name", "Student ID", "Phone", "Wechat", "College/Class", "Item"])
    for r in scope_runtime(SingerRegistration.objects.filter(activity=activity), activity):
        ws.append(
            [
                "singer",
                r.name,
                r.student_id,
                r.phone,
                r.wechat,
                f"{r.college} {r.class_name}",
                r.song_name,
            ]
        )
    for p in scope_runtime(Program.objects.filter(activity=activity), activity):
        ws.append(["program", p.contact_name, "", p.contact_phone, "", p.class_name, p.name])
    _autosize_sheet(ws)
    return wb


def _program_list_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Program List"
    ws.append(
        [
            "Order",
            "Name",
            "Type",
            "Contact",
            "Phone",
            "Class/Dept",
            "Performers",
            "Duration",
            "Status",
            "Mic",
            "Props",
            "Notes",
        ]
    )
    for p in scope_runtime(Program.objects.filter(activity=activity), activity).order_by(
        "sort_order", "pk"
    ):
        ws.append(
            [
                p.sort_order,
                p.name,
                p.get_program_type_display(),
                p.contact_name,
                p.contact_phone,
                p.class_name,
                p.performers,
                p.estimated_duration,
                p.get_status_display(),
                p.mic_requirements,
                p.prop_requirements,
                p.special_notes,
            ]
        )
    _autosize_sheet(ws)
    return wb


def _material_checklist_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Material Checklist"
    ws.append(["Owner Type", "Owner", "Item", "Status"])
    for c in MaterialCheck.objects.filter(
        singer_registration__activity=activity,
        singer_registration__is_test_data=runtime_is_test(activity),
    ).select_related("singer_registration"):
        ws.append(
            [
                "singer",
                c.singer_registration.name if c.singer_registration else "",
                c.item_name,
                c.get_status_display(),
            ]
        )
    for c in MaterialCheck.objects.filter(
        program__activity=activity, program__is_test_data=runtime_is_test(activity)
    ).select_related("program"):
        ws.append(
            [
                "program",
                c.program.name if c.program else "",
                c.item_name,
                c.get_status_display(),
            ]
        )
    _autosize_sheet(ws)
    return wb


def _staff_notes_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Staff Notes"
    ws.append(["Owner Type", "Owner", "Content", "Created By", "Time"])
    for n in StaffNote.objects.filter(
        singer_registration__activity=activity,
        singer_registration__is_test_data=runtime_is_test(activity),
    ).select_related("singer_registration", "created_by"):
        ws.append(
            [
                "singer",
                n.singer_registration.name if n.singer_registration else "",
                n.content,
                n.created_by.username if n.created_by else "",
                n.created_at.strftime("%Y-%m-%d %H:%M"),
            ]
        )
    for n in StaffNote.objects.filter(
        program__activity=activity, program__is_test_data=runtime_is_test(activity)
    ).select_related("program", "created_by"):
        ws.append(
            [
                "program",
                n.program.name if n.program else "",
                n.content,
                n.created_by.username if n.created_by else "",
                n.created_at.strftime("%Y-%m-%d %H:%M"),
            ]
        )
    _autosize_sheet(ws)
    return wb


# --- Execution package (pre-event, for on-site staff) ---


def _missing_materials_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Missing Materials"
    ws.append(["Owner Type", "Owner", "Item"])
    for c in MaterialCheck.objects.filter(
        singer_registration__activity=activity,
        singer_registration__is_test_data=runtime_is_test(activity),
        status=MaterialCheck.Status.MISSING,
    ).select_related("singer_registration"):
        ws.append(
            [
                "singer",
                c.singer_registration.name if c.singer_registration else "",
                c.item_name,
            ]
        )
    for c in MaterialCheck.objects.filter(
        program__activity=activity,
        program__is_test_data=runtime_is_test(activity),
        status=MaterialCheck.Status.MISSING,
    ).select_related("program"):
        ws.append(
            [
                "program",
                c.program.name if c.program else "",
                c.item_name,
            ]
        )
    _autosize_sheet(ws)
    return wb


def _host_script_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Host Script"
    ws.append(["Order", "Item", "Performer", "Type", "Notes", "Cue"])
    programs = list(
        scope_runtime(Program.objects.filter(activity=activity), activity).order_by(
            "sort_order", "pk"
        )
    )
    if programs:
        for idx, p in enumerate(programs, 1):
            ws.append(
                [idx, p.name, p.performers or p.contact_name, p.get_program_type_display(), "", ""]
            )
    else:
        singers = list(
            scope_runtime(
                SingerRegistration.objects.filter(
                    activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED
                ),
                activity,
            ).order_by("pk")
        )
        for idx, s in enumerate(singers, 1):
            ws.append([idx, s.song_name, s.name, "song", "", ""])
    _autosize_sheet(ws)
    return wb


def _empty_incident_form_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Empty Incident Form"
    ws.append(["Time", "Event Type", "Singer/Program", "Handler", "Resolution", "Remark"])
    for event_type in IncidentRecord.EventType.values:
        ws.append(["", IncidentRecord.EventType(event_type).label, "", "", "", ""])
    _autosize_sheet(ws)
    return wb


def _add_artflow_meta(
    workbook: Workbook,
    contest_round: ContestRound,
    *,
    entry_ids: list[int],
    judge_ids: list[int],
) -> None:
    """Write a hidden ArtFlowMeta sheet so the importer can fingerprint the file.

    ID is authority on import; name is only a hint. The snapshot lists the exact
    singer/judge set and bound ruleset frozen at export time, plus a fingerprint,
    so the importer rejects a stale or mismatched workbook outright.
    """
    ruleset_version = bound_ruleset_version_label(contest_round)
    schema_version = "1"
    fingerprint = snapshot_fingerprint(
        schema_version=schema_version,
        activity_id=contest_round.activity_id,
        round_id=contest_round.pk,
        ruleset_version=ruleset_version,
        entry_ids=[str(pk) for pk in entry_ids],
        judge_ids=[str(pk) for pk in judge_ids],
    )
    meta = workbook.create_sheet("ArtFlowMeta")
    rows = [
        ("schema_version", schema_version),
        ("activity_id", str(contest_round.activity_id)),
        ("round_id", str(contest_round.pk)),
        ("ruleset_version", ruleset_version),
        ("exported_at", timezone.now().isoformat()),
        ("entry_ids", ",".join(str(pk) for pk in entry_ids)),
        ("judge_ids", ",".join(str(pk) for pk in judge_ids)),
        ("snapshot_fingerprint", fingerprint),
    ]
    for key, value in rows:
        meta.append([key, value])
    meta.sheet_state = "hidden"


def build_score_template_workbook(contest_round: ContestRound) -> Workbook:
    judges = list(authoritative_panel_judges(contest_round))
    singers = list(_eligible_singers(contest_round))
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Score Template"
    header = ["选手ID", "姓名"] + [f"J{j.pk} {j.name}" for j in judges]
    ws.append(header)
    for singer in singers:
        ws.append([singer.pk, singer.name] + ["" for _ in judges])
    for col_idx in range(3, len(header) + 1):
        ws.cell(row=1, column=col_idx).font = Font(bold=True)
        ws.cell(row=1, column=col_idx).alignment = Alignment(horizontal="center")
    _add_artflow_meta(
        wb,
        contest_round,
        entry_ids=[singer.pk for singer in singers],
        judge_ids=[judge.pk for judge in judges],
    )
    _autosize_sheet(ws)
    return wb


def _score_template_workbook(contest_round: ContestRound) -> Workbook:
    return build_score_template_workbook(contest_round)


def _qr_artifact(prefix: str, url: str) -> PackageArtifact:
    import qrcode

    image = qrcode.make(url)
    stream = io.BytesIO()
    image.save(stream)
    return PackageArtifact(f"{prefix}.png", stream.getvalue())


def build_execution_package(activity: Activity, request: Any = None) -> list[PackageArtifact]:
    """Build the pre-event execution package (on-site staff handoff)."""
    artifacts = [
        _xlsx("registration_list", _registration_list_workbook(activity)),
        _xlsx("contact_list", _contact_list_workbook(activity)),
        _xlsx("program_list", _program_list_workbook(activity)),
        _xlsx("material_checklist", _material_checklist_workbook(activity)),
        _xlsx("missing_materials", _missing_materials_workbook(activity)),
        _xlsx("staff_notes", _staff_notes_workbook(activity)),
        _xlsx("host_script", _host_script_workbook(activity)),
        _xlsx("incident_empty_form", _empty_incident_form_workbook(activity)),
    ]
    for contest_round in activity.rounds.order_by("pk"):
        artifacts.append(
            _xlsx(f"score_template_{contest_round.pk}", _score_template_workbook(contest_round))
        )
    for vote_session in scope_runtime(VoteSession.objects.filter(activity=activity), activity):
        path = reverse("voting:vote_entry", args=[vote_session.pk])
        url = request.build_absolute_uri(path) if request is not None else path
        artifacts.append(_qr_artifact(f"vote_qr_{vote_session.pk}", url))
    return artifacts


# --- Archive package (post-event, authoritative record) ---


def _activity_info_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Activity Info"
    ws.append(["Field", "Value"])
    ws.append(["Title", activity.title])
    ws.append(["Subtitle", activity.subtitle])
    ws.append(["Type", activity.get_activity_type_display()])
    ws.append(["Phase", activity.get_phase_display()])
    ws.append(["Description", activity.description])
    ws.append(["Created At", activity.created_at.strftime("%Y-%m-%d %H:%M")])
    _autosize_sheet(ws)
    return wb


def _score_results_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Score Results"
    ws.append(["Round", "Singer", "Average Score", "Rank", "Advanced"])
    summaries = (
        ScoreSummary.objects.filter(
            round__activity=activity, is_test_data=runtime_is_test(activity)
        )
        .select_related("round", "singer")
        .order_by("round_id", "rank")
    )
    for s in summaries:
        ws.append(
            [
                s.round.name or s.round.get_round_type_display(),
                s.singer.name,
                s.average_score,
                s.rank,
                "yes" if s.is_advanced else "no",
            ]
        )
    _autosize_sheet(ws)
    return wb


def _vote_results_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Vote Results"
    ws.append(["Session", "Singer", "Song", "Votes"])
    options = (
        VoteOption.objects.filter(
            vote_session__activity=activity, vote_session__is_test_data=runtime_is_test(activity)
        )
        .select_related("vote_session", "singer")
        .annotate(vote_count=Count("records"))
    )
    for opt in options:
        ws.append([opt.vote_session.name, opt.singer.name, opt.singer.song_name, opt.vote_count])
    _autosize_sheet(ws)
    return wb


def _award_list_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Awards"
    ws.append(["Singer", "Song", "Award"])
    official_awards = official_stage_award_queryset(activity)
    for award in scope_runtime(official_awards, activity).select_related("singer"):
        ws.append([award.singer.name, award.singer.song_name, award.name])
    _autosize_sheet(ws)
    return wb


def _incident_list_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Incidents"
    ws.append(["Time", "Type", "Singer", "Program", "Handler", "Resolution", "Remark"])
    for inc in IncidentRecord.objects.filter(
        activity=activity, is_test=runtime_is_test(activity)
    ).select_related("singer", "program", "handled_by"):
        ws.append(
            [
                inc.occurred_at.strftime("%Y-%m-%d %H:%M"),
                inc.get_event_type_display(),
                inc.singer.name if inc.singer else "",
                inc.program.name if inc.program else "",
                inc.handled_by.username if inc.handled_by else "",
                inc.resolution,
                inc.remark,
            ]
        )
    _autosize_sheet(ws)
    return wb


def _attachment_index_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Attachment Index"
    ws.append(
        [
            "Owner Type",
            "Owner",
            "Purpose",
            "Original Name",
            "Size",
            "Uploaded By",
            "Uploaded At",
            "Current",
            "Public",
        ]
    )
    singer_files = SubmissionFile.objects.filter(
        singer_registration__activity=activity,
        singer_registration__is_test_data=runtime_is_test(activity),
        is_test_data=runtime_is_test(activity),
    ).select_related("singer_registration", "uploaded_by")
    for f in singer_files:
        ws.append(
            [
                "singer",
                f.singer_registration.name if f.singer_registration else "",
                f.get_file_purpose_display(),
                f.original_name,
                f.file_size,
                f.uploaded_by.username if f.uploaded_by else "",
                f.uploaded_at.strftime("%Y-%m-%d %H:%M"),
                "yes" if f.is_current else "no",
                "yes" if f.is_public else "no",
            ]
        )
    program_files = SubmissionFile.objects.filter(
        program__activity=activity, program__is_test_data=runtime_is_test(activity)
    ).select_related("program", "uploaded_by")
    for f in program_files:
        ws.append(
            [
                "program",
                f.program.name if f.program else "",
                f.get_file_purpose_display(),
                f.original_name,
                f.file_size,
                f.uploaded_by.username if f.uploaded_by else "",
                f.uploaded_at.strftime("%Y-%m-%d %H:%M"),
                "yes" if f.is_current else "no",
                "yes" if f.is_public else "no",
            ]
        )
    _autosize_sheet(ws)
    return wb


def _public_content_index_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Public Content"
    ws.append(["Title", "Type", "Status", "Pinned", "Published At", "Updated By"])
    for post in PublicPost.objects.filter(related_activity=activity).select_related("updated_by"):
        ws.append(
            [
                post.title,
                post.get_post_type_display(),
                post.get_status_display(),
                "yes" if post.is_pinned else "no",
                post.published_at.strftime("%Y-%m-%d %H:%M") if post.published_at else "",
                post.updated_by.username if post.updated_by else "",
            ]
        )
    _autosize_sheet(ws)
    return wb


def build_archive_package(activity: Activity) -> list[PackageArtifact]:
    """Build the post-event archive package (authoritative record)."""
    artifacts = [
        _xlsx("activity_info", _activity_info_workbook(activity)),
        _xlsx("registration_list", _registration_list_workbook(activity)),
        _xlsx("material_checklist", _material_checklist_workbook(activity)),
        _xlsx("program_list", _program_list_workbook(activity)),
        _xlsx("score_results", _score_results_workbook(activity)),
        _xlsx("vote_results", _vote_results_workbook(activity)),
        _xlsx("award_list", _award_list_workbook(activity)),
        _xlsx("incident_list", _incident_list_workbook(activity)),
        _xlsx("staff_notes", _staff_notes_workbook(activity)),
        _xlsx("attachment_index", _attachment_index_workbook(activity)),
        _xlsx("public_content_index", _public_content_index_workbook(activity)),
    ]
    for doc in scope_runtime(GeneratedDocument.objects.filter(activity=activity), activity):
        if doc.file:
            with doc.file.open("rb") as document_file:
                artifacts.append(PackageArtifact(f"推文_{doc.pk}.docx", document_file.read()))
    return artifacts


def render_document_bytes(template: ArticleTemplate, activity: Activity) -> bytes:
    """Render a Word document from the template and the activity's current data.

    Used by the preview/download-only path for archived activities and by the
    persistent path, where it runs under the authoritative Activity lock.
    """
    from docx import Document

    doc = Document()
    doc.add_heading(activity.title, 0)
    body = template.body
    singers = scope_runtime(
        SingerRegistration.objects.filter(
            activity=activity,
            pre_status=SingerRegistration.PreStatus.APPROVED,
        ),
        activity,
    )
    singer_lines = "\n".join(f"{s.name} — {s.song_name}" for s in singers)
    programs = scope_runtime(Program.objects.filter(activity=activity), activity)
    program_lines = "\n".join(f"{p.sort_order}. {p.name} — {p.contact_name}" for p in programs)
    body = body.replace("{title}", activity.title)
    body = body.replace("{subtitle}", activity.subtitle or "")
    body = body.replace("{date}", activity.created_at.strftime("%Y年%m月%d日"))
    body = body.replace("{time}", "")
    body = body.replace("{venue}", "")
    body = body.replace("{content}", "")
    body = body.replace("{singers}", singer_lines)
    body = body.replace("{programs}", program_lines)
    body = body.replace("{sign_off}", "浙江工业大学 信息工程学院 文艺部")
    for para_text in body.split("\n"):
        doc.add_paragraph(para_text)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


@transaction.atomic
def generate_persistent_document(
    activity: Activity, template: ArticleTemplate, author: Any, *, note: str = ""
) -> tuple[GeneratedDocument, bytes]:
    """Generate and persist an official Word asset under the Activity lock.

    The Activity row is locked first, then ARCHIVED / global-lock are rejected,
    then source data is re-read under the authoritative state before the document
    is built. This keeps the persisted asset consistent with the DB and prevents a
    stale pre-lock document from being frozen as the latest one.
    """
    locked_activity = Activity.objects.select_for_update().get(pk=activity.pk)
    if locked_activity.phase == Activity.Phase.ARCHIVED:
        raise PermissionDenied("活动已归档，不能新增正式文档。")
    ensure_activity_unlocked(locked_activity)
    content = render_document_bytes(template, locked_activity)
    doc_obj = GeneratedDocument.objects.create(
        template=template,
        activity=locked_activity,
        title=template.name,
        created_by=author,
        is_test_data=locked_activity.is_test_mode,
    )
    doc_obj.file.save(f"{template.template_type}_{locked_activity.pk}.docx", ContentFile(content))
    AuditLog.objects.create(
        operator=author,
        action_type=AuditLog.ActionType.EXPORT,
        target=f"GeneratedDocument:{doc_obj.pk}",
        new_value=json.dumps(
            {
                "template": template.template_type,
                "activity": locked_activity.pk,
                "title": template.name,
                "is_test_data": locked_activity.is_test_mode,
            },
            ensure_ascii=False,
        ),
        note=note,
    )
    return doc_obj, content


@transaction.atomic
def archive_activity(activity: Activity, actor: Any, *, note: str = "") -> Any:
    """Archive a formal, finalized activity: validate readiness, generate the
    package, transition phase to ARCHIVED, lock, and audit — all atomically."""
    from archive.models import ArchivePackage

    current_actor = require_current_admin(actor)
    locked_activity = lock_activity_for_runtime_data(activity)
    if locked_activity.data_lifecycle != Activity.DataLifecycle.FORMAL:
        raise PermissionDenied("只有正式活动才能归档。")
    if locked_activity.phase == Activity.Phase.ARCHIVED:
        raise PermissionDenied("活动已经归档。")
    ensure_activity_action_allowed(locked_activity, ActivityAction.ARCHIVE)

    if any(get_test_data_counts(locked_activity).values()):
        raise PermissionDenied("存在残留测试数据，不能归档。")

    for contest_round in locked_activity.rounds.select_for_update().order_by("pk"):
        round_label = contest_round.name or contest_round.get_round_type_display()
        if contest_round.status != ContestRound.Status.LOCKED or not contest_round.is_locked:
            raise PermissionDenied(f"轮次「{round_label}」尚未锁定，不能归档。")
        if missing_score_cells(contest_round):
            raise PermissionDenied(f"轮次「{round_label}」存在缺失评分，不能归档。")

    for vote_session in locked_activity.vote_sessions.all():
        if not vote_session.is_locked:
            raise PermissionDenied(f"投票「{vote_session.name}」尚未锁定，不能归档。")

    artifacts = build_archive_package(locked_activity)
    ArchivePackage.objects.filter(activity=locked_activity, is_current=True).update(
        is_current=False
    )
    next_version = (
        ArchivePackage.objects.filter(activity=locked_activity).aggregate(
            max_version=Max("version")
        )["max_version"]
        or 0
    ) + 1
    package = ArchivePackage.objects.create(
        activity=locked_activity,
        includes=", ".join(a.name for a in artifacts),
        note=note,
        created_by=current_actor,
        version=next_version,
        is_current=True,
    )
    saved_name: str | None = None
    try:
        package.file.save(
            f"archive_{locked_activity.pk}.zip", ContentFile(build_package_zip(artifacts))
        )
        saved_name = package.file.name

        old_phase = locked_activity.phase
        if old_phase != Activity.Phase.ARCHIVED:
            locked_activity = _enter_archived_phase_locked(
                locked_activity, actor=current_actor, note=note
            )
        locked_activity.is_locked = True
        locked_activity.locked_at = timezone.now()
        locked_activity.locked_by = current_actor
        with authority_write(ACTIVITY_STATE):
            locked_activity.save(update_fields=["is_locked", "locked_at", "locked_by"])

        AuditLog.objects.create(
            operator=current_actor,
            action_type=AuditLog.ActionType.ARCHIVE_ACTIVITY,
            target=f"Activity:{locked_activity.pk}",
            old_value=old_phase,
            new_value=Activity.Phase.ARCHIVED,
            note=note,
        )
    except Exception:
        # The storage write is not rolled back with the DB; drop the orphan file.
        if saved_name:
            package.file.storage.delete(saved_name)
        raise
    return package
