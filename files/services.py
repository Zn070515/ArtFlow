from .models import MaterialCheck, MaterialRequirement, SubmissionFile


DEFAULT_SINGER_REQUIREMENTS = [
    ("基本信息", ""),
    ("联系方式", ""),
    ("伴奏文件", SubmissionFile.Purpose.ACCOMPANIMENT),
]

DEFAULT_PROGRAM_REQUIREMENTS = [
    ("基本信息", ""),
    ("负责人联系方式", ""),
    ("伴奏文件", SubmissionFile.Purpose.ACCOMPANIMENT),
]


def sync_singer_material_checks(registration):
    requirements = _requirements_for(
        registration.activity,
        MaterialRequirement.AppliesTo.SINGER,
        DEFAULT_SINGER_REQUIREMENTS,
    )
    return _sync_checks(registration=registration, requirements=requirements)


def sync_program_material_checks(program):
    requirements = _requirements_for(
        program.activity,
        MaterialRequirement.AppliesTo.PROGRAM,
        DEFAULT_PROGRAM_REQUIREMENTS,
    )
    return _sync_checks(program=program, requirements=requirements)


def _requirements_for(activity, applies_to, fallback):
    configured = list(
        MaterialRequirement.objects.filter(activity=activity, applies_to=applies_to)
        .values_list("item_name", "file_purpose")
    )
    return configured or fallback


def _sync_checks(registration=None, program=None, requirements=None):
    owner_filter = {"singer_registration": registration} if registration else {"program": program}
    file_queryset = SubmissionFile.objects.filter(**owner_filter)
    checks = []
    for index, (item_name, file_purpose) in enumerate(requirements or []):
        if file_purpose:
            status = (
                MaterialCheck.Status.UPLOADED
                if file_queryset.filter(file_purpose=file_purpose).exists()
                else MaterialCheck.Status.MISSING
            )
        else:
            status = MaterialCheck.Status.REVIEWED
        check, _ = MaterialCheck.objects.update_or_create(
            item_name=item_name,
            defaults={"status": status, "sort_order": index},
            **owner_filter,
        )
        checks.append(check)
    return checks
