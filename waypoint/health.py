"""Model health checker - monitors model availability and latency."""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Callable
from enum import Enum


logger = logging.getLogger(__name__)


class HealthStatus(Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


@dataclass
class HealthCheckResult:
    model: str
    provider: str
    status: HealthStatus
    latency_ms: float
    last_checked: float
    message: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class HealthConfig:
    check_interval_seconds: float = 60.0
    timeout_seconds: float = 10.0
    latency_threshold_ms: float = 5000.0
    failure_threshold: int = 3


class ModelHealthChecker:
    """Monitors model health through periodic checks."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        health_config = self.config.get("health", {})
        
        self.check_interval = health_config.get("check_interval_seconds", 60.0)
        self.timeout = health_config.get("timeout_seconds", 10.0)
        self.latency_threshold = health_config.get("latency_threshold_ms", 5000.0)
        self.failure_threshold = health_config.get("failure_threshold", 3)
        
        self._models: Dict[str, Dict[str, Any]] = {}
        self._results: Dict[str, HealthCheckResult] = {}
        self._failure_counts: Dict[str, int] = {}
        self._status_callbacks: List[Callable[[str, HealthStatus, HealthStatus], None]] = []
        self._running = False

    def register_model(self, model: str, provider: str, 
                       endpoint: Optional[str] = None,
                       check_fn: Optional[Callable] = None):
        """Register a model for health checking."""
        self._models[model] = {
            "provider": provider,
            "endpoint": endpoint,
            "check_fn": check_fn,
        }
        self._failure_counts[model] = 0
        logger.info(f"Registered model for health check: {model} ({provider})")

    def add_status_callback(self, callback: Callable[[str, HealthStatus, HealthStatus], None]):
        """Add a callback for status changes."""
        self._status_callbacks.append(callback)

    async def check_model(self, model: str) -> HealthCheckResult:
        """Run a health check on a single model."""
        if model not in self._models:
            return HealthCheckResult(
                model=model,
                provider="unknown",
                status=HealthStatus.UNKNOWN,
                latency_ms=0,
                last_checked=time.time(),
                message="Model not registered",
            )
        
        model_info = self._models[model]
        start_time = time.time()
        
        try:
            check_fn = model_info.get("check_fn")
            if check_fn:
                # Use custom check function
                result = await asyncio.wait_for(
                    check_fn(model_info),
                    timeout=self.timeout,
                )
                latency = (time.time() - start_time) * 1000
                
                if result:
                    self._failure_counts[model] = 0
                    status = HealthStatus.HEALTHY
                    message = "OK"
                else:
                    self._failure_counts[model] += 1
                    status = HealthStatus.DEGRADED if self._failure_counts[model] < self.failure_threshold else HealthStatus.UNHEALTHY
                    message = f"Check failed ({self._failure_counts[model]} consecutive failures)"
            else:
                # Default: just check if endpoint is reachable
                endpoint = model_info.get("endpoint")
                if endpoint:
                    # Simple HTTP health check would go here
                    latency = (time.time() - start_time) * 1000
                    self._failure_counts[model] = 0
                    status = HealthStatus.HEALTHY
                    message = "Endpoint reachable"
                else:
                    latency = (time.time() - start_time) * 1000
                    self._failure_counts[model] = 0
                    status = HealthStatus.HEALTHY
                    message = "No check function, assuming healthy"
            
            # Check latency threshold
            if status == HealthStatus.HEALTHY and latency > self.latency_threshold:
                status = HealthStatus.DEGRADED
                message = f"High latency: {latency:.0f}ms"
            
            result = HealthCheckResult(
                model=model,
                provider=model_info["provider"],
                status=status,
                latency_ms=latency,
                last_checked=time.time(),
                message=message,
            )
            
            # Notify on status change
            old_status = self._results.get(model)
            if old_status and old_status.status != status:
                for callback in self._status_callbacks:
                    try:
                        callback(model, old_status.status, status)
                    except Exception as e:
                        logger.error(f"Status callback failed: {e}")
            
            self._results[model] = result
            return result
            
        except asyncio.TimeoutError:
            latency = (time.time() - start_time) * 1000
            self._failure_counts[model] += 1
            status = HealthStatus.UNHEALTHY if self._failure_counts[model] >= self.failure_threshold else HealthStatus.DEGRADED
            
            result = HealthCheckResult(
                model=model,
                provider=model_info["provider"],
                status=status,
                latency_ms=latency,
                last_checked=time.time(),
                message=f"Timeout after {self.timeout}s",
            )
            self._results[model] = result
            return result
            
        except Exception as e:
            latency = (time.time() - start_time) * 1000
            self._failure_counts[model] += 1
            status = HealthStatus.UNHEALTHY if self._failure_counts[model] >= self.failure_threshold else HealthStatus.DEGRADED
            
            result = HealthCheckResult(
                model=model,
                provider=model_info["provider"],
                status=status,
                latency_ms=latency,
                last_checked=time.time(),
                message=str(e),
            )
            self._results[model] = result
            return result

    async def check_all(self) -> List[HealthCheckResult]:
        """Run health checks on all registered models."""
        tasks = [self.check_model(model) for model in self._models]
        return await asyncio.gather(*tasks)

    def get_status(self, model: str) -> Optional[HealthCheckResult]:
        """Get the latest health status for a model."""
        return self._results.get(model)

    def get_all_status(self) -> Dict[str, HealthCheckResult]:
        """Get all health check results."""
        return self._results.copy()

    def get_healthy_models(self) -> List[str]:
        """Get list of healthy models."""
        return [
            model for model, result in self._results.items()
            if result.status == HealthStatus.HEALTHY
        ]

    def get_unhealthy_models(self) -> List[str]:
        """Get list of unhealthy models."""
        return [
            model for model, result in self._results.items()
            if result.status in (HealthStatus.UNHEALTHY, HealthStatus.DEGRADED)
        ]

    async def run_continuous(self):
        """Run health checks continuously."""
        self._running = True
        while self._running:
            await self.check_all()
            await asyncio.sleep(self.check_interval)

    def stop(self):
        """Stop continuous health checking."""
        self._running = False
