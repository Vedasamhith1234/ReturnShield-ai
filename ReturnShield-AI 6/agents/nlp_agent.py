"""
Agent 2 — NLP Agent
Analyzes customer support chat transcripts for contradictions, abusive language,
copy-paste excuse templates, and emotional-manipulation tactics.
Output: Customer Trust Score (0-100, higher = more trustworthy)

Note: this reference implementation uses transparent lexicon/rule heuristics so
it runs fully offline. In production, swap `analyze_transcript` to call an LLM
(e.g. the Anthropic Messages API) with a structured-output prompt for far higher
accuracy on contradiction and manipulation detection — the interface below is
already shaped for that swap.
"""
import re

ABUSIVE_PATTERNS = [
    r"\bridiculous\b", r"\breport you\b", r"\bscam\b", r"\bmanager immediately\b",
    r"\bsue\b", r"\bstupid\b", r"\bidiot\b",
]

MANIPULATION_PATTERNS = [
    r"\bright now\b", r"\bimmediately\b", r"\bi will report\b", r"\bmy lawyer\b",
    r"\bnever again\b", r"\bworst company\b",
]

NON_ARRIVAL_CLAIM = re.compile(r"\bnever (arrived|received|got it)\b", re.IGNORECASE)
DELIVERED_MENTION = re.compile(r"\bdelivered\b", re.IGNORECASE)

KNOWN_COPY_PASTE_TEMPLATES = [
    "the product broke after one use and i want a refund immediately",
    "this item never arrived even though it says delivered",
    "the box was empty when i opened it please refund me now",
]


def detect_contradiction(transcript: str) -> bool:
    """Detects the classic 'never arrived' vs 'tracking shows delivered' contradiction."""
    return bool(NON_ARRIVAL_CLAIM.search(transcript) and DELIVERED_MENTION.search(transcript))


def detect_abusive_language(transcript: str) -> list:
    hits = []
    lower = transcript.lower()
    for pattern in ABUSIVE_PATTERNS:
        if re.search(pattern, lower):
            hits.append(pattern.strip(r"\b"))
    return hits


def detect_manipulation(transcript: str) -> list:
    hits = []
    lower = transcript.lower()
    for pattern in MANIPULATION_PATTERNS:
        if re.search(pattern, lower):
            hits.append(pattern.strip(r"\b"))
    return hits


def detect_copy_paste(transcript: str) -> bool:
    lower = transcript.lower()
    return any(template in lower for template in KNOWN_COPY_PASTE_TEMPLATES)


def analyze_transcript(transcript: str, customer_excuse_history_count: int = 0) -> dict:
    trust_score = 100
    flags = []

    if detect_contradiction(transcript):
        trust_score -= 35
        flags.append("Contradiction detected: claims non-arrival while tracking shows delivered")

    abusive = detect_abusive_language(transcript)
    if abusive:
        trust_score -= 10 * len(abusive)
        flags.append(f"Abusive/hostile language detected ({len(abusive)} instance(s))")

    manipulation = detect_manipulation(transcript)
    if manipulation:
        trust_score -= 8 * len(manipulation)
        flags.append(f"Emotional-manipulation / urgency-pressure language detected ({len(manipulation)} instance(s))")

    if detect_copy_paste(transcript):
        trust_score -= 15
        flags.append("Copy-paste excuse template matched across prior tickets")

    if customer_excuse_history_count >= 5:
        trust_score -= 15
        flags.append(f"Same excuse pattern reused {customer_excuse_history_count} times historically")

    trust_score = max(0, min(100, trust_score))
    return {"customer_trust_score": trust_score, "flags": flags}


CLAIM_BUCKET_PATTERNS = {
    "never_arrived": re.compile(r"\bnever (arrived|received|got it)\b|\bdid ?n't (arrive|receive)\b", re.IGNORECASE),
    "damaged": re.compile(r"\bdamaged?\b|\bbroken\b|\bcracked\b|\bshattered\b", re.IGNORECASE),
    "wrong_item": re.compile(r"\bwrong (item|product|size|color)\b|\bnot what i ordered\b", re.IGNORECASE),
    "changed_mind": re.compile(r"\bchanged my mind\b|\bdon't (want|need) it (any ?more)\b|\bno longer (want|need)\b", re.IGNORECASE),
}

VAGUE_DODGE_PHRASES = ["idk", "i don't know", "whatever", "just refund me", "doesn't matter", "who cares"]


def classify_claim(text: str):
    """Buckets a single chat turn by which kind of return claim it makes, or
    None if it doesn't match a known claim — used to catch a customer's story
    changing between turns (see analyze_conversation)."""
    for bucket, pattern in CLAIM_BUCKET_PATTERNS.items():
        if pattern.search(text):
            return bucket
    return None


def is_vague_reply(text: str) -> bool:
    """Soft signal by design: a single terse reply is normal customer
    behavior, not evidence of anything — see analyze_conversation."""
    trimmed = text.strip()
    if not trimmed:
        return False
    lower = trimmed.lower()
    if any(phrase in lower for phrase in VAGUE_DODGE_PHRASES):
        return True
    word_count = len(trimmed.split())
    return 0 < word_count < 3


def analyze_conversation(turns: list, customer_excuse_history_count: int = 0) -> dict:
    """Scores a full multi-turn customer conversation (JS mirror:
    dashboard/app.js::analyzeConversationIntent). Reuses analyze_transcript
    for everything a joined transcript can catch, then adds two checks only a
    real turn-by-turn transcript makes possible: a story that changes between
    turns, and terse/dodging non-answers to a direct question. Both are
    capped/low-weight — soft signals that nudge the score, not decisive on
    their own."""
    base = analyze_transcript("\n".join(turns), customer_excuse_history_count)
    trust_score = base["customer_trust_score"]
    flags = list(base["flags"])

    buckets = {b for b in (classify_claim(t) for t in turns) if b}
    if len(buckets) >= 2:
        trust_score -= 25
        flags.append(f"Story changed between messages — asserted {' and '.join(sorted(buckets))} as separate claims")

    # Skip the opening message: an open-ended first reply is often short
    # ("it broke") and that alone shouldn't read as dodging.
    if any(is_vague_reply(t) for t in turns[1:]):
        trust_score -= 8
        flags.append("Gave a very short or non-committal answer to a direct question")

    trust_score = max(0, min(100, trust_score))
    return {"customer_trust_score": trust_score, "flags": flags}


def assess_customer_intent(message: str, customer_excuse_history_count: int = 0) -> dict:
    """Classify whether a customer message appears to be a real return intent or a risky/low-trust request."""
    analysis = analyze_transcript(message, customer_excuse_history_count)
    flags = analysis.get("flags", [])
    score = analysis.get("customer_trust_score", 100)

    if score >= 80 and not flags:
        label = "likely_genuine"
        is_real_intent = True
        summary = "The message reads like a straightforward return request with no obvious manipulation signals."
    elif score >= 60:
        label = "needs_review"
        is_real_intent = False
        summary = "The request looks plausible but includes some signals that warrant review."
    else:
        label = "high_risk"
        is_real_intent = False
        summary = "The message contains strong indicators of low-trust or manipulative intent."

    return {
        "intent_label": label,
        "is_real_intent": is_real_intent,
        "trust_score": score,
        "summary": summary,
        "flags": flags,
    }
