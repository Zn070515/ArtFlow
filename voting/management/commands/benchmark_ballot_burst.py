"""Burst benchmark for ballot submission (P1-8).

The vote path is intentionally serialized: ``submit_ballot`` takes the Activity
authority lock, then the VoteSession row lock, then the ticket locks, so N
audience members voting at once queue behind the same rows. That protocol is
correctness machinery and must not be rewritten on a hunch. This command exists
to produce the evidence instead:

* it drives the *real* service entry point (``submit_ballot``) from N threads,
* it reports throughput, success/error counts and p50/p95/p99 latency,
* it samples PostgreSQL connection, lock and deadlock state during the run,
* it re-checks that each accepted ballot produced exactly one ballot row and one
  record per selection, so a "fast" run that lost votes is visible rather than
  impressive.

It only writes through the sanctioned services, refuses to touch a non-test
activity, and tags every row it creates as test data.
"""

from __future__ import annotations

import json
import random
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from accounts.models import User
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import connections
from django.utils import timezone
from tickets.services import check_in_ticket, issue_ticket_batch, redeem_ticket

from voting.models import VoteBallot, VoteOption, VoteRecord, VoteSession
from voting.services import submit_ballot

MISSING_OPERATOR = (
    "No active staff or admin operator found. Pass --operator <username>, or "
    "create an administrator with the seed_dev_admin command."
)
MONITOR_INTERVAL_SECONDS = 0.25


@dataclass
class ClientResult:
    index: int
    ok: bool
    latency_ms: float
    reason: str = ""


@dataclass
class DatabaseObservations:
    active_connections: list[int] = field(default_factory=list)
    blocked_locks: list[int] = field(default_factory=list)
    deadlocks_before: int | None = None
    deadlocks_after: int | None = None
    transactions_before: int | None = None
    transactions_after: int | None = None

    @property
    def peak_active_connections(self) -> int:
        return max(self.active_connections) if self.active_connections else 0

    @property
    def peak_blocked_locks(self) -> int:
        return max(self.blocked_locks) if self.blocked_locks else 0

    @property
    def deadlocks(self) -> int | None:
        if self.deadlocks_before is None or self.deadlocks_after is None:
            return None
        return self.deadlocks_after - self.deadlocks_before

    @property
    def transactions(self) -> int | None:
        if self.transactions_before is None or self.transactions_after is None:
            return None
        return self.transactions_after - self.transactions_before


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1)))))
    return ordered[index]


class Command(BaseCommand):
    help = "Measure ballot-submission burst behaviour against the current database."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--vote-session", type=int, required=True)
        parser.add_argument("--clients", type=int, default=100)
        parser.add_argument(
            "--duration",
            type=float,
            default=5.0,
            help="Seconds over which the clients release their single ballot.",
        )
        parser.add_argument("--seed", type=int, default=20260101)
        parser.add_argument(
            "--operator",
            default="",
            help="Staff or admin username used to build the ticket fixture.",
        )
        parser.add_argument(
            "--allow-sqlite",
            action="store_true",
            help="Run anyway on SQLite. Row-lock waits there are not representative.",
        )
        parser.add_argument("--json", action="store_true", dest="as_json")

    def handle(self, *args: Any, **options: Any) -> None:
        clients = options["clients"]
        duration = options["duration"]
        if clients < 1:
            raise CommandError("--clients must be at least 1.")
        if duration <= 0:
            raise CommandError("--duration must be positive.")
        if connections["default"].vendor != "postgresql" and not options["allow_sqlite"]:
            raise CommandError(
                "Ballot lock contention is only meaningful on PostgreSQL. "
                "Pass --allow-sqlite to measure something else."
            )

        vote_session = self._vote_session(options["vote_session"])
        operator = self._operator(options["operator"])
        option_ids = list(
            VoteOption.objects.filter(vote_session=vote_session)
            .order_by("pk")
            .values_list("pk", flat=True)
        )
        if not option_ids:
            raise CommandError("The vote session has no options to vote for.")
        self._assert_session_open(vote_session)

        fixture_started = time.perf_counter()
        voter_keys, ticket_sessions = self._prepare_voters(vote_session, clients, operator)
        fixture_seconds = time.perf_counter() - fixture_started

        randomized = random.Random(options["seed"])
        offsets = [randomized.random() * duration for _ in range(clients)]
        ballots_before = VoteBallot.objects.filter(vote_session=vote_session).count()
        records_before = VoteRecord.objects.filter(vote_session=vote_session).count()

        observations = DatabaseObservations()
        stop_monitor = threading.Event()
        monitor = threading.Thread(
            target=self._monitor_database, args=(observations, stop_monitor), daemon=True
        )
        monitor.start()

        results: list[ClientResult] = []
        results_lock = threading.Lock()
        started_at = time.perf_counter()

        def run_client(index: int) -> None:
            try:
                time.sleep(offsets[index])
                result = self._submit_one(
                    vote_session,
                    browser_session_key=voter_keys[index],
                    ticket_session=ticket_sessions[index] if ticket_sessions else None,
                    option_id=option_ids[index % len(option_ids)],
                    index=index,
                )
                with results_lock:
                    results.append(result)
            finally:
                # Each thread holds its own database connection; leaving it open
                # keeps a SQLite test database locked and leaks a pooled
                # PostgreSQL slot for the rest of the process.
                connections.close_all()

        threads = [
            threading.Thread(target=run_client, args=(index,), daemon=True)
            for index in range(clients)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        wall_seconds = time.perf_counter() - started_at
        stop_monitor.set()
        monitor.join(timeout=5)

        self._report(
            vote_session=vote_session,
            clients=clients,
            duration=duration,
            fixture_seconds=fixture_seconds,
            wall_seconds=wall_seconds,
            ballots_delta=self._count_delta(VoteBallot, vote_session, ballots_before),
            records_delta=self._count_delta(VoteRecord, vote_session, records_before),
            results=results,
            observations=observations,
            as_json=options["as_json"],
        )

    # -- fixture ---------------------------------------------------------

    def _vote_session(self, pk: int) -> VoteSession:
        vote_session = VoteSession.objects.select_related("activity").filter(pk=pk).first()
        if vote_session is None:
            raise CommandError(f"VoteSession {pk} does not exist.")
        if not vote_session.activity.is_test_mode:
            raise CommandError(
                "Refusing to benchmark a non-test activity: a burst benchmark writes "
                "real ballots. Use an activity with is_test_mode=True."
            )
        return vote_session

    def _operator(self, username: str) -> User:
        if username:
            operator = User.objects.filter(username=username).first()
            if operator is None:
                raise CommandError(f"No such user: {username}")
            return operator
        operator = (
            User.objects.filter(role=User.Role.ADMIN, is_active=True).order_by("pk").first()
            or User.objects.filter(role=User.Role.STAFF, is_active=True).order_by("pk").first()
        )
        if operator is None:
            raise CommandError(MISSING_OPERATOR)
        return operator

    def _prepare_voters(
        self, vote_session: VoteSession, clients: int, operator: User
    ) -> tuple[list[str], list[Any]]:
        """One voter per client: a browser key, plus a ticket session when required."""
        run_token = uuid4().hex[:6].upper()
        key_prefix = f"benchmark-ballot-{vote_session.pk}-{run_token}"
        voter_keys = [f"{key_prefix}-{index:04d}" for index in range(clients)]
        if not vote_session.requires_ticket:
            return voter_keys, []

        issued: list[Any] = []
        remaining = clients
        batch = 1
        while remaining > 0:
            quantity = min(remaining, 100)
            issued.extend(
                issue_ticket_batch(
                    vote_session.activity,
                    actor=operator,
                    quantity=quantity,
                    batch_reference=f"benchmark-ballot-{vote_session.pk}-{run_token}",
                    serial_prefix=f"B{run_token}{batch:02d}",
                )
            )
            remaining -= quantity
            batch += 1
        for item in issued:
            check_in_ticket(item.secret, actor=operator)
        return voter_keys, [redeem_ticket(item.secret).session for item in issued]

    def _assert_session_open(self, vote_session: VoteSession) -> None:
        now = timezone.now()
        if not vote_session.is_open or vote_session.is_locked:
            raise CommandError("Open the vote session before benchmarking it.")
        if now < vote_session.start_time or now > vote_session.end_time:
            raise CommandError("The vote window is not currently open.")

    # -- burst -----------------------------------------------------------

    def _submit_one(
        self,
        vote_session: VoteSession,
        *,
        browser_session_key: str,
        ticket_session: Any,
        option_id: int,
        index: int,
    ) -> ClientResult:
        started_at = time.perf_counter()
        try:
            submit_ballot(
                vote_session,
                browser_session_key=browser_session_key,
                option_ids=[option_id],
                ip_address=f"10.251.{index % 250}.{(index % 250) + 1}",
                ticket_session=ticket_session,
            )
        except ValidationError as error:
            return ClientResult(
                index=index,
                ok=False,
                latency_ms=(time.perf_counter() - started_at) * 1000,
                reason=";".join(error.messages)[:200] or "ValidationError",
            )
        except Exception as error:  # the benchmark must classify every failure
            return ClientResult(
                index=index,
                ok=False,
                latency_ms=(time.perf_counter() - started_at) * 1000,
                reason=f"{type(error).__name__}: {error}"[:200],
            )
        return ClientResult(
            index=index, ok=True, latency_ms=(time.perf_counter() - started_at) * 1000
        )

    # -- database observations ------------------------------------------

    def _monitor_database(self, observations: DatabaseObservations, stop: threading.Event) -> None:
        is_postgresql = connections["default"].vendor == "postgresql"
        try:
            self._record_counters(observations, phase="before")
            while not stop.wait(MONITOR_INTERVAL_SECONDS):
                if not is_postgresql:
                    continue
                with connections["default"].cursor() as cursor:
                    cursor.execute(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE datname = current_database() AND state IS NOT NULL"
                    )
                    observations.active_connections.append(int(cursor.fetchone()[0]))
                    cursor.execute("SELECT count(*) FROM pg_locks WHERE NOT granted")
                    observations.blocked_locks.append(int(cursor.fetchone()[0]))
        except Exception as error:  # observation must never fail the measured run
            self.stderr.write(f"Database observation stopped early: {type(error).__name__}")
        finally:
            try:
                self._record_counters(observations, phase="after")
            except Exception:
                pass
            connections.close_all()

    def _record_counters(self, observations: DatabaseObservations, *, phase: str) -> None:
        if connections["default"].vendor != "postgresql":
            return
        with connections["default"].cursor() as cursor:
            cursor.execute(
                "SELECT deadlocks, xact_commit FROM pg_stat_database "
                "WHERE datname = current_database()"
            )
            row = cursor.fetchone()
        if row is None:
            return
        if phase == "before":
            observations.deadlocks_before = int(row[0])
            observations.transactions_before = int(row[1])
        else:
            observations.deadlocks_after = int(row[0])
            observations.transactions_after = int(row[1])

    @staticmethod
    def _count_delta(model: Any, vote_session: VoteSession, before: int) -> int:
        return model.objects.filter(vote_session=vote_session).count() - before

    # -- reporting -------------------------------------------------------

    def _report(
        self,
        *,
        vote_session: VoteSession,
        clients: int,
        duration: float,
        fixture_seconds: float,
        wall_seconds: float,
        ballots_delta: int,
        records_delta: int,
        results: list[ClientResult],
        observations: DatabaseObservations,
        as_json: bool,
    ) -> None:
        successful = [result for result in results if result.ok]
        failures = [result for result in results if not result.ok]
        latencies = [result.latency_ms for result in successful]
        reason_counts: dict[str, int] = {}
        for result in failures:
            reason_counts[result.reason] = reason_counts.get(result.reason, 0) + 1

        summary: dict[str, Any] = {
            "vote_session": vote_session.pk,
            "clients": clients,
            "duration_s": duration,
            "fixture_s": round(fixture_seconds, 3),
            "wall_s": round(wall_seconds, 3),
            "ballots_attempted": len(results),
            "ballots_succeeded": len(successful),
            "ballots_failed": len(failures),
            "failure_reasons": reason_counts,
            "throughput_per_s": round(len(successful) / wall_seconds, 2) if wall_seconds else 0.0,
            "p50_ms": round(_percentile(latencies, 0.5), 2),
            "p95_ms": round(_percentile(latencies, 0.95), 2),
            "p99_ms": round(_percentile(latencies, 0.99), 2),
            "max_ms": round(max(latencies), 2) if latencies else 0.0,
            "new_ballots": ballots_delta,
            "new_vote_records": records_delta,
            "duplicate_ballots_detected": ballots_delta > len(successful),
            "lost_ballots_detected": ballots_delta < len(successful),
            "orphan_vote_records_detected": records_delta != ballots_delta,
            "peak_active_connections": observations.peak_active_connections,
            "peak_blocked_locks": observations.peak_blocked_locks,
            "deadlocks": observations.deadlocks,
            "transactions": observations.transactions,
        }

        if as_json:
            self.stdout.write(json.dumps(summary, ensure_ascii=False, indent=2))
        else:
            self.stdout.write(f"Vote session: {vote_session.pk}")
            self.stdout.write(
                f"Clients: {clients} over {duration}s "
                f"(fixture {summary['fixture_s']}s, burst {summary['wall_s']}s)"
            )
            self.stdout.write(
                f"Ballots: {len(successful)} ok / {len(failures)} failed "
                f"({summary['throughput_per_s']}/s)"
            )
            for reason, count in sorted(reason_counts.items(), key=lambda item: -item[1]):
                self.stdout.write(f"  {count:>4}  {reason}")
            self.stdout.write(
                f"Latency ms: p50 {summary['p50_ms']} p95 {summary['p95_ms']} "
                f"p99 {summary['p99_ms']} max {summary['max_ms']}"
            )
            self.stdout.write(
                f"Rows: +{ballots_delta} ballots, +{records_delta} records | "
                f"peak connections {summary['peak_active_connections']}, "
                f"peak blocked locks {summary['peak_blocked_locks']}, "
                f"deadlocks {summary['deadlocks']}, "
                f"transactions {summary['transactions']}"
            )

        if summary["lost_ballots_detected"]:
            self.stderr.write("Silent vote loss: fewer ballot rows than accepted submissions.")
        if summary["duplicate_ballots_detected"]:
            self.stderr.write("Duplicate ballot rows detected for accepted submissions.")
        if summary["orphan_vote_records_detected"]:
            self.stderr.write("Vote records do not match accepted ballots.")
        if observations.deadlocks:
            self.stderr.write("Deadlocks were reported during the burst.")
