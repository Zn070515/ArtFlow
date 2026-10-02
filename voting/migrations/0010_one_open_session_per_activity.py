from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):
    dependencies = [
        ("voting", "0009_alter_votesession_purpose_votescoringrule"),
    ]

    operations = [
        migrations.AddConstraint(
            model_name="votesession",
            constraint=models.UniqueConstraint(
                condition=Q(is_open=True),
                fields=("activity",),
                name="vote_one_open_session_per_activity",
            ),
        ),
    ]
