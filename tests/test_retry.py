"""Tests for retry, backoff, and circuit breaker behaviour."""

import pytest

from gearvane.retry import (
    CircuitBreaker,
    Retryable,
    RetryConfig,
    RetryExhaustedError,
    RetryStrategy,
    calculate_delay,
    retry_async,
    retry_sync,
)


class TestCalculateDelay:
    def test_fixed_strategy_ignores_attempt(self):
        config = RetryConfig(base_delay=2.0, strategy=RetryStrategy.FIXED)
        assert calculate_delay(0, config) == 2.0
        assert calculate_delay(5, config) == 2.0

    def test_exponential_doubles(self):
        config = RetryConfig(base_delay=1.0, strategy=RetryStrategy.EXPONENTIAL)
        assert calculate_delay(0, config) == 1.0
        assert calculate_delay(1, config) == 2.0
        assert calculate_delay(2, config) == 4.0

    def test_exponential_respects_max_delay(self):
        config = RetryConfig(base_delay=1.0, max_delay=5.0, strategy=RetryStrategy.EXPONENTIAL)
        assert calculate_delay(10, config) == 5.0

    def test_jitter_stays_within_bounds(self):
        config = RetryConfig(
            base_delay=1.0,
            max_delay=10.0,
            strategy=RetryStrategy.EXPONENTIAL_WITH_JITTER,
        )
        for attempt in range(6):
            for _ in range(20):
                delay = calculate_delay(attempt, config)
                assert 0.0 <= delay <= 10.0

    def test_jitter_varies_across_calls(self):
        config = RetryConfig(strategy=RetryStrategy.EXPONENTIAL_WITH_JITTER)
        delays = {calculate_delay(3, config) for _ in range(30)}
        assert len(delays) > 1

    def test_jitter_capped_by_max(self):
        config = RetryConfig(
            base_delay=1.0,
            max_delay=2.0,
            strategy=RetryStrategy.EXPONENTIAL_WITH_JITTER,
        )
        assert all(calculate_delay(20, config) <= 2.0 for _ in range(30))


class TestRetrySync:
    def test_returns_first_success(self):
        calls = []
        result = retry_sync(lambda: calls.append(1) or "ok", RetryConfig(max_retries=3))
        assert result == "ok"
        assert len(calls) == 1

    def test_succeeds_after_failures(self):
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise ValueError("nope")
            return "recovered"

        result = retry_sync(flaky, RetryConfig(max_retries=5, base_delay=0.0))
        assert result == "recovered"
        assert len(calls) == 3

    def test_raises_after_exhausting(self):
        calls = []

        def always_fails():
            calls.append(1)
            raise ValueError("always")

        with pytest.raises(RetryExhaustedError) as exc:
            retry_sync(always_fails, RetryConfig(max_retries=2, base_delay=0.0))

        assert len(calls) == 3  # initial + 2 retries
        assert exc.value.attempts == 3
        assert isinstance(exc.value.last_exception, ValueError)

    def test_non_retryable_exception_propagates(self):
        calls = []

        class Fatal(Exception):
            pass

        def boom():
            calls.append(1)
            raise Fatal("fatal")

        with pytest.raises(Fatal):
            retry_sync(
                boom,
                RetryConfig(max_retries=5, base_delay=0.0, retryable_exceptions=(ValueError,)),
            )
        assert len(calls) == 1

    def test_on_retry_callback_fires(self):
        events = []

        def flaky():
            if len(events) < 1:
                raise ValueError("x")
            return "ok"

        config = RetryConfig(
            max_retries=3,
            base_delay=0.0,
            on_retry=lambda attempt, delay, exc: events.append(attempt),
        )
        retry_sync(flaky, config)
        assert events == [1]

    def test_passes_through_arguments(self):
        def add(a, b, c=0):
            return a + b + c

        assert retry_sync(add, RetryConfig(), 1, 2, c=3) == 6


class TestRetryAsync:
    def test_async_success(self):
        import asyncio

        async def work():
            return "done"

        result = asyncio.run(retry_async(work, RetryConfig()))
        assert result == "done"

    def test_async_retries_then_succeeds(self):
        import asyncio

        calls = []

        async def flaky():
            calls.append(1)
            if len(calls) < 2:
                raise ValueError("x")
            return "ok"

        result = asyncio.run(retry_async(flaky, RetryConfig(max_retries=3, base_delay=0.0)))
        assert result == "ok"
        assert len(calls) == 2

    def test_async_exhaustion(self):
        import asyncio

        async def always():
            raise ValueError("no")

        with pytest.raises(RetryExhaustedError):
            asyncio.run(retry_async(always, RetryConfig(max_retries=1, base_delay=0.0)))


class TestRetryableDecorator:
    def test_decorates_sync_function(self):
        calls = []

        @Retryable(RetryConfig(max_retries=3, base_delay=0.0))
        def flaky():
            calls.append(1)
            if len(calls) < 2:
                raise ValueError("x")
            return "ok"

        assert flaky() == "ok"
        assert len(calls) == 2

    def test_decorates_async_function(self):
        import asyncio

        calls = []

        @Retryable(RetryConfig(max_retries=3, base_delay=0.0))
        async def flaky():
            calls.append(1)
            if len(calls) < 2:
                raise ValueError("x")
            return "ok"

        assert asyncio.run(flaky()) == "ok"

    def test_preserves_function_name(self):
        @Retryable(RetryConfig())
        def named():
            return 1

        assert named.__name__ == "named"


class TestCircuitBreaker:
    def test_starts_closed(self):
        breaker = CircuitBreaker()
        assert breaker.can_execute() is True

    def test_opens_after_threshold(self):
        breaker = CircuitBreaker(failure_threshold=3)
        for _ in range(3):
            breaker.record_failure()
        assert breaker.state == CircuitBreaker.State.OPEN
        assert breaker.can_execute() is False

    def test_success_resets_failure_count(self):
        breaker = CircuitBreaker(failure_threshold=3)
        breaker.record_failure()
        breaker.record_failure()
        breaker.record_success()
        breaker.record_failure()
        assert breaker.state == CircuitBreaker.State.CLOSED

    def test_half_opens_after_recovery_timeout(self):
        import time

        breaker = CircuitBreaker(failure_threshold=1, recovery_timeout=0.01)
        breaker.record_failure()
        assert breaker.can_execute() is False
        time.sleep(0.02)
        assert breaker.can_execute() is True
        assert breaker.state == CircuitBreaker.State.HALF_OPEN

    def test_closes_after_successful_probe(self):
        breaker = CircuitBreaker(failure_threshold=1, recovery_timeout=0.01)
        breaker.record_failure()
        import time

        time.sleep(0.02)
        assert breaker.can_execute() is True
        assert breaker.state == CircuitBreaker.State.HALF_OPEN
        breaker.record_success()
        assert breaker.state == CircuitBreaker.State.CLOSED

    def test_decorator_blocks_when_open(self):
        breaker = CircuitBreaker(failure_threshold=1)
        breaker.record_failure()
        calls = []

        @breaker
        def work():
            calls.append(1)
            return "ok"

        with pytest.raises(Exception, match="Circuit breaker is OPEN"):
            work()
        assert calls == []

    def test_decorator_records_success(self):
        breaker = CircuitBreaker(failure_threshold=2)

        @breaker
        def work():
            return "ok"

        assert work() == "ok"
        assert breaker.failure_count == 0

    def test_decorator_records_failure(self):
        breaker = CircuitBreaker(failure_threshold=2)

        @breaker
        def work():
            raise ValueError("x")

        for _ in range(2):
            with pytest.raises(ValueError):
                work()
        assert breaker.state == CircuitBreaker.State.OPEN
