"""
Optional LLM-backed NLP path for the live Customer Portal only.

Kept as a separate module (not folded into agents/nlp_agent.py) so Pipeline A
(backend/pipeline.py::run_case, which imports analyze_transcript from
nlp_agent) never imports `anthropic` or reads USE_LLM_NLP — it structurally
cannot reach this code path. Only backend/customer_pipeline.py (the live
customer-submission scorer) calls into this module.

Gated behind USE_LLM_NLP=1 and a present ANTHROPIC_API_KEY; off by default so
the demo stays fully offline. Any failure (missing package, missing key,
network error, malformed response) returns None rather than raising, so the
caller can fall back to the existing regex-based agents.nlp_agent.analyze_conversation
automatically and visibly (see customer_pipeline.py's nlp_engine marker).
"""
import json
import os

MODEL = "claude-sonnet-5"

SYSTEM_PROMPT = (
    "You are a fraud-review assistant analyzing a customer's return-request chat "
    "transcript. Assess how trustworthy the customer's stated reason is. "
    "Respond with STRICT JSON only, no other text, matching exactly this schema: "
    '{"customer_trust_score": <integer 0-100, 100=fully trustworthy>, '
    '"flags": [<short human-readable strings describing any contradiction, '
    "abusive language, manipulation tactic, or copy-paste-sounding excuse you "
    'noticed; empty list if none>]}'
)


def analyze_conversation_llm(turns: list, customer_excuse_history_count: int = 0) -> dict | None:
    if os.environ.get("USE_LLM_NLP") != "1":
        return None
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic

        client = anthropic.Anthropic()
        transcript = "\n".join(turns)
        user_prompt = (
            f"Customer prior excuse-history count: {customer_excuse_history_count}\n\n"
            f"Transcript:\n{transcript}"
        )
        response = client.messages.create(
            model=MODEL,
            max_tokens=400,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        text = response.content[0].text
        parsed = json.loads(text)
        score = int(parsed["customer_trust_score"])
        flags = list(parsed.get("flags", []))
        return {"customer_trust_score": max(0, min(100, score)), "flags": flags}
    except Exception as err:
        print(f"USE_LLM_NLP path failed, falling back to regex NLP agent: {err}")
        return None
