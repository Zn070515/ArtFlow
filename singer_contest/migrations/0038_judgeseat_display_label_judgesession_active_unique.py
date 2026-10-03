from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):
    dependencies = [("singer_contest", "0037_remove_singerregistration_singer_one_registration_per_student_per_activity_and_more")]

    operations = [
        migrations.AddField(
            model_name="judgeseat",
            name="display_label",
            field=models.CharField(blank=True, max_length=100),
        ),
        migrations.AddConstraint(
            model_name="judgesession",
            constraint=models.UniqueConstraint(
                condition=Q(state="active"),
                fields=("seat",),
                name="judge_session_one_active_per_seat",
            ),
        ),
    ]
