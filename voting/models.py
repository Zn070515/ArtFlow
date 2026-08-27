from django.core.exceptions import ValidationError
from django.db import models


class VoteSession(models.Model):
    class SelectionType(models.TextChoices):
        SINGLE = "single", "单选"
        MULTI = "multi", "多选"

    activity = models.ForeignKey(
        "core.Activity", on_delete=models.CASCADE, related_name="vote_sessions"
    )
    name = models.CharField(max_length=100)
    passcode = models.CharField(max_length=20)
    start_time = models.DateTimeField()
    end_time = models.DateTimeField()
    is_open = models.BooleanField(default=False)
    is_locked = models.BooleanField(default=False)
    is_test_data = models.BooleanField(default=False)
    selection_type = models.CharField(
        max_length=8, choices=SelectionType, default=SelectionType.SINGLE
    )
    max_selections = models.IntegerField(default=1)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.name


class VoteBallot(models.Model):
    vote_session = models.ForeignKey(VoteSession, on_delete=models.CASCADE, related_name="ballots")
    browser_session_key = models.CharField(max_length=64)
    ip_address = models.GenericIPAddressField()
    is_test_data = models.BooleanField(default=False)
    submitted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["vote_session", "browser_session_key"],
                name="voting_one_ballot_per_browser_session",
            )
        ]


class VoteOption(models.Model):
    vote_session = models.ForeignKey(VoteSession, on_delete=models.CASCADE, related_name="options")
    singer = models.ForeignKey(
        "singer_contest.SingerRegistration", on_delete=models.CASCADE, related_name="vote_options"
    )
    sort_order = models.IntegerField(default=0)
    is_test_data = models.BooleanField(default=False)

    class Meta:
        unique_together = [("vote_session", "singer")]
        ordering = ["sort_order", "pk"]

    def clean(self):
        if self.vote_session_id and self.singer_id:
            if self.singer.activity_id != self.vote_session.activity_id:
                raise ValidationError("Vote option singer must belong to the vote activity.")

    def save(self, *args, **kwargs):
        self.clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.vote_session.name} — {self.singer.name}"


class VoteRecord(models.Model):
    ballot = models.ForeignKey(
        VoteBallot,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="choices",
    )
    vote_session = models.ForeignKey(VoteSession, on_delete=models.CASCADE, related_name="records")
    vote_option = models.ForeignKey(VoteOption, on_delete=models.CASCADE, related_name="records")
    browser_session_key = models.CharField(max_length=64)
    ip_address = models.GenericIPAddressField()
    is_test_data = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("vote_session", "browser_session_key", "vote_option")]
        constraints = [
            models.UniqueConstraint(
                fields=["ballot", "vote_option"],
                condition=models.Q(ballot__isnull=False),
                name="voting_one_choice_per_ballot_option",
            )
        ]

    def __str__(self):
        return f"{self.browser_session_key} → {self.vote_option.singer.name}"
