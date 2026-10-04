from django.urls import path

from .consumers import JudgeContextConsumer, StaffActivityConsumer

websocket_urlpatterns = [
    path(
        "ws/staff/activity/<int:activity_id>/",
        StaffActivityConsumer.as_asgi(),
        name="staff_activity",
    ),
    path("ws/judge/", JudgeContextConsumer.as_asgi(), name="judge_context"),
]
