"""The 2025 historical questionnaire, and the step that fills it from the private fixture.

Before the questionnaire existed the loader wrote every participant's round-one group song
into the single ``SingerRegistration.song_name`` column, because that column was the only
place a song could go. It is not any more: four rounds each have their own song and their
own accompaniment, and they exist at once. Writing through the questionnaire services is
also what makes the fixture a rehearsal of the real flow rather than a bypass of it — the
draft is created, the answers go in, the participant submits, staff approve.

The shape below follows the 2025 院十佳 historical form: basic identity, then each round's
song and accompaniment, plus the third round's guest singer.
"""

from __future__ import annotations

from django.core.exceptions import ValidationError

# Reference-row field -> question key. The reference fixture already distinguishes the four
# rounds' songs; before, the loader collapsed them into one column and lost the distinction.
REASON_FIELDS = (
    ("round1_group_song", "r1.song"),
    ("round2_song", "r2.song"),
    ("actual_round3_song", "r3.song"),
    ("r4_guest_song", "r3.guest_name"),
    ("actual_final_song_raw", "r4.song"),
)

ACCOMPANIMENT_QUESTIONS = (
    "r1.accompaniment",
    "r2.accompaniment",
    "r3.accompaniment",
    "r4.accompaniment",
)


def _file_question(key: str, round_key: str, label: str) -> dict:
    return {
        "key": key,
        "type": "file",
        "label": label,
        "round": round_key,
        "required": False,
        "file": {
            "purpose": "accompaniment",
            "extensions": [".mp3", ".wav"],
            "max_mb": 100,
            "max_files": 1,
        },
    }


def historical_2025_questionnaire() -> dict:
    """The 2025 院十佳 form as a questionnaire document."""
    return {
        "schema_version": 1,
        "key": "singer_submission",
        "pages": [
            {
                "key": "basic",
                "title": "基本信息",
                "sections": [
                    {
                        "key": "identity",
                        "title": "身份",
                        "questions": [
                            {
                                "key": "name",
                                "type": "text",
                                "label": "姓名",
                                "binding": "registration.name",
                            },
                            {
                                "key": "student_id",
                                "type": "text",
                                "label": "学号",
                                "binding": "registration.student_id",
                            },
                        ],
                    }
                ],
            },
            {
                "key": "rounds",
                "title": "各轮材料",
                "sections": [
                    {
                        "key": "round1",
                        "title": "第一轮｜分组演唱",
                        "questions": [
                            {
                                "key": "r1.song",
                                "type": "text",
                                "label": "第一轮曲目",
                                "round": "r1",
                            },
                            _file_question("r1.accompaniment", "r1", "第一轮伴奏"),
                        ],
                    },
                    {
                        "key": "round2",
                        "title": "第二轮｜个人演唱",
                        "questions": [
                            {
                                "key": "r2.song",
                                "type": "text",
                                "label": "第二轮曲目",
                                "round": "r2",
                            },
                            _file_question("r2.accompaniment", "r2", "第二轮伴奏"),
                        ],
                    },
                    {
                        "key": "round3",
                        "title": "第三轮｜十强合作",
                        "questions": [
                            {
                                "key": "r3.song",
                                "type": "text",
                                "label": "第三轮曲目",
                                "round": "r3",
                            },
                            {
                                "key": "r3.guest_name",
                                "type": "text",
                                "label": "帮帮唱嘉宾姓名",
                                "round": "r3",
                            },
                            _file_question("r3.accompaniment", "r3", "第三轮伴奏"),
                        ],
                    },
                    {
                        "key": "round4",
                        "title": "第四轮｜五强决赛",
                        "questions": [
                            {
                                "key": "r4.song",
                                "type": "text",
                                "label": "第四轮曲目",
                                "round": "r4",
                            },
                            _file_question("r4.accompaniment", "r4", "第四轮伴奏"),
                        ],
                    },
                ],
            },
        ],
    }


def answers_from_reference_row(row) -> dict:
    """The questionnaire answers a reference contestant row carries."""
    answers = {}
    for field, question_key in REASON_FIELDS:
        value = (row or {}).get(field)
        if isinstance(value, str) and value.strip():
            answers[question_key] = value.strip()
    return answers


def fill_registrations(
    *, version, registrations, reference_by_code, operator, approve=True
) -> dict:
    """Open, fill, submit and approve one registration per synthetic participant.

    Returns the questionnaire responses it created, keyed by contestant code. The
    registration is only marked APPROVED once it has actually been submitted: approving a
    draft would put somebody in the roster who never finished their form, which is the one
    thing the roster is supposed to mean.
    """
    from questionnaire.registration import get_or_create_draft_registration, submit_registration
    from singer_contest.models import SingerRegistration

    from .private_test_loader import PrivateTestLoadError

    responses: dict = {}
    for code, registration in registrations.items():
        row = reference_by_code.get(code)
        if row is None:
            raise PrivateTestLoadError(f"identity {code} is missing from reference fixture")
        _registration, response = get_or_create_draft_registration(
            version=version, user=registration.user
        )
        answers = answers_from_reference_row(row)
        if not answers:
            raise PrivateTestLoadError(f"reference row for {code} carries no questionnaire answers")
        response = submit_registration(
            version=version,
            registration=registration,
            answers=answers,
            due_rounds=frozenset({"r1", "r2", "r3", "r4"}),
        )
        if approve:
            registration.pre_status = SingerRegistration.PreStatus.APPROVED
            registration.save(update_fields=["pre_status", "updated_at"])
        responses[code] = response
    return responses


def check_answers_landed(*, responses, registrations) -> None:
    """Every participant's four songs must be readable through the questionnaire.

    The point of the migration is that four rounds coexist, so the check is that all four
    are present — not that one of them is.
    """
    from questionnaire.registration import questionnaire_plan
    from questionnaire.runtime import resolve_question_value

    for code, response in responses.items():
        registration = registrations[code]
        plan = questionnaire_plan(response.ruleset_version)
        answers = response.answers or {}
        for question_key in ("r1.song", "r2.song", "r3.song", "r4.song"):
            question = plan.question(question_key)
            if question is None:
                continue
            value = resolve_question_value(question, answers=answers, registration=registration)
            if not value:
                raise ValidationError(f"{code}: {question_key} 未写入问卷")
