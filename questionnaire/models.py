"""Persistence for questionnaire answers (§P3).

A response is scoped to the registration it answers for **and** to the FROZEN ruleset
version it was filled against. The version is part of the identity because the
questionnaire is part of that version's authority: an answer given under v1 is not an
answer under v2, and a successor version carries answers forward by ``question_key``
deliberately (§P9), not by letting one row serve both.

``answers`` holds only the *unbound* answers. Identity fields bound to the registration
and files bound to a ``question_key`` are read from where they already live, so there is
never a second copy to keep in step.

Not part of the V1 model, by design: a scoring link. Answers never feed the resolver —
``ruleset`` and ``questionnaire`` are compiled together at freeze and stay independent
everywhere else.
"""

from typing import TYPE_CHECKING

from django.db import models


class QuestionnaireResponse(models.Model):
    class Subject(models.TextChoices):
        PARTICIPANT = "participant", "选手"
        GROUP = "group", "分组合唱组"

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        SUBMITTED = "submitted", "已提交"

    singer_registration = models.ForeignKey(
        "singer_contest.SingerRegistration",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="questionnaire_responses",
    )
    group = models.ForeignKey(
        "singer_contest.Group",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="questionnaire_responses",
    )
    ruleset_version = models.ForeignKey(
        "ruleset.RulesetVersion",
        on_delete=models.CASCADE,
        related_name="questionnaire_responses",
    )
    questionnaire_key = models.CharField(max_length=64)
    subject = models.CharField(max_length=16, choices=Subject.choices, default=Subject.PARTICIPANT)
    # The questionnaire's identity when the response was written, so a browser holding an
    # older form can be told to refresh instead of overwriting answers it cannot see.
    schema_hash = models.CharField(max_length=64, blank=True)
    answers = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=16, choices=Status, default=Status.DRAFT)
    is_test_data = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    submitted_at = models.DateTimeField(null=True, blank=True)

    if TYPE_CHECKING:
        # Django creates the ``<fk>_id`` shadow attribute at runtime; declare it here so
        # Pylance can see it (see AGENTS.md, Pylance & Pyright Type Checking).
        singer_registration_id: int | None
        ruleset_version_id: int
        group_id: int | None

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["singer_registration", "ruleset_version", "questionnaire_key"],
                condition=models.Q(singer_registration__isnull=False),
                name="questionnaire_one_response_per_registration_version",
            ),
            models.UniqueConstraint(
                fields=["group", "ruleset_version", "questionnaire_key"],
                condition=models.Q(group__isnull=False),
                name="questionnaire_one_response_per_group_version",
            ),
            models.CheckConstraint(
                condition=(
                    (
                        models.Q(subject="participant")
                        & models.Q(singer_registration__isnull=False)
                        & models.Q(group__isnull=True)
                    )
                    | (
                        models.Q(subject="group")
                        & models.Q(singer_registration__isnull=True)
                        & models.Q(group__isnull=False)
                    )
                ),
                name="questionnaire_subject_owner_xor",
            ),
        ]

    def __str__(self):
        owner = self.singer_registration or self.group
        return f"{owner} · {self.questionnaire_key} · {self.ruleset_version}"
