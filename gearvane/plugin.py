"""Plugin system for OpenCode integration."""

import importlib
import inspect
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Type

logger = logging.getLogger(__name__)


@dataclass
class PluginMetadata:
    name: str
    version: str
    description: str
    author: str
    hooks: List[str] = field(default_factory=list)


class GearVanePlugin(ABC):
    """Base class for GearVane plugins."""

    metadata: PluginMetadata

    @abstractmethod
    def initialize(self, config: Dict[str, Any]) -> bool:
        """Initialize the plugin with configuration."""
        pass

    @abstractmethod
    def shutdown(self):
        """Clean up plugin resources."""
        pass

    def on_route(self, task_id: str, context, decision) -> None:
        """Called after a routing decision is made."""
        pass

    def on_escalation(self, task_id: str, from_tier: str, to_tier: str) -> None:
        """Called when a task is escalated."""
        pass

    def on_failure(self, task_id: str, error: str) -> None:
        """Called when a task fails."""
        pass

    def on_success(self, task_id: str, result: Any) -> None:
        """Called when a task succeeds."""
        pass


class PluginManager:
    """Manages plugin lifecycle and hooks."""

    def __init__(self):
        self._plugins: Dict[str, GearVanePlugin] = {}
        self._hooks: Dict[str, List[GearVanePlugin]] = {}

    def register(self, plugin_class: Type[GearVanePlugin], config: Dict[str, Any]) -> bool:
        """Register and initialize a plugin."""
        try:
            plugin = plugin_class()
            if not plugin.initialize(config):
                # initialize() returning False means the plugin declined.
                logger.error("Plugin failed to initialize")
                return False

            self._plugins[plugin.metadata.name] = plugin

            # Register hooks
            for hook in plugin.metadata.hooks:
                if hook not in self._hooks:
                    self._hooks[hook] = []
                self._hooks[hook].append(plugin)

            logger.info(f"Plugin registered: {plugin.metadata.name} v{plugin.metadata.version}")
            return True
        except Exception as e:
            logger.error(f"Failed to register plugin: {e}")
            return False

    def unregister(self, name: str) -> bool:
        """Unregister a plugin."""
        if name not in self._plugins:
            return False

        plugin = self._plugins.pop(name)
        plugin.shutdown()

        # Remove from hooks
        for hook_plugins in self._hooks.values():
            if plugin in hook_plugins:
                hook_plugins.remove(plugin)

        logger.info(f"Plugin unregistered: {name}")
        return True

    def emit_hook(self, hook_name: str, *args, **kwargs):
        """Emit a hook to all registered plugins."""
        if hook_name not in self._hooks:
            return

        for plugin in self._hooks[hook_name]:
            try:
                method = getattr(plugin, hook_name, None)
                if method:
                    method(*args, **kwargs)
            except Exception as e:
                logger.error(f"Plugin {plugin.metadata.name} hook {hook_name} failed: {e}")

    def get_plugin(self, name: str) -> Optional[GearVanePlugin]:
        """Get a plugin by name."""
        return self._plugins.get(name)

    def list_plugins(self) -> List[PluginMetadata]:
        """List all registered plugins."""
        return [p.metadata for p in self._plugins.values()]

    def load_from_module(self, module_path: str, config: Dict[str, Any]) -> bool:
        """Dynamically load a plugin from a module path."""
        try:
            module = importlib.import_module(module_path)
            # Find plugin classes in the module
            for name, obj in inspect.getmembers(module):
                if (
                    inspect.isclass(obj)
                    and issubclass(obj, GearVanePlugin)
                    and obj is not GearVanePlugin
                ):
                    return self.register(obj, config)
            logger.error(f"No plugin class found in {module_path}")
            return False
        except Exception as e:
            logger.error(f"Failed to load plugin from {module_path}: {e}")
            return False
