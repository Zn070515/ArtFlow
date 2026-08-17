import os

from django.core.checks import Error, Tags, register
from django.core.exceptions import ImproperlyConfigured

from config.runtime import get_app_env, validate_production_environment


@register(Tags.security)
def production_config_check(app_configs=None, **kwargs):
    if get_app_env() != "production":
        return []

    try:
        validate_production_environment(os.environ)
    except ImproperlyConfigured as error:
        return [
            Error(
                "Production environment configuration is invalid.",
                hint=str(error),
                id="config.E001",
            )
        ]
    return []
