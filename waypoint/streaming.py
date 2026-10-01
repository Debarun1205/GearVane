"""Streaming response support for model interactions."""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Optional, Dict, Any, Union
from enum import Enum


logger = logging.getLogger(__name__)


class StreamEventType(Enum):
    START = "start"
    TOKEN = "token"
    TOOL_CALL = "tool_call"
    THINKING = "thinking"
    DONE = "done"
    ERROR = "error"


@dataclass
class StreamEvent:
    type: StreamEventType
    data: Any
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}

    def to_dict(self) -> dict:
        return {
            "type": self.type.value,
            "data": self.data,
            "metadata": self.metadata,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


class StreamBuffer:
    """Buffers and processes streaming tokens."""

    def __init__(self, buffer_size: int = 100):
        self.buffer_size = buffer_size
        self._buffer: list = []
        self._handlers: Dict[StreamEventType, list] = {}

    def on(self, event_type: StreamEventType, handler: Callable):
        """Register a handler for an event type."""
        if event_type not in self._handlers:
            self._handlers[event_type] = []
        self._handlers[event_type].append(handler)

    def emit(self, event: StreamEvent):
        """Emit an event to registered handlers."""
        self._buffer.append(event)
        if len(self._buffer) > self.buffer_size:
            self._buffer.pop(0)

        handlers = self._handlers.get(event.type, [])
        for handler in handlers:
            try:
                handler(event)
            except Exception as e:
                logger.error(f"Stream handler error: {e}")

    def get_recent(self, n: int = 10) -> list:
        """Get recent events."""
        return self._buffer[-n:]

    def clear(self):
        """Clear the buffer."""
        self._buffer.clear()


class StreamingClient:
    """Client for streaming model responses."""

    def __init__(self, model: str, provider: str, config: Optional[Dict[str, Any]] = None):
        self.model = model
        self.provider = provider
        self.config = config or {}
        self.buffer = StreamBuffer()
        self._active_streams: Dict[str, asyncio.Task] = {}

    async def stream(self, prompt: str, stream_id: Optional[str] = None,
                     system_prompt: Optional[str] = None,
                     tools: Optional[list] = None,
                     **kwargs) -> AsyncIterator[StreamEvent]:
        """Stream a response from a model."""
        stream_id = stream_id or f"stream-{id(prompt)}"
        
        # Emit start event
        yield StreamEvent(
            type=StreamEventType.START,
            data={"model": self.model, "provider": self.provider, "stream_id": stream_id},
        )

        try:
            # This is a placeholder for actual model streaming
            # In production, this would connect to the model API
            # and yield tokens as they arrive
            
            # Simulate streaming for now
            response = await self._call_model(prompt, system_prompt, tools, **kwargs)
            
            # Stream tokens
            tokens = response.get("content", "").split()
            for token in tokens:
                yield StreamEvent(
                    type=StreamEventType.TOKEN,
                    data={"token": token + " ", "stream_id": stream_id},
                )
                await asyncio.sleep(0.01)  # Simulate network delay
            
            # Emit tool calls if any
            tool_calls = response.get("tool_calls", [])
            for tool_call in tool_calls:
                yield StreamEvent(
                    type=StreamEventType.TOOL_CALL,
                    data=tool_call,
                )
            
            # Emit done event
            yield StreamEvent(
                type=StreamEventType.DONE,
                data={
                    "stream_id": stream_id,
                    "model": self.model,
                    "usage": response.get("usage", {}),
                },
            )
            
        except Exception as e:
            yield StreamEvent(
                type=StreamEventType.ERROR,
                data={"error": str(e), "stream_id": stream_id},
            )

    async def _call_model(self, prompt: str, system_prompt: Optional[str] = None,
                          tools: Optional[list] = None, **kwargs) -> dict:
        """Call the model API (placeholder for actual implementation)."""
        # In production, this would make the actual API call
        # For now, return a mock response
        return {
            "content": "This is a mock response from the streaming client.",
            "tool_calls": [],
            "usage": {"tokens_in": 10, "tokens_out": 10},
        }

    def register_handler(self, event_type: StreamEventType, handler: Callable):
        """Register an event handler."""
        self.buffer.on(event_type, handler)

    async def stream_to_console(self, prompt: str, **kwargs):
        """Stream a response directly to console."""
        async for event in self.stream(prompt, **kwargs):
            if event.type == StreamEventType.TOKEN:
                print(event.data["token"], end="", flush=True)
            elif event.type == StreamEventType.ERROR:
                print(f"\nError: {event.data['error']}")
            elif event.type == StreamEventType.DONE:
                print()  # New line after done


class StreamAggregator:
    """Aggregates multiple streams for parallel model calls."""

    def __init__(self):
        self._streams: Dict[str, StreamingClient] = {}

    def add_stream(self, name: str, client: StreamingClient):
        """Add a named stream."""
        self._streams[name] = client

    async def stream_all(self, prompt: str, **kwargs) -> AsyncIterator[tuple]:
        """Stream from all registered clients."""
        async def _stream(name, client):
            async for event in client.stream(prompt, **kwargs):
                yield (name, event)

        # Merge all streams
        merged = asyncio.Queue()
        
        async def _consume(name, client):
            async for event in client.stream(prompt, **kwargs):
                await merged.put((name, event))
            await merged.put((name, None))  # Sentinel

        tasks = [asyncio.create_task(_consume(name, client)) 
                 for name, client in self._streams.items()]
        
        completed = 0
        while completed < len(tasks):
            name, event = await merged.get()
            if event is None:
                completed += 1
            else:
                yield (name, event)
        
        await asyncio.gather(*tasks)
