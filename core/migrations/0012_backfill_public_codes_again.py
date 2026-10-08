"""State the public-code backfill on a migration name no database has applied yet.

0006 added ``public_code`` nullable and backfilled it; 0008 tightened it to NOT NULL; then
0011 was edited (681700e) to carry a backfill of its own. Some databases had already
recorded 0011 as applied by then, and Django applies a migration by *name* — so the newly
added step never ran there, and any activity row that predates the field can still carry
NULL or an empty string. Both are broken activities rather than missing niceties: every
public entry URL (`/e/<code>/...`), the ticket QR and the judge entry are built from the
code.

The backfill itself lives in ``core.models`` so it can be exercised directly by a test;
this migration only calls it. Idempotent: it touches rows that have no usable code and
nothing else.
"""

from django.db import migrations

from core.models import backfill_missing_activity_public_codes


def backfill_public_codes(apps, schema_editor):
    Activity = apps.get_model("core", "Activity")
    backfill_missing_activity_public_codes(Activity, using=schema_editor.connection.alias)


def noop(apps, schema_editor):
    """Nothing to undo: re-nulling a code would re-break the activity's public URLs."""


class Migration(migrations.Migration):
    dependencies = [("core", "0011_activity_public_code_not_null")]

    operations = [migrations.RunPython(backfill_public_codes, noop)]
