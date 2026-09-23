from django.conf import settings
from django.http import HttpRequest


def artflow_branding(_request: HttpRequest) -> dict[str, str]:
    return {
        "artflow_organization_name": settings.ARTFLOW_ORGANIZATION_NAME,
    }
