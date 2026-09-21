"""Characterization tests for the M1-B generic contest fact model.

The roadmap (§7.11) requires the DB to be able to *express* a structure like the
2025 院十佳: 15 singers, 4 final rounds, multiple performance groups, a per-round
song per singer, a guest on R3, a distinct rubric per round, and per-round
material slots. M1-B introduces the fact tables that make that expressible; these
tests pin the schema-level contracts so M1-C/M1-E cannot silently regress them.

Note: no 2025 fixture data is in the repo (§6.5 / §3.14), so these tests construct
*representative* rows to prove expressibility — they never hardcode real 2025 values.
"""

from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from farewell_show.models import Program
from files.models import MaterialSlot
from singer_contest.models import (
    ContestRound,
    CriterionScore,
    Judge,
    Performance,
    PerformanceGroup,
    RubricCriterion,
    ScoreRecord,
    ScoringRubric,
)

from common.test_characterization import _CharacterizationBase


class ContestRoundGenericSchemaCharacterizationTests(_CharacterizationBase):
    """§7.3 — an activity can express any number of rounds; sequence is ordering."""

    def test_activity_can_hold_multiple_rounds_of_same_type(self):
        activity = self.make_activity()
        for i in range(1, 5):
            contest_round = self.make_round(activity, round_type=ContestRound.RoundType.SEMI_FINAL)
            contest_round.sequence = i
            contest_round.save(update_fields=["sequence"])
        sequences = list(
            ContestRound.objects.filter(activity=activity)
            .order_by("sequence")
            .values_list("sequence", flat=True)
        )
        self.assertEqual(sequences, [1, 2, 3, 4])

    def test_round_sequence_defaults_to_one(self):
        activity = self.make_activity()
        contest_round = self.make_round(activity)
        self.assertEqual(contest_round.sequence, 1)

    def test_round_binds_a_rubric_scheduled_venue(self):
        activity = self.make_activity()
        rubric = ScoringRubric.objects.create(activity=activity, name="Final Rubric")
        contest_round = self.make_round(activity)
        contest_round.rubric = rubric
        contest_round.scheduled_at = None
        contest_round.venue = "Center"
        contest_round.save(update_fields=["rubric", "venue"])
        self.assertEqual(contest_round.rubric_id, rubric.pk)
        self.assertEqual(contest_round.venue, "Center")


class PerformanceFactModelCharacterizationTests(_CharacterizationBase):
    """§7.5 / §7.6 — a performance is a per-round fact, grouped optionally."""

    def make_group(self, activity, contest_round, name="G1"):
        return PerformanceGroup.objects.create(activity=activity, round=contest_round, name=name)

    def test_group_must_belong_to_round_activity(self):
        activity = self.make_activity()
        other = self.make_activity()
        contest_round = self.make_round(activity)
        with self.assertRaises(ValidationError):
            PerformanceGroup.objects.create(activity=other, round=contest_round, name="G1")

    def test_performance_singer_must_belong_to_round_activity(self):
        activity = self.make_activity()
        other = self.make_activity()
        contest_round = self.make_round(activity)
        other_singer = self.make_singer(other, username="s2", student_id="2")
        with self.assertRaises(ValidationError):
            Performance.objects.create(
                activity=activity, round=contest_round, singer=other_singer, song_title="Song"
            )

    def test_performance_group_must_match_round(self):
        activity = self.make_activity()
        round_a = self.make_round(activity)
        round_b = self.make_round(activity, round_type=ContestRound.RoundType.SEMI_FINAL)
        singer = self.make_singer(activity, username="s1", student_id="1")
        group_a = self.make_group(activity, round_a, "G1")
        with self.assertRaises(ValidationError):
            Performance.objects.create(
                activity=activity, round=round_b, singer=singer, group=group_a, song_title="Song"
            )

    def test_singer_can_have_one_song_per_round(self):
        activity = self.make_activity()
        singer = self.make_singer(activity, username="s1", student_id="1")
        rounds = []
        for i in range(1, 5):
            contest_round = self.make_round(activity, round_type=ContestRound.RoundType.SEMI_FINAL)
            contest_round.sequence = i
            contest_round.save(update_fields=["sequence"])
            rounds.append(contest_round)
        for i, contest_round in enumerate(rounds, 1):
            Performance.objects.create(
                activity=activity,
                round=contest_round,
                singer=singer,
                song_title=f"Song{i}",
                sequence=i,
            )
        self.assertEqual(Performance.objects.filter(activity=activity, singer=singer).count(), 4)

    def test_one_performance_per_round_per_singer_rejected(self):
        activity = self.make_activity()
        contest_round = self.make_round(activity)
        singer = self.make_singer(activity, username="s1", student_id="1")
        Performance.objects.create(
            activity=activity, round=contest_round, singer=singer, song_title="A"
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Performance.objects.create(
                    activity=activity, round=contest_round, singer=singer, song_title="B"
                )


class RubricCharacterizationTests(_CharacterizationBase):
    """§7.7 — a round binds its own rubric; criteria require a positive max."""

    def test_round_binds_its_own_rubric(self):
        activity = self.make_activity()
        round_a = self.make_round(activity)
        round_b = self.make_round(activity, round_type=ContestRound.RoundType.SEMI_FINAL)
        rubric_a = ScoringRubric.objects.create(activity=activity, name="R1 Rubric", sequence=1)
        rubric_b = ScoringRubric.objects.create(activity=activity, name="R2 Rubric", sequence=2)
        round_a.rubric = rubric_a
        round_a.save(update_fields=["rubric"])
        round_b.rubric = rubric_b
        round_b.save(update_fields=["rubric"])
        self.assertNotEqual(round_a.rubric_id, round_b.rubric_id)
        self.assertEqual(round_a.rubric_id, rubric_a.pk)

    def test_criterion_requires_positive_max_score(self):
        activity = self.make_activity()
        rubric = ScoringRubric.objects.create(activity=activity, name="Rubric")
        with self.assertRaises(ValidationError):
            RubricCriterion.objects.create(rubric=rubric, name="Tone", max_score=Decimal("0"))

    def test_criterion_unique_name_per_rubric(self):
        activity = self.make_activity()
        rubric = ScoringRubric.objects.create(activity=activity, name="Rubric")
        RubricCriterion.objects.create(rubric=rubric, name="Tone", max_score=Decimal("10"))
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                RubricCriterion.objects.create(rubric=rubric, name="Tone", max_score=Decimal("20"))


class CriterionScoreCharacterizationTests(_CharacterizationBase):
    """§7.8 — criterion-level scores must use the round's bound rubric."""

    def make_record(self, activity, contest_round, *, singer=None, judge=None):
        singer = singer or self.make_singer(activity, username="cs-s", student_id="css")
        judge = judge or Judge.objects.create(activity=activity, name="CS Judge")
        return ScoreRecord.objects.create(
            round=contest_round, singer=singer, judge=judge, score=Decimal("90")
        )

    def bind_rubric(self, contest_round, rubric):
        contest_round.rubric = rubric
        contest_round.save(update_fields=["rubric"])
        return contest_round

    def test_criterion_must_use_round_rubric(self):
        activity = self.make_activity()
        rubric_a = ScoringRubric.objects.create(activity=activity, name="RA")
        rubric_b = ScoringRubric.objects.create(activity=activity, name="RB")
        criterion_a = RubricCriterion.objects.create(
            rubric=rubric_a, name="Tone", max_score=Decimal("10")
        )
        criterion_b = RubricCriterion.objects.create(
            rubric=rubric_b, name="Lyrics", max_score=Decimal("10")
        )
        contest_round = self.bind_rubric(self.make_round(activity), rubric_a)
        record = self.make_record(activity, contest_round)
        # criterion_a is valid; criterion_b comes from a different rubric.
        CriterionScore.objects.create(
            score_record=record, criterion=criterion_a, value=Decimal("8")
        )
        with self.assertRaises(ValidationError):
            CriterionScore.objects.create(
                score_record=record, criterion=criterion_b, value=Decimal("8")
            )

    def test_criterion_score_value_non_negative(self):
        activity = self.make_activity()
        rubric = ScoringRubric.objects.create(activity=activity, name="RA")
        criterion = RubricCriterion.objects.create(
            rubric=rubric, name="Tone", max_score=Decimal("10")
        )
        contest_round = self.bind_rubric(self.make_round(activity), rubric)
        record = self.make_record(activity, contest_round)
        with self.assertRaises(ValidationError):
            CriterionScore.objects.create(
                score_record=record, criterion=criterion, value=Decimal("-1")
            )

    def test_criterion_score_unique_per_record(self):
        activity = self.make_activity()
        rubric = ScoringRubric.objects.create(activity=activity, name="RA")
        criterion = RubricCriterion.objects.create(
            rubric=rubric, name="Tone", max_score=Decimal("10")
        )
        contest_round = self.bind_rubric(self.make_round(activity), rubric)
        record = self.make_record(activity, contest_round)
        CriterionScore.objects.create(score_record=record, criterion=criterion, value=Decimal("8"))
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                CriterionScore.objects.create(
                    score_record=record, criterion=criterion, value=Decimal("9")
                )


class MaterialSlotCharacterizationTests(_CharacterizationBase):
    """§7.9 — a round-scoped material slot expresses per-round requirements."""

    def test_round_scoped_accompaniment_slots_expressible(self):
        activity = self.make_activity()
        rounds = []
        for i in range(1, 5):
            contest_round = self.make_round(activity)
            contest_round.sequence = i
            contest_round.save(update_fields=["sequence"])
            rounds.append(contest_round)
        for i, contest_round in enumerate(rounds, 1):
            MaterialSlot.objects.create(
                activity=activity,
                round=contest_round,
                category=MaterialSlot.Category.ACCOMPANIMENT,
                label=f"R{i} 伴奏",
                sequence=i,
            )
        self.assertEqual(MaterialSlot.objects.filter(activity=activity).count(), 4)
        labels = set(MaterialSlot.objects.filter(activity=activity).values_list("label", flat=True))
        self.assertEqual(labels, {"R1 伴奏", "R2 伴奏", "R3 伴奏", "R4 伴奏"})

    def test_slot_round_must_belong_to_activity(self):
        activity = self.make_activity()
        other = self.make_activity()
        contest_round = self.make_round(other)
        with self.assertRaises(ValidationError):
            MaterialSlot.objects.create(
                activity=activity,
                round=contest_round,
                category=MaterialSlot.Category.ACCOMPANIMENT,
                label="伴奏",
            )

    def test_slot_singer_must_belong_to_activity(self):
        activity = self.make_activity()
        other = self.make_activity()
        other_singer = self.make_singer(other, username="s2", student_id="2")
        with self.assertRaises(ValidationError):
            MaterialSlot.objects.create(
                activity=activity,
                singer_registration=other_singer,
                category=MaterialSlot.Category.ACCOMPANIMENT,
                label="伴奏",
            )

    def test_slot_cannot_have_both_singer_and_program(self):
        activity = self.make_activity()
        singer = self.make_singer(activity, username="s1", student_id="1")
        program = Program.objects.create(
            activity=activity,
            user=self.make_user("p-user"),
            name="P",
            program_type=Program.ProgramType.SONG,
            contact_name="C",
            contact_phone="13800000000",
            class_name="CS",
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                MaterialSlot.objects.create(
                    activity=activity,
                    singer_registration=singer,
                    program=program,
                    category=MaterialSlot.Category.ACCOMPANIMENT,
                    label="伴奏",
                )
