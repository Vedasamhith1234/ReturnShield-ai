import unittest

from agents.nlp_agent import analyze_conversation, assess_customer_intent


class IntentAssessmentTests(unittest.TestCase):
    def test_genuine_intent_is_marked_real(self):
        result = assess_customer_intent("I received a damaged item and would like a refund for the order.")
        self.assertTrue(result["is_real_intent"])
        self.assertEqual(result["intent_label"], "likely_genuine")

    def test_hostile_and_urgent_messages_are_flagged(self):
        result = assess_customer_intent(
            "The item never arrived even though it says delivered. Refund me right now or I will report you."
        )
        self.assertFalse(result["is_real_intent"])
        self.assertEqual(result["intent_label"], "high_risk")
        self.assertTrue(any("Contradiction" in flag for flag in result["flags"]))


class ConversationAnalysisTests(unittest.TestCase):
    def test_consistent_story_is_not_flagged(self):
        result = analyze_conversation([
            "My AirPods stopped working after a week.",
            "They just stopped connecting to my phone, no water or drop damage.",
        ])
        self.assertEqual(result["customer_trust_score"], 100)
        self.assertEqual(result["flags"], [])

    def test_story_changing_between_turns_is_flagged(self):
        result = analyze_conversation([
            "The package never arrived, tracking is wrong.",
            "Actually it arrived but the item inside was damaged.",
        ])
        self.assertLess(result["customer_trust_score"], 100)
        self.assertTrue(any("Story changed between messages" in flag for flag in result["flags"]))

    def test_vague_reply_to_followup_is_a_soft_penalty_only(self):
        result = analyze_conversation([
            "The item arrived damaged.",
            "idk",
        ])
        self.assertEqual(result["customer_trust_score"], 92)
        self.assertTrue(any("short or non-committal" in flag for flag in result["flags"]))

    def test_opening_short_message_is_not_penalized_as_vague(self):
        result = analyze_conversation(["It broke."])
        self.assertEqual(result["customer_trust_score"], 100)


if __name__ == "__main__":
    unittest.main()
