from django.urls import path

from . import judge_views

app_name = "judge"

urlpatterns = [
    path("context/", judge_views.judge_context, name="context"),
    path("score/", judge_views.judge_score, name="score"),
]
