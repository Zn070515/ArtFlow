from django.test import SimpleTestCase

import common.business_rules
import common.lifecycle


class DeadCodeRetirementTests(SimpleTestCase):
    def test_retired_vote_lock_helper_is_not_public(self):
        self.assertFalse(hasattr(common.business_rules, "ensure_vote_session_unlocked"))

    def test_retired_runtime_performance_helper_is_not_public(self):
        self.assertFalse(hasattr(common.lifecycle, "runtime_performances"))
