"""Retry logic with exponential backoff and jitter."""

import asyncio
import logging
import random
import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional, Type, List, Any


logger = logging.getLogger(__name__)


class RetryStrategy(Enum):
    FIXED = "fixed"
    EXPONENTIAL = "exponential"
    EXPONENTIAL_WITH_JITTER = "exponential_with_jitter"


@dataclass
class RetryConfig:
    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    strategy: RetryStrategy = RetryStrategy.EXPONENTIAL_WITH_JITTER
    retryable_exceptions: tuple = (Exception,)
    on_retry: Optional[Callable[[int, float, Exception], None]] = None


class RetryExhaustedError(Exception):
    """Raised when all retry attempts are exhausted."""

    def __init__(self, message: str, last_exception: Exception, attempts: int):
        super().__init__(message)
        self.last_exception = last_exception
        self.attempts = attempts


def calculate_delay(attempt: int, config: RetryConfig) -> float:
    """Calculate delay before next retry attempt."""
    if config.strategy == RetryStrategy.FIXED:
        return config.base_delay
    
    elif config.strategy == RetryStrategy.EXPONENTIAL:
        delay = config.base_delay * (2 ** attempt)
        return min(delay, config.max_delay)
    
    elif config.strategy == RetryStrategy.EXPONENTIAL_WITH_JITTER:
        # Exponential backoff with full jitter
        # https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
        exp_delay = config.base_delay * (2 ** attempt)
        capped_delay = min(exp_delay, config.max_delay)
        return random.uniform(0, capped_delay)
    
    return config.base_delay


def retry_sync(func: Callable, config: Optional[RetryConfig] = None, *args, **kwargs) -> Any:
    """Execute a synchronous function with retry logic."""
    cfg = config or RetryConfig()
    last_exception = None
    
    for attempt in range(cfg.max_retries + 1):
        try:
            return func(*args, **kwargs)
        except cfg.retryable_exceptions as e:
            last_exception = e
            
            if attempt >= cfg.max_retries:
                logger.error(f"All {cfg.max_retries + 1} attempts failed for {func.__name__}")
                raise RetryExhaustedError(
                    f"Function {func.__name__} failed after {cfg.max_retries + 1} attempts",
                    last_exception,
                    attempt + 1,
                )
            
            delay = calculate_delay(attempt, cfg)
            logger.warning(
                f"Attempt {attempt + 1}/{cfg.max_retries + 1} failed for {func.__name__}: {e}. "
                f"Retrying in {delay:.2f}s..."
            )
            
            if cfg.on_retry:
                cfg.on_retry(attempt + 1, delay, e)
            
            time.sleep(delay)
    
    # Should never reach here
    raise RetryExhaustedError("Unexpected retry exhaustion", last_exception, cfg.max_retries + 1)


async def retry_async(func: Callable, config: Optional[RetryConfig] = None, *args, **kwargs) -> Any:
    """Execute an asynchronous function with retry logic."""
    cfg = config or RetryConfig()
    last_exception = None
    
    for attempt in range(cfg.max_retries + 1):
        try:
            return await func(*args, **kwargs)
        except cfg.retryable_exceptions as e:
            last_exception = e
            
            if attempt >= cfg.max_retries:
                logger.error(f"All {cfg.max_retries + 1} attempts failed for {func.__name__}")
                raise RetryExhaustedError(
                    f"Function {func.__name__} failed after {cfg.max_retries + 1} attempts",
                    last_exception,
                    attempt + 1,
                )
            
            delay = calculate_delay(attempt, cfg)
            logger.warning(
                f"Attempt {attempt + 1}/{cfg.max_retries + 1} failed for {func.__name__}: {e}. "
                f"Retrying in {delay:.2f}s..."
            )
            
            if cfg.on_retry:
                cfg.on_retry(attempt + 1, delay, e)
            
            await asyncio.sleep(delay)
    
    raise RetryExhaustedError("Unexpected retry exhaustion", last_exception, cfg.max_retries + 1)


class Retryable:
    """Decorator for adding retry logic to functions."""

    def __init__(self, config: Optional[RetryConfig] = None):
        self.config = config or RetryConfig()

    def __call__(self, func: Callable) -> Callable:
        import functools
        
        if asyncio.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args, **kwargs):
                return await retry_async(func, self.config, *args, **kwargs)
            return async_wrapper
        else:
            @functools.wraps(func)
            def sync_wrapper(*args, **kwargs):
                return retry_sync(func, self.config, *args, **kwargs)
            return sync_wrapper


class CircuitBreaker:
    """Circuit breaker pattern to prevent cascading failures."""

    class State(Enum):
        CLOSED = "closed"      # Normal operation
        OPEN = "open"          # Failing, reject requests
        HALF_OPEN = "half_open"  # Testing if service recovered

    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.state = self.State.CLOSED
        self.failure_count = 0
        self.last_failure_time: Optional[float] = None

    def can_execute(self) -> bool:
        """Check if execution is allowed."""
        if self.state == self.State.CLOSED:
            return True
        
        if self.state == self.State.OPEN:
            if self.last_failure_time and (time.time() - self.last_failure_time) > self.recovery_timeout:
                self.state = self.State.HALF_OPEN
                logger.info("Circuit breaker entering HALF_OPEN state")
                return True
            return False
        
        return True  # HALF_OPEN

    def record_success(self):
        """Record a successful execution."""
        self.failure_count = 0
        if self.state == self.State.HALF_OPEN:
            self.state = self.State.CLOSED
            logger.info("Circuit breaker CLOSED - service recovered")

    def record_failure(self):
        """Record a failed execution."""
        self.failure_count += 1
        self.last_failure_time = time.time()
        
        if self.failure_count >= self.failure_threshold:
            self.state = self.State.OPEN
            logger.warning(f"Circuit breaker OPENED after {self.failure_count} failures")

    def __call__(self, func: Callable) -> Callable:
        import functools
        
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if not self.can_execute():
                raise Exception("Circuit breaker is OPEN")
            
            try:
                result = func(*args, **kwargs)
                self.record_success()
                return result
            except Exception as e:
                self.record_failure()
                raise
        
        return wrapper
