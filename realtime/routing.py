from django.urls import path

from .consumers import StaffActivityConsumer

websocket_urlpatterns = [
    path(
        "ws/staff/activity/<int:activity_id>/",
        StaffActivityConsumer.as_asgi(),
        name="staff_activity",
    ),
]
