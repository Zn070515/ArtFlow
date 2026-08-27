import os
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.files import File
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from public_portal.models import PublicMedia, PublicPost

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
INTERNAL_FOLDERS = {"会议照片"}
PHOTO_IMPORT_ROOT_NAME = "public_photo_imports"
PUBLISH_HELP = (
    "Publish imported public posts immediately. Internal folders stay draft unless "
    + "--include-internal is set."
)


class Command(BaseCommand):
    help = "Import folders of public activity photos into PublicPost/PublicMedia."

    def add_arguments(self, parser: Any) -> None:
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
    def handle(self, *args: Any, **options: Any) -> None:
        import_root = Path(os.path.realpath(Path(settings.MEDIA_ROOT) / PHOTO_IMPORT_ROOT_NAME))
        source_dir = Path(os.path.realpath(Path(options["source_dir"]).expanduser()))
        if source_dir == import_root or not source_dir.is_relative_to(import_root):
            raise CommandError(f"Source directory must be inside {import_root}.")
        if not source_dir.exists() or not source_dir.is_dir():
            raise CommandError(f"Source directory does not exist: {source_dir}")

        imported_posts = 0
        imported_media = 0
        skipped_media = 0

        folders = []
        for candidate_folder in source_dir.iterdir():
            folder = self.resolve_descendant(
                candidate_folder,
                import_root=import_root,
                source_dir=source_dir,
            )
            if folder is not None and folder.is_dir():
                folders.append((candidate_folder.name, folder))

        for folder_name, folder in sorted(folders, key=lambda item: item[0]):
            is_internal = folder_name in INTERNAL_FOLDERS
            if is_internal and not options["include_internal"]:
                self.stdout.write(f"Skipping internal folder: {folder_name}")
                continue

            image_paths = self.find_image_paths(folder, import_root, source_dir)
            if not image_paths:
                continue

            status = (
                PublicPost.Status.PUBLISHED
                if options["publish"] and not is_internal
                else PublicPost.Status.DRAFT
            )
            post, created = PublicPost.objects.get_or_create(
                title=folder_name,
                post_type=PublicPost.PostType.SHOWCASE,
                defaults={
                    "subtitle": f"{folder_name} 活动照片",
                    "content": f"{folder_name} 活动照片集。",
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
                    caption=folder_name,
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

    def find_image_paths(self, folder: Path, import_root: Path, source_dir: Path) -> list[Path]:
        image_paths = []
        pending_folders = [folder]
        visited_folders = set()

        while pending_folders:
            current_folder = pending_folders.pop()
            if current_folder in visited_folders:
                continue
            visited_folders.add(current_folder)

            try:
                candidates = current_folder.iterdir()
                for candidate in candidates:
                    path = self.resolve_descendant(
                        candidate,
                        import_root=import_root,
                        source_dir=source_dir,
                    )
                    if path is None:
                        continue
                    if path.is_dir():
                        pending_folders.append(path)
                    elif path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
                        image_paths.append(path)
            except OSError as error:
                self.stdout.write(f"Skipping unreadable folder: {current_folder} ({error})")

        return sorted(image_paths, key=lambda path: path.name)

    def resolve_descendant(
        self, candidate: Path, *, import_root: Path, source_dir: Path
    ) -> Path | None:
        try:
            resolved_candidate = candidate.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            self.stdout.write(f"Skipping unresolved path: {candidate} ({error})")
            return None

        if not (
            resolved_candidate.is_relative_to(import_root)
            and resolved_candidate.is_relative_to(source_dir)
        ):
            self.stdout.write(f"Skipping path outside import source: {candidate}")
            return None

        return resolved_candidate
