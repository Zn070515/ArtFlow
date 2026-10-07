"""Align historical FORMAL Singer Contest vote sessions with GOAL §9.4.

``requires_ticket`` arrived as ``AddField(default=False)`` with no backfill, so a formal
Singer Contest session created before that field existed kept ``requires_ticket=False``
and went on using its stored passcode. GOAL §9.4 makes the formal Singer Contest session
ticket-backed and keeps a passcode only as legacy compatibility, and
``VoteSession.save()`` already forces ``requires_ticket=True`` for such a row — the
history simply never caught up with the invariant. This migration states it for the rows
that already exist: every session of a FORMAL Singer Contest activity becomes
ticket-backed, and the now-inert passcode is cleared so the session carries no standing
credential that no longer has a code path.

It is deliberately narrow: only ``activity_type="singer_contest"`` +
``data_lifecycle="formal"`` rows are touched, which is exactly the predicate
``voting.models._formal_singer_contest_activity`` uses.
"""

from django.db import migrations

FORMAL_SINGER_CONTEST = {"activity_type": "singer_contest", "data_lifecycle": "formal"}


def backfill_requires_ticket(apps, schema_editor):
    VoteSession = apps.get_model("voting", "VoteSession")
    lookup = {f"activity__{field}": value for field, value in FORMAL_SINGER_CONTEST.items()}
    VoteSession.objects.filter(**lookup).update(requires_ticket=True, passcode="")


def noop(apps, schema_editor):
    """Nothing to undo: re-clearing ``requires_ticket`` would re-open the passcode path."""


class Migration(migrations.Migration):
    dependencies = [("voting", "0013_legacy_record_browser_uniqueness_requires_no_ballot")]

    operations = [migrations.RunPython(backfill_requires_ticket, noop)]
