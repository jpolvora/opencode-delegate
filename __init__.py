"""opencode-delegate — run delegated OpenCode tasks through a Node runner.

The runtime lives in ``app/`` and talks to the already-running OpenCode server with
``@opencode/client``. This plugin only registers the dispatcher skill; execution is
deliberately driven by Hermes' terminal/process tools so a run can be backgrounded,
polled, and survive independent of the agent turn that started it.
"""

from __future__ import annotations

from pathlib import Path

_SKILL_MD = Path(__file__).resolve().parent / "skills" / "dispatch" / "SKILL.md"


def register(ctx) -> None:
    """Register the dispatch skill (called once by the Hermes plugin loader)."""
    ctx.register_skill(
        name="dispatch",
        path=_SKILL_MD,
        description=(
            "Dispatch a delegated task to a running OpenCode server through the "
            "opencode-delegate Node runner; background it, stream reasoning/text, "
            "and collect result.json."
        ),
    )


__all__ = ["register"]
