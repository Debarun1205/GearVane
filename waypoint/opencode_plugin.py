"""OpenCode plugin entry point for Waypoint.

The document recommended integrating as an OpenCode plugin or provider shim
rather than forking, to avoid tracking upstream changes. This module provides
the plugin surface: a factory that builds a configured router, plus adapters
that translate between OpenCode's request/response shape and Waypoint's.

OpenCode's plugin contract is kept loose on purpose. If the host's hook names
differ by version, the exports below still let a host call the harness
directly through execute().
"""

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from .classifier import TaskContext
from .orchestrator import ExecutionResult, Orchestrator
from .router import TierRouter

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_FILENAMES = (
    "waypoint.config.yaml",
    "waypoint.yaml",
    "config.yaml",
    ".waypoint/config.yaml",
)


def find_config(start_dir: Optional[str] = None) -> Optional[Path]:
    """Walk up from start_dir looking for a Waypoint config file."""
    current = Path(start_dir or os.getcwd()).resolve()

    for directory in [current, *current.parents]:
        for name in DEFAULT_CONFIG_FILENAMES:
            candidate = directory / name
            if candidate.is_file():
                return candidate

    return None


def load_yaml_config(path: Optional[str] = None) -> Dict[str, Any]:
    """Load a config, searching upward when no path is given."""
    import yaml

    resolved: Optional[Path] = Path(path) if path else find_config()

    if resolved is None or not resolved.is_file():
        logger.warning("No Waypoint config found; using built-in defaults")
        return {}

    with open(resolved) as handle:
        config = yaml.safe_load(handle) or {}

    if not isinstance(config, dict):
        logger.warning(f"Ignoring {resolved}: not a YAML mapping")
        return {}

    logger.info(f"Loaded Waypoint config from {resolved}")
    return config


class WaypointPlugin:
    """OpenCode integration surface.

    Exposed both as a class for direct use and through the module-level
    hook functions at the bottom of this file.
    """

    name = "waypoint"
    version = "0.1.0"

    def __init__(self, config_path: Optional[str] = None, config: Optional[Dict[str, Any]] = None):
        self.config_path = config_path
        self.config = config if config is not None else load_yaml_config(config_path)
        self._orchestrator: Optional[Orchestrator] = None
        self._router: Optional[TierRouter] = None

    @property
    def orchestrator(self) -> Orchestrator:
        """Lazily construct the orchestrator so imports stay cheap."""
        if self._orchestrator is None:
            self._orchestrator = Orchestrator(self.config)
        return self._orchestrator

    @property
    def router(self) -> TierRouter:
        """Lazily construct the router."""
        if self._router is None:
            self._router = TierRouter(self.config)
        return self._router

    # -- host lifecycle hooks -------------------------------------------------

    def on_start(self, **_kwargs) -> bool:
        """Called when the host starts."""
        logger.info(f"Waypoint plugin {self.version} ready")
        return True

    def on_stop(self, **_kwargs) -> None:
        """Called when the host shuts down."""
        logger.info("Waypoint plugin stopping")

    # -- classification -------------------------------------------------------

    def classify_task(
        self, description: str, files: Optional[List[str]] = None, **kwargs
    ) -> Dict[str, Any]:
        """Return a routing decision without executing."""
        context = TaskContext(
            description=description,
            files_touched=files or kwargs.get("files_touched", []),
            error_loops=kwargs.get("error_loops", 0),
            test_failures=kwargs.get("test_failures", 0),
        )
        decision = self.router.route(kwargs.get("task_id", description[:32]), context)
        return {
            "tier": decision.tier.value,
            "provider": decision.provider.name,
            "model": decision.model,
            "confidence": decision.confidence,
            "escalated": decision.escalated,
            "reasons": decision.reasons,
        }

    def select_model(self, description: str, files: Optional[List[str]] = None, **kwargs) -> str:
        """Return just the model id, for hosts that want a single string."""
        return self.classify_task(description, files, **kwargs)["model"]

    # -- execution ------------------------------------------------------------

    def execute_task(
        self, description: str, files: Optional[List[str]] = None, **kwargs
    ) -> Dict[str, Any]:
        """Route and execute a task, returning a host-friendly dict."""
        task_id = kwargs.pop("task_id", None) or description[:32]
        result = self.orchestrator.execute(
            task_id,
            description,
            files_touched=files or [],
            **kwargs,
        )
        return self._result_to_dict(result)

    def stream_task(self, description: str, files: Optional[List[str]] = None, **kwargs):
        """Yield tokens as the model produces them."""
        task_id = kwargs.pop("task_id", None) or description[:32]
        return self.orchestrator.execute_stream(
            task_id, description, files_touched=files or [], **kwargs
        )

    def _result_to_dict(self, result: ExecutionResult) -> Dict[str, Any]:
        """Flatten an ExecutionResult for host consumption."""
        return {
            "success": result.success,
            "content": result.content,
            "tier": result.tier,
            "provider": result.provider,
            "model": result.model,
            "attempts": result.attempts,
            "escalated": result.escalated,
            "cost_usd": result.cost_usd,
            "tokens_in": result.tokens_in,
            "tokens_out": result.tokens_out,
            "duration_seconds": result.duration_seconds,
            "error": result.error,
        }

    # -- reporting ------------------------------------------------------------

    def stats(self) -> Dict[str, Any]:
        """Report current budget and cost state."""
        return {
            "spend": self.orchestrator.safety.get_spend_status(),
            "cost": self.orchestrator.cost.get_stats(),
            "tiers": {tier.value: len(cfg.providers) for tier, cfg in self.router.tiers.items()},
        }


# Module-level singleton so a host can call the functions directly without
# managing an instance.
_plugin: Optional[WaypointPlugin] = None


def get_plugin(config_path: Optional[str] = None) -> WaypointPlugin:
    """Return the shared plugin instance, creating it on first use."""
    global _plugin
    if _plugin is None:
        _plugin = WaypointPlugin(config_path=config_path)
    return _plugin


def on_start(**kwargs) -> bool:
    return get_plugin().on_start(**kwargs)


def on_stop(**kwargs) -> None:
    get_plugin().on_stop(**kwargs)


def classify_task(description: str, files: Optional[List[str]] = None, **kwargs):
    return get_plugin().classify_task(description, files, **kwargs)


def select_model(description: str, files: Optional[List[str]] = None, **kwargs):
    return get_plugin().select_model(description, files, **kwargs)


def execute_task(description: str, files: Optional[List[str]] = None, **kwargs):
    return get_plugin().execute_task(description, files, **kwargs)


def stream_task(description: str, files: Optional[List[str]] = None, **kwargs):
    return get_plugin().stream_task(description, files, **kwargs)


def stats():
    return get_plugin().stats()
