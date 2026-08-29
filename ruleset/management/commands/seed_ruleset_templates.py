from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from ruleset.models import RulesetTemplate
from ruleset.templates import seed_ruleset_templates


class Command(BaseCommand):
    help = "Seed the ruleset template library (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--frozen", action="store_true", help="Mark seeded templates FROZEN."
        )

    def handle(self, *args, **options):
        operator = get_user_model().objects.filter(is_active=True).order_by("pk").first()
        status = (
            RulesetTemplate.Status.FROZEN if options["frozen"] else RulesetTemplate.Status.DRAFT
        )
        count = seed_ruleset_templates(operator, status=status)
        self.stdout.write(self.style.SUCCESS(f"seeded {count} ruleset templates"))
