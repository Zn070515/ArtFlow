from django.urls import path

from .consumers import GroupMaterialConsumer, JudgeContextConsumer, StaffActivityConsumer

# channels' URLRouter accepts an ASGI application here, but Django's path() is typed for a
# view callable, so these two diagnostics are a stub gap rather than a routing mistake.
websocket_urlpatterns = [
    path(  # pyright: ignore[reportCallIssue]
        "ws/staff/activity/<int:activity_id>/",
        StaffActivityConsumer.as_asgi(),  # pyright: ignore[reportArgumentType]
        name="staff_activity",
    ),
    path("ws/judge/", JudgeContextConsumer.as_asgi(), name="judge_context"),  # pyright: ignore[reportCallIssue, reportArgumentType]
    path(  # pyright: ignore[reportCallIssue]
        "ws/group/<int:group_id>/materials/",
        GroupMaterialConsumer.as_asgi(),  # pyright: ignore[reportArgumentType]
        name="group_material",
    ),
]
