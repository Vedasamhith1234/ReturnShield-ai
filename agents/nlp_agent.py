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
