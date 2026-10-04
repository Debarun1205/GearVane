"""Task classifier using heuristics to determine complexity tier."""

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


class Tier(Enum):
    LOCAL = "local"
    MID = "mid"
    FRONTIER = "frontier"


@dataclass
class ClassificationResult:
    tier: Tier
    confidence: float  # 0.0 to 1.0
    reasons: List[str] = field(default_factory=list)
    scores: dict = field(default_factory=dict)


@dataclass
class TaskContext:
    description: str
    files_touched: List[str] = field(default_factory=list)
    error_loops: int = 0
    test_failures: int = 0
    previous_tier: Optional[Tier] = None
    previous_attempts: int = 0


class TaskClassifier:
    """Classifies tasks into tiers using keyword heuristics and context."""

    SIMPLE_KEYWORDS = [
        "typo",
        "formatting",
        "rename",
        "comment",
        "readme",
        "documentation",
        "boilerplate",
        "template",
        "simple",
        "fix",
        "small",
        "typo",
        "spelling",
        "whitespace",
        "lint",
    ]

    COMPLEX_KEYWORDS = [
        "architecture",
        "refactor",
        "optimize",
        "security",
        "concurrency",
        "distributed",
        "migration",
        "redesign",
        "performance",
        "scale",
        "debug",
        "investigate",
        "complex",
        "race condition",
        "deadlock",
        "memory leak",
        "bottleneck",
    ]

    COMPLEX_FILE_PATTERNS = [
        r"\.rs$",
        r"\.go$",
        r"\.cpp$",
        r"\.c$",
        r"_test\.",
        r"tests?/",
        r"src/core/",
        r"src/engine/",
        r"migrations?",
        r"deploy",
        r"infra",
    ]

    # Glob-style patterns, which are what users actually write in config.
    COMPLEX_FILE_GLOBS = [
        "*.rs",
        "*.go",
        "*_test.*",
        "src/core/*",
        "src/engine/*",
    ]

    @staticmethod
    def _glob_to_regex(pattern: str) -> str:
        """Translate a glob pattern into an anchored-enough regex.

        Config files naturally use globs ("*.rs"), which are not valid regex
        ("nothing to repeat"). "*" is treated as matching across path
        separators so that "*.rs" matches "src/main.rs", which is what a user
        writing that pattern expects.
        """
        out = []
        for ch in pattern:
            if ch == "*":
                out.append(".*")
            elif ch == "?":
                out.append(".")
            else:
                out.append(re.escape(ch))
        return "".join(out)

    @classmethod
    def _compile_patterns(cls, patterns) -> List[str]:
        """Compile config patterns, accepting both glob and regex syntax."""
        compiled = []
        for p in patterns:
            text = str(p)
            try:
                re.compile(text)
                compiled.append(text)
            except re.error:
                # Not valid regex, so treat it as a glob.
                compiled.append(cls._glob_to_regex(text))
        return compiled

    def __init__(self, config: Optional[dict] = None):
        self.config = config or {}
        self.heuristics = self.config.get("heuristics", {})
        self.simple_keywords = self.heuristics.get("simple_keywords", self.SIMPLE_KEYWORDS)
        self.complex_keywords = self.heuristics.get("complex_keywords", self.COMPLEX_KEYWORDS)
        self.complex_file_patterns = self._compile_patterns(
            self.heuristics.get("complex_file_patterns", self.COMPLEX_FILE_PATTERNS)
        )
        self.min_files_for_complex = self.heuristics.get("min_files_for_complex", 3)

    def classify(self, context: TaskContext) -> ClassificationResult:
        """Classify a task into a tier based on heuristics."""
        scores = {Tier.LOCAL: 0.0, Tier.MID: 0.0, Tier.FRONTIER: 0.0}
        reasons = []

        desc_lower = context.description.lower()

        # Keyword scoring
        simple_matches = sum(1 for kw in self.simple_keywords if kw in desc_lower)
        complex_matches = sum(1 for kw in self.complex_keywords if kw in desc_lower)

        scores[Tier.LOCAL] += simple_matches * 0.3
        scores[Tier.FRONTIER] += complex_matches * 0.3

        if simple_matches > 0:
            reasons.append(f"Found {simple_matches} simple-task keywords")
        if complex_matches > 0:
            reasons.append(f"Found {complex_matches} complex-task keywords")

        # File-based scoring
        complex_files = sum(
            1
            for f in context.files_touched
            if any(re.search(p, f) for p in self.complex_file_patterns)
        )
        if complex_files > 0:
            scores[Tier.FRONTIER] += complex_files * 0.2
            reasons.append(f"{complex_files} complex file patterns matched")

        if len(context.files_touched) >= self.min_files_for_complex:
            scores[Tier.FRONTIER] += 0.3
            reasons.append(f"Many files touched ({len(context.files_touched)})")

        # Error loop scoring
        if context.error_loops > 0:
            scores[Tier.FRONTIER] += context.error_loops * 0.4
            reasons.append(f"{context.error_loops} error loops detected")

        # Test failure scoring
        if context.test_failures > 0:
            scores[Tier.FRONTIER] += context.test_failures * 0.3
            reasons.append(f"{context.test_failures} test failures")

        # Previous tier escalation
        if context.previous_tier == Tier.LOCAL and context.previous_attempts >= 2:
            scores[Tier.MID] += 0.5
            reasons.append("Escalating from local after repeated failures")
        elif context.previous_tier == Tier.MID and context.previous_attempts >= 2:
            scores[Tier.FRONTIER] += 0.5
            reasons.append("Escalating from mid after repeated failures")

        # Determine winner
        max_score = max(scores.values())
        if max_score == 0:
            # Default to MID when no signals
            return ClassificationResult(
                tier=Tier.MID,
                confidence=0.5,
                reasons=["No strong signals, defaulting to mid tier"],
                scores={k.value: v for k, v in scores.items()},
            )

        winner = max(scores, key=lambda t: scores[t])
        # Confidence based on margin
        sorted_scores = sorted(scores.values(), reverse=True)
        margin = sorted_scores[0] - sorted_scores[1] if len(sorted_scores) > 1 else sorted_scores[0]
        confidence = min(0.5 + margin * 0.3, 1.0)

        return ClassificationResult(
            tier=winner,
            confidence=round(confidence, 2),
            reasons=reasons,
            scores={k.value: v for k, v in scores.items()},
        )
