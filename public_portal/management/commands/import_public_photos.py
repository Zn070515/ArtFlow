from pathlib import Path

from django.core.files import File
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from public_portal.models import PublicMedia, PublicPost

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
INTERNAL_FOLDERS = {"会议照片"}
PUBLISH_HELP = (
    "Publish imported public posts immediately. Internal folders stay draft unless "
    + "--include-internal is set."
)


class Command(BaseCommand):
    help = "Import folders of public activity photos into PublicPost/PublicMedia."

    def add_arguments(self, parser):
        parser.add_argument(
            "source_dir", help="Directory containing one subfolder per activity/gallery."
        )
        parser.add_argument(
            "--publish",
            action="store_true",
            help=PUBLISH_HELP,
        )
        parser.add_argument(
            "--include-internal",
            action="store_true",
            help="Import internal-looking folders such as meeting photos.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        source_dir = Path(options["source_dir"]).expanduser().resolve()
        if not source_dir.exists() or not source_dir.is_dir():
            raise CommandError(f"Source directory does not exist: {source_dir}")

        imported_posts = 0
        imported_media = 0
        skipped_media = 0

        for folder in sorted([p for p in source_dir.iterdir() if p.is_dir()], key=lambda p: p.name):
            is_internal = folder.name in INTERNAL_FOLDERS
            if is_internal and not options["include_internal"]:
                self.stdout.write(f"Skipping internal folder: {folder.name}")
                continue

            image_paths = [
                p
                for p in sorted(folder.rglob("*"), key=lambda p: p.name)
                if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
            ]
            if not image_paths:
                continue

            status = (
                PublicPost.Status.PUBLISHED
                if options["publish"] and not is_internal
                else PublicPost.Status.DRAFT
            )
            post, created = PublicPost.objects.get_or_create(
                title=folder.name,
                post_type=PublicPost.PostType.SHOWCASE,
                defaults={
                    "subtitle": f"{folder.name} 活动照片",
                    "content": f"{folder.name} 活动照片集。",
                    "status": status,
                    "published_at": timezone.now()
                    if status == PublicPost.Status.PUBLISHED
                    else None,
                },
            )
            if created:
                imported_posts += 1
            elif (
                options["publish"]
                and not is_internal
                and post.status != PublicPost.Status.PUBLISHED
            ):
                post.status = PublicPost.Status.PUBLISHED
                post.published_at = post.published_at or timezone.now()
                post.save(update_fields=["status", "published_at", "updated_at"])

            for index, image_path in enumerate(image_paths):
                source_path = str(image_path)
                if PublicMedia.objects.filter(source_path=source_path).exists():
                    skipped_media += 1
                    continue

                media = PublicMedia(
                    post=post,
                    caption=folder.name,
                    original_name=image_path.name,
                    source_path=source_path,
                    is_published=True,
                    sort_order=index,
                )
                with image_path.open("rb") as image_file:
                    media.image.save(image_path.name, File(image_file), save=True)
                imported_media += 1

                if index == 0 and not post.cover_image:
                    with image_path.open("rb") as image_file:
                        post.cover_image.save(image_path.name, File(image_file), save=True)

        summary = (
            f"Imported {imported_media} media item(s), {imported_posts} post(s); "
            + f"skipped {skipped_media} existing item(s)."
        )
        self.stdout.write(self.style.SUCCESS(summary))
