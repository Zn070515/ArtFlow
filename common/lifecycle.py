from __future__ import annotations

from typing import TYPE_CHECKING, TypeVar

from django.db.models import Model, Q, QuerySet

if TYPE_CHECKING:
    from core.models import Activity

TEST_VALUE = "test"
FORMAL_VALUE = "formal"

MT = TypeVar("MT", bound=Model)


def runtime_is_test(activity: Activity) -> bool:
    return activity.data_lifecycle == activity.DataLifecycle.TEST


def scope_runtime(queryset: QuerySet[MT], activity: Activity) -> QuerySet[MT]:
    """Scope a queryset to rows whose test marker matches the activity lifecycle."""
    return queryset.filter(is_test_data=runtime_is_test(activity))


def scope_lifecycle(
    queryset: QuerySet[MT],
    activity_relation: str = "activity",
    marker: str = "is_test_data",
) -> QuerySet[MT]:
    """Scope a cross-activity queryset, binding each row to its own activity lifecycle.

    The invariant is that ``row.<marker>`` equals ``(row.<activity_relation>.data_lifecycle
    == TEST)``. When a view browses rows across activities of mixed lifecycle, a fixed marker
    filter would show stale or mismatched data; this keeps every visible row consistent with
    its parent activity.
    """
    return queryset.filter(
        Q(**{f"{activity_relation}__data_lifecycle": TEST_VALUE, marker: True})
        | Q(**{f"{activity_relation}__data_lifecycle": FORMAL_VALUE, marker: False})
    )
