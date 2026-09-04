from typing import cast

from core.models import Activity
from django import forms
from django.http import QueryDict
from farewell_show.models import Program
from incidents.models import IncidentRecord
from public_portal.models import PublicPost
from ruleset.schema import parse_definition
from singer_contest.models import ContestRound, ScoringRubric, SingerRegistration
from voting.models import VoteSession

# Accepts both browser `datetime-local` values (naive ISO) and tz-aware ISO strings
# such as `timezone.now().isoformat()`.
DATETIME_INPUT_FORMATS = [
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M%z",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
]


# Phases a brand-new activity may be created in. LIVE, the results phases and
# ARCHIVED are deliberate: they can only be reached by advancing through the
# lifetime (or the archive flow), never by directly creating an activity there.
_NON_CREATEABLE_PHASES = frozenset(
    {
        Activity.Phase.LIVE,
        Activity.Phase.RESULTS_PENDING,
        Activity.Phase.RESULTS_PUBLISHED,
        Activity.Phase.ARCHIVED,
    }
)
CREATE_PHASE_CHOICES = [
    choice for choice in Activity.Phase.choices if choice[0] not in _NON_CREATEABLE_PHASES
]


class ActivityForm(forms.Form):
    title = forms.CharField(max_length=200)
    subtitle = forms.CharField(max_length=400, required=False)
    activity_type = forms.ChoiceField(choices=Activity.Type.choices)
    phase = forms.ChoiceField(choices=Activity.Phase.choices)
    description = forms.CharField(required=False)

    def __init__(self, *args, include_lifecycle=False, phase_choices=None, **kwargs):
        super().__init__(*args, **kwargs)
        if include_lifecycle:
            self.fields["is_test_mode"] = forms.BooleanField(required=False)
        if phase_choices is not None:
            cast(forms.ChoiceField, self.fields["phase"]).choices = phase_choices


class ContestRoundForm(forms.Form):
    name = forms.CharField(max_length=100, required=False)
    round_type = forms.ChoiceField(choices=ContestRound.RoundType.choices)
    scoring_mode = forms.ChoiceField(
        choices=ContestRound.ScoringMode.choices,
        required=False,
        initial=ContestRound.ScoringMode.AVERAGE,
    )
    advance_count = forms.IntegerField(min_value=0, required=False, initial=0)
    sequence = forms.IntegerField(min_value=1, required=False, initial=1)
    order_policy = forms.ChoiceField(
        choices=ContestRound.OrderPolicy.choices,
        required=False,
        initial=ContestRound.OrderPolicy.REGISTRATION_ORDER,
    )
    tie_order_policy = forms.ChoiceField(
        choices=ContestRound.TieOrderPolicy.choices,
        required=False,
        initial=ContestRound.TieOrderPolicy.REVIEW,
    )
    roster_source = forms.ChoiceField(
        choices=[("", "自动判定"), *ContestRound.RosterSource.choices],
        required=False,
        initial="",
    )
    roster_source_stage = forms.CharField(max_length=100, required=False)
    rubric = forms.ModelChoiceField(queryset=ScoringRubric.objects.none(), required=False)

    def __init__(self, *args, rubrics=None, **kwargs):
        super().__init__(*args, **kwargs)
        if rubrics is not None:
            cast(forms.ModelChoiceField, self.fields["rubric"]).queryset = rubrics

    def clean_advance_count(self):
        return self.cleaned_data.get("advance_count") or 0

    def clean_scoring_mode(self):
        return self.cleaned_data.get("scoring_mode") or ContestRound.ScoringMode.AVERAGE

    def clean_sequence(self):
        return self.cleaned_data.get("sequence") or 1

    def clean_order_policy(self):
        return self.cleaned_data.get("order_policy") or ContestRound.OrderPolicy.REGISTRATION_ORDER

    def clean_tie_order_policy(self):
        return self.cleaned_data.get("tie_order_policy") or ContestRound.TieOrderPolicy.REVIEW

    def clean_roster_source(self):
        return self.cleaned_data.get("roster_source") or ""

    def clean_roster_source_stage(self):
        stage = (self.cleaned_data.get("roster_source_stage") or "").strip()
        source = self.cleaned_data.get("roster_source") or ""
        if source == ContestRound.RosterSource.STAGE and not stage:
            raise forms.ValidationError("赛段晋级轮次必须声明上游赛段。")
        return stage

    def clean_rubric(self):
        return self.cleaned_data.get("rubric") or None


class RoundRunningOrderForm(forms.Form):
    singer_ids = forms.CharField(
        label="出场顺序",
        help_text="按顺序填写选手 ID，以逗号、空格或换行分隔。",
        widget=forms.Textarea(attrs={"rows": 4}),
    )

    def clean_singer_ids(self):
        raw = self.cleaned_data["singer_ids"]
        return [item for item in raw.replace(",", " ").split() if item]


class RoundGroupsForm(forms.Form):
    groups = forms.JSONField(
        label="分组定义",
        help_text='JSON 示例：[{"name":"A组","singer_ids":["1","2"]}]',
        widget=forms.Textarea(attrs={"rows": 8}),
    )


class ScoringRubricProvisionForm(forms.Form):
    name = forms.CharField(max_length=100)
    description = forms.CharField(required=False, widget=forms.Textarea(attrs={"rows": 3}))
    criteria = forms.JSONField(
        label="评分项",
        help_text='JSON 示例：[{"name":"音准","max_score":40},{"name":"表现","max_score":60}]',
        widget=forms.Textarea(attrs={"rows": 8}),
    )


class ManualDecisionForm(forms.Form):
    manual_key = forms.ChoiceField(label="人工节点")
    group = forms.CharField(max_length=100, required=False, initial="")
    chosen = forms.MultipleChoiceField(
        label="选择选手", required=False, widget=forms.CheckboxSelectMultiple
    )

    def __init__(self, *args, version, activity, **kwargs):
        super().__init__(*args, **kwargs)
        definition = parse_definition(version.definition)
        manual_keys = [
            (node["key"], node["key"])
            for node in definition["nodes"]
            if node["type"] == "MANUAL_SELECT"
        ]
        cast(forms.ChoiceField, self.fields["manual_key"]).choices = manual_keys
        cast(forms.MultipleChoiceField, self.fields["chosen"]).choices = [
            (str(singer.pk), f"{singer.pk} — {singer.name}")
            for singer in SingerRegistration.objects.filter(activity=activity).order_by("pk")
        ]


class SingerReviewForm(forms.Form):
    pre_status = forms.ChoiceField(choices=SingerRegistration.PreStatus.choices)
    live_status = forms.ChoiceField(choices=SingerRegistration.LiveStatus.choices)
    staff_note = forms.CharField(max_length=1000, required=False)


class ProgramReviewForm(forms.Form):
    status = forms.ChoiceField(choices=Program.Status.choices)
    sort_order = forms.IntegerField(required=False, initial=0)
    staff_note = forms.CharField(max_length=1000, required=False)

    def clean_sort_order(self):
        return self.cleaned_data.get("sort_order") or 0


class PublicPostForm(forms.Form):
    title = forms.CharField(max_length=200)
    subtitle = forms.CharField(max_length=400, required=False)
    content = forms.CharField(required=False)
    post_type = forms.ChoiceField(choices=PublicPost.PostType.choices)
    status = forms.ChoiceField(choices=PublicPost.Status.choices)
    is_pinned = forms.BooleanField(required=False)
    sort_order = forms.IntegerField(required=False, initial=0)
    related_activity_id = forms.IntegerField(required=False)
    # Client snapshot version for stale-edit detection. Absent/None means the
    # form came from a legacy client (or a create) and is passed through; a
    # non-matching value rejects the save as outdated.
    base_version = forms.IntegerField(required=False)

    def clean_sort_order(self):
        return self.cleaned_data.get("sort_order") or 0


class IncidentForm(forms.Form):
    occurred_at = forms.DateTimeField(input_formats=DATETIME_INPUT_FORMATS)
    event_type = forms.ChoiceField(choices=IncidentRecord.EventType.choices)
    resolution = forms.CharField(required=False)
    remark = forms.CharField(required=False)


class VoteSessionForm(forms.Form):
    name = forms.CharField(max_length=100)
    passcode = forms.CharField(max_length=20)
    start_time = forms.DateTimeField(input_formats=DATETIME_INPUT_FORMATS)
    end_time = forms.DateTimeField(input_formats=DATETIME_INPUT_FORMATS)
    selection_type = forms.ChoiceField(
        choices=VoteSession.SelectionType.choices,
        required=False,
        initial=VoteSession.SelectionType.SINGLE,
    )
    max_selections = forms.IntegerField(min_value=1, required=False, initial=1)
    purpose = forms.ChoiceField(
        choices=VoteSession.Purpose.choices,
        required=False,
        initial=VoteSession.Purpose.SELECTION,
    )

    def _posted_singer_ids(self):
        data = cast(QueryDict, self.data)
        return [value for value in data.getlist("singers") if value]

    def clean(self):
        cleaned = super().clean()
        if cleaned is None:
            cleaned = {}
        selection_type = cleaned.get("selection_type") or VoteSession.SelectionType.SINGLE
        max_selections = cleaned.get("max_selections") or 1
        purpose = cleaned.get("purpose") or VoteSession.Purpose.SELECTION
        singer_ids = self._posted_singer_ids()
        if not singer_ids:
            raise forms.ValidationError("请至少选择一个候选选手。")
        if selection_type == VoteSession.SelectionType.MULTI and max_selections > len(singer_ids):
            raise forms.ValidationError("多选可选项数不能超过候选选手数量。")
        if cleaned.get("start_time") and cleaned.get("end_time"):
            if cleaned["end_time"] <= cleaned["start_time"]:
                raise forms.ValidationError("结束时间必须晚于开始时间。")
        cleaned["selection_type"] = selection_type
        cleaned["max_selections"] = max_selections
        cleaned["purpose"] = purpose
        return cleaned
