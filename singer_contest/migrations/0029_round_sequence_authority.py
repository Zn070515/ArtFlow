from django.db import migrations, models


def repair_round_sequences(apps, schema_editor):
    ContestRound = apps.get_model("singer_contest", "ContestRound")
    activity_ids = ContestRound.objects.values_list("activity_id", flat=True).distinct()
    for activity_id in activity_ids:
        rounds = list(
            ContestRound.objects.filter(activity_id=activity_id).order_by("sequence", "pk")
        )
        for sequence, contest_round in enumerate(rounds, start=1):
            if contest_round.sequence != sequence:
                ContestRound.objects.filter(pk=contest_round.pk).update(sequence=sequence)


class Migration(migrations.Migration):
    # The data step in this migration's operations writes rows in the same table that
    # the constraints below ALTER, all inside one transaction. PostgreSQL runs foreign
    # keys as DEFERRABLE INITIALLY DEFERRED triggers, so those writes leave pending
    # trigger events and the ALTER TABLE is refused ("cannot ALTER TABLE ... because it
    # has pending trigger events"). A fresh database has no rows for the data step to
    # touch, which is why CI passes while upgrading a populated database fails — and
    # these data steps exist precisely to normalise pre-existing production rows.
    # Running non-atomically lets the data step commit before the constraint is added.
    # Same failure mode and same fix as ruleset/migrations/0011.
    atomic = False
    dependencies = [("singer_contest", "0028_contestround_tie_order_policy")]

    operations = [
        migrations.RunPython(repair_round_sequences, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="contestround",
            constraint=models.UniqueConstraint(
                fields=("activity", "sequence"), name="round_unique_sequence_per_activity"
            ),
        ),
    ]
