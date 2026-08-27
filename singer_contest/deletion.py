from django.db.models.deletion import CASCADE, ProtectedError


def cascade_draft_snapshots_or_protect_prepared(collector, field, sub_objs, using):
    protected = sub_objs.exclude(round__status="draft")
    if protected.exists():
        raise ProtectedError(
            "Cannot delete a parent referenced by a prepared round snapshot.",
            protected,
        )
    CASCADE(collector, field, sub_objs, using)
