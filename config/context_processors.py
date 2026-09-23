from django.conf import settings


def artflow_branding(_request):
    return {
        "artflow_organization_name": settings.ARTFLOW_ORGANIZATION_NAME,
    }
