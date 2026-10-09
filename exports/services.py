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
from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Max
from django.urls import reverse
from django.utils import timezone
from farewell_show.models import Program
from files.models import MaterialCheck, StaffNote, SubmissionFile
from incidents.models import IncidentRecord
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet.worksheet import Worksheet
from public_portal.models import PublicPost
from public_portal.services import qr_print_host_warning
from questionnaire.projection import generic_song_label, prime_questionnaire_answers
from singer_contest.group_chorus import (
    current_group_members,
    group_material_readiness,
    group_stage_archive_blocker,
)
from singer_contest.judge_entry import judge_entry_credential
from singer_contest.models import (
    ContestRound,
    GroupStage,
    ScoreSummary,
    SingerRegistration,
    StageResult,
)
from singer_contest.services import (
    _eligible_singers,
    authoritative_panel_judges,
    bound_ruleset_version_label,
    build_result_closure,
    missing_score_cells,
    official_stage_award_queryset,
    snapshot_fingerprint,
)
from voting.models import VoteOption
from voting.services import valid_vote_count

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
    rows = prime_questionnaire_answers(
        scope_runtime(SingerRegistration.objects.filter(activity=activity), activity)
    )
    for r in rows:
        ws.append(
            [
                r.name,
                r.student_id,
                r.college,
                r.class_name,
                r.phone,
                r.wechat,
                generic_song_label(r),
                "yes" if r.is_original else "no",
                r.get_pre_status_display(),
                r.get_live_status_display(),
            ]
        )
    _autosize_sheet(ws)
    return wb


def _registration_archive_workbook(activity: Activity) -> Workbook:
    """Build a permanent registration index without direct contact identifiers."""
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Registration Archive"
    ws.append(["Name", "College", "Class", "Song", "Original", "Pre Status", "Live Status"])
    rows = prime_questionnaire_answers(
        scope_runtime(SingerRegistration.objects.filter(activity=activity), activity)
    )
    for r in rows:
        ws.append(
            [
                r.name,
                r.college,
                r.class_name,
                generic_song_label(r),
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
    rows = prime_questionnaire_answers(
        scope_runtime(SingerRegistration.objects.filter(activity=activity), activity)
    )
    for r in rows:
        ws.append(
            [
                "singer",
                r.name,
                r.student_id,
                r.phone,
                r.wechat,
                f"{r.college} {r.class_name}",
                generic_song_label(r),
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


def _program_archive_workbook(activity: Activity) -> Workbook:
    """Build a permanent program index without contact identity or phone data."""
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Program Archive"
    ws.append(["Order", "Name", "Type", "Class/Dept", "Performers", "Duration", "Status"])
    for p in scope_runtime(Program.objects.filter(activity=activity), activity).order_by(
        "sort_order", "pk"
    ):
        ws.append(
            [
                p.sort_order,
                p.name,
                p.get_program_type_display(),
                p.class_name,
                p.performers,
                p.estimated_duration,
                p.get_status_display(),
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
    for c in MaterialCheck.objects.filter(
        group__stage__activity=activity,
        group__stage__is_test_data=runtime_is_test(activity),
    ).select_related("group", "group__stage"):
        ws.append(
            [
                "group",
                f"{c.group.stage.name} / {c.group.name}" if c.group else "",
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
    for c in MaterialCheck.objects.filter(
        group__stage__activity=activity,
        group__stage__is_test_data=runtime_is_test(activity),
        status=MaterialCheck.Status.MISSING,
    ).select_related("group", "group__stage"):
        ws.append(
            [
                "group",
                f"{c.group.stage.name} / {c.group.name}" if c.group else "",
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
        singers = prime_questionnaire_answers(
            scope_runtime(
                SingerRegistration.objects.filter(
                    activity=activity, pre_status=SingerRegistration.PreStatus.APPROVED
                ),
                activity,
            ).order_by("pk")
        )
        for idx, s in enumerate(singers, 1):
            ws.append([idx, generic_song_label(s), s.name, "song", "", ""])
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
    for kind, route_name in (
        ("activity", "public_portal:activity_entry"),
        ("apply", "public_portal:activity_apply"),
        ("live", "public_portal:activity_live"),
        ("judge", "public_portal:activity_judge"),
    ):
        path = reverse(route_name, kwargs={"public_code": activity.public_code})
        url = request.build_absolute_uri(path) if request is not None else path
        if kind == "judge":
            # The judge QR is the one that carries a capability: the URL *is* the entry
            # credential. It rides in the fragment, which the browser never sends, so it
            # stays out of access logs and out of `Referer`. Without it the printed sheet
            # would advertise a door that anyone holding the sheet could open.
            url = f"{url}#{judge_entry_credential(activity)}"
        artifacts.append(_qr_artifact(f"{kind}_qr", url))
    # GOAL §11.5. The QR centre warns on screen; this ZIP is the artefact that actually
    # reaches a printer, and it carried four ready-to-print PNGs built from whatever host
    # served the request. A LAN rehearsal is a legitimate use — so the codes are still
    # produced — but the package has to say what they are, or the warning only exists on
    # the screen the operator looked at an hour earlier.
    if request is not None:
        warning = qr_print_host_warning(request)
        if warning:
            artifacts.append(
                PackageArtifact(
                    "QR-NOT-FOR-PRINT.txt",
                    (
                        f"{warning}\n\n本执行包中的 qr PNG 仅供彩排使用；"
                        "正式印刷件必须从正式 HTTPS 域名下的二维码中心重新生成。\n"
                    ).encode("utf-8"),
                )
            )
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


def _stage_results_workbook(activity: Activity) -> Workbook:
    """The confirmed result line, which `score_results` alone no longer describes.

    ``ScoreSummary`` is a per-round average and rank; the formal outcome of the contest
    is a ``StageResult`` and its ``StageDecision`` rows, and only a CONFIRMED one is
    authoritative (GOAL §8.4). A package that calls itself the authoritative record while
    containing only the former cannot answer "which version of the result was confirmed,
    by whom, and what did it decide". No fingerprints, hashes or reasons are exported
    here — the point is the decision, not the resolver's internals.

    The rows come from the result closure, not from a scan of the activity's whole
    ``StageResult`` history. Scanning by hand was wrong in a way that only shows up when a
    ruleset changes: a stage the current frozen ruleset no longer declares — a ``semifinal``
    dropped in v2 — keeps its old confirmed row forever, and the archive would present it
    as part of the authoritative record next to the stage keys that *are* current. The
    closure already answers "which stage keys does the current ruleset declare, and which
    result version is current for each", so the sheet asks it instead of re-deriving it.
    """
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Stage Results"
    ws.append(
        [
            "Stage Key",
            "Result Version",
            "Ruleset Version",
            "Status",
            "Confirmed At",
            "Confirmed By",
            "Singer",
            "Outcome",
            "Rank",
            "Score",
        ]
    )
    closure = build_result_closure(activity)
    current_results = {
        result.pk: result
        for result in StageResult.objects.filter(
            pk__in=[stage.current_result_id for stage in closure.stages if stage.current_result_id]
        ).select_related("ruleset_version__ruleset", "confirmed_by")
    }
    for stage in closure.stages:
        result = current_results.get(stage.current_result_id or -1)
        if result is None:
            # A current checkpoint with no result yet: name it, so the sheet shows the
            # stage exists rather than silently omitting it. Only reachable from the
            # preview package, since archiving requires a closed result line.
            ws.append([stage.stage_key, "", "", "", "", "", "", "", "", ""])
            continue
        stage_key = result.stage_key
        result_label = f"{result.ruleset_version.ruleset.name} v{result.ruleset_version.version}"
        base = [
            stage_key,
            result.result_version,
            result_label,
            result.get_status_display(),
            result.confirmed_at.strftime("%Y-%m-%d %H:%M") if result.confirmed_at else "",
            result.confirmed_by.username if result.confirmed_by else "",
        ]
        decisions = list(result.decisions.select_related("singer").order_by("rank", "pk"))
        if not decisions:
            ws.append([*base, "", "", "", ""])
            continue
        for decision in decisions:
            ws.append(
                [
                    *base,
                    decision.singer.name if decision.singer else "",
                    decision.outcome_code,
                    decision.rank,
                    decision.score,
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
        .annotate(vote_count=valid_vote_count())
    )
    option_rows = list(options)
    prime_questionnaire_answers(option.singer for option in option_rows)
    for opt in option_rows:
        ws.append(
            [
                opt.vote_session.name,
                opt.singer.name,
                generic_song_label(opt.singer),
                # Added by the annotate() above; mypy's Django plugin sees it, pyright cannot.
                opt.vote_count,  # type: ignore[reportAttributeAccessIssue]
            ]
        )
    _autosize_sheet(ws)
    return wb


def _award_list_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Awards"
    ws.append(["Singer", "Song", "Award"])
    official_awards = official_stage_award_queryset(activity)
    awards = list(scope_runtime(official_awards, activity).select_related("singer"))
    prime_questionnaire_answers(award.singer for award in awards)
    for award in awards:
        ws.append([award.singer.name, generic_song_label(award.singer), award.name])
    _autosize_sheet(ws)
    return wb


INCIDENT_LIST_HEADERS: tuple[str, ...] = (
    "活动",
    "时间",
    "类型",
    "轮次",
    "选手",
    "节目",
    "authority 状态",
    "处理人",
    "问题",
    "采取动作",
    "处理结果",
    "备注",
    "需要赛后复盘",
)


def incident_list_rows(incidents: Any) -> list[tuple[Any, ...]]:
    """The GOAL §16 evidence for each incident, as spreadsheet rows.

    Both the staff export and the permanent archive sheet read this one function. They
    used to have separate column sets, and the archive — the copy that survives — kept
    the older, thinner one: it lost the authority state at the time, the problem, the
    action taken and whether the incident needed a post-event review, which is most of
    what §16 asks for. Sharing the builder is the only thing that keeps the two from
    drifting apart again.
    """
    return [
        (
            inc.activity.title,
            inc.occurred_at.strftime("%Y-%m-%d %H:%M"),
            inc.get_event_type_display(),
            inc.round.name if inc.round else "",
            inc.singer.name if inc.singer else "",
            inc.program.name if inc.program else "",
            inc.get_authority_state_display(),
            inc.handled_by.username if inc.handled_by else "",
            inc.problem,
            inc.action_taken,
            inc.resolution,
            inc.remark,
            "是" if inc.needs_review else "否",
        )
        for inc in incidents
    ]


def _incident_list_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Incidents"
    ws.append(list(INCIDENT_LIST_HEADERS))
    incidents = IncidentRecord.objects.filter(
        activity=activity, is_test=runtime_is_test(activity)
    ).select_related("activity", "round", "singer", "program", "handled_by")
    for row in incident_list_rows(incidents):
        ws.append(list(row))
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
    group_files = SubmissionFile.objects.filter(
        group__stage__activity=activity,
        group__stage__is_test_data=runtime_is_test(activity),
        is_test_data=runtime_is_test(activity),
    ).select_related("group", "group__stage", "uploaded_by")
    for f in group_files:
        ws.append(
            [
                "group",
                f"{f.group.stage.name} / {f.group.name}" if f.group else "",
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


def _group_chorus_workbook(activity: Activity) -> Workbook:
    """Export the Group Chorus structure, membership history and readiness."""
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Group Chorus"
    ws.append(
        [
            "Stage Key",
            "Stage",
            "Stage Status",
            "Group Order",
            "Group",
            "Active",
            "Current Members",
            "Material Readiness",
            "Current Files",
            "Membership History Rows",
        ]
    )
    stages = GroupStage.objects.filter(
        activity=activity,
        is_test_data=runtime_is_test(activity),
    ).prefetch_related("groups__memberships__singer", "groups__files")
    for stage in stages.order_by("stage_key", "pk"):
        for group in stage.groups.order_by("group_order", "pk"):
            members = list(current_group_members(group))
            files = list(group.files.filter(is_current=True).order_by("pk"))
            ws.append(
                [
                    stage.stage_key,
                    stage.name,
                    stage.get_status_display(),
                    group.group_order,
                    group.name,
                    "yes" if group.is_active else "no",
                    ", ".join(member.singer.name for member in members),
                    group_material_readiness(group).value,
                    ", ".join(file.original_name for file in files),
                    group.memberships.count(),
                ]
            )
    _autosize_sheet(ws)
    return wb


def _public_content_index_workbook(activity: Activity) -> Workbook:
    wb = Workbook()
    ws = _active_worksheet(wb)
    ws.title = "Public Content"
    ws.append(
        [
            "Title",
            "Type",
            "Editorial Status",
            "Result Release Status",
            "Result Version",
            "Result Released At",
            "Pinned",
            "Published At",
            "Updated By",
        ]
    )
    posts = PublicPost.objects.filter(related_activity=activity).select_related("updated_by")
    posts = posts.prefetch_related(
        "result_releases",
    )
    for post in posts:
        latest_release = next(iter(post.result_releases.all()), None)
        is_result = post.post_type == PublicPost.PostType.RESULT_PUBLICATION
        ws.append(
            [
                post.title,
                post.get_post_type_display(),
                post.get_status_display(),
                (
                    latest_release.get_status_display()
                    if is_result and latest_release
                    else ("未发布" if is_result else "")
                ),
                latest_release.result_version if is_result and latest_release else "",
                (
                    latest_release.released_at.strftime("%Y-%m-%d %H:%M")
                    if is_result and latest_release
                    else ""
                ),
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
        _xlsx("registration_list", _registration_archive_workbook(activity)),
        _xlsx("material_checklist", _material_checklist_workbook(activity)),
        _xlsx("program_list", _program_archive_workbook(activity)),
        _xlsx("score_results", _score_results_workbook(activity)),
        _xlsx("stage_results", _stage_results_workbook(activity)),
        _xlsx("vote_results", _vote_results_workbook(activity)),
        _xlsx("award_list", _award_list_workbook(activity)),
        _xlsx("incident_list", _incident_list_workbook(activity)),
        # No staff_notes. GOAL §19.2 forbids keeping 临时 Staff note permanently because
        # of archiving, and this ZIP is the permanent copy: `prune_retained_state` deletes
        # the database rows on the retention schedule while the workbook inside the
        # archive would have outlived them forever. The pre-event execution package
        # (`build_execution_package`) still carries them, which is where they belong.
        _xlsx("attachment_index", _attachment_index_workbook(activity)),
        _xlsx("group_chorus", _group_chorus_workbook(activity)),
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
    singers = prime_questionnaire_answers(
        scope_runtime(
            SingerRegistration.objects.filter(
                activity=activity,
                pre_status=SingerRegistration.PreStatus.APPROVED,
            ),
            activity,
        )
    )
    singer_lines = "\n".join(f"{s.name} — {generic_song_label(s)}" for s in singers)
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
    body = body.replace("{sign_off}", settings.ARTFLOW_ORGANIZATION_NAME or "ArtFlow 活动运营平台")
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

    # GOAL §8.4: a candidate is not a formal result. This package calls itself the
    # authoritative record, so it must not be frozen on a result line that is still
    # READY_TO_CONFIRM / REVIEW / HOLD / stale — otherwise the archive certifies an
    # outcome the system never confirmed, and unlock/confirm history ends up wrong.
    #
    # The check is the same closure the public release path uses rather than a local
    # "is there a CONFIRMED StageResult" test, because the local test misses a stale
    # candidate, an old ruleset version, a missing checkpoint, an unconfirmed upstream
    # and a fingerprint mismatch.
    #
    # The exemption is by activity *type*, not by blocker. Exempting every activity that
    # reports `no_current_frozen_ruleset` also exempts a singer contest that never froze
    # one, and a singer contest's formal outcome is defined as a confirmed stage result —
    # a contest with no frozen ruleset has no formal result at all, which is a reason to
    # refuse, not a reason to skip. A farewell show or a general activity has no
    # ruleset-driven result line, so the check does not apply to it.
    if locked_activity.activity_type == Activity.Type.SINGER_CONTEST:
        closure = build_result_closure(locked_activity)
        if not closure.closeable:
            reasons = "、".join(code.value for code in closure.blocking_reasons)
            raise PermissionDenied(f"正式结果尚未核定闭环（{reasons}），不能归档。")

    group_stages = GroupStage.objects.filter(
        activity=locked_activity,
        is_test_data=locked_activity.is_test_mode,
    ).prefetch_related("groups__memberships", "groups__files")
    for group_stage in group_stages:
        blocker = group_stage_archive_blocker(group_stage)
        if blocker:
            raise PermissionDenied(blocker)
        if group_stage.status == GroupStage.Status.CANCELLED:
            continue
        if not all(
            group_material_readiness(group).value == "ready"
            for group in group_stage.groups.filter(is_active=True)
        ):
            raise PermissionDenied(
                f"分组合唱赛段「{group_stage.name}」仍有组别材料未就绪，不能归档。"
            )

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
