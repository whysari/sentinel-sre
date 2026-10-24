"""
In-process Server-Sent Events (SSE) broadcaster for live incident streaming.

Every triage, chaos injection and DR drill is published to an ``EventBroadcaster``; HTTP
handlers subscribe and render events in the ``text/event-stream`` wire format so the Next.js
dashboard can update in real time via ``EventSource``. A bounded replay buffer supports the
standard ``Last-Event-ID`` reconnection header.
"""
from __future__ import annotations

import itertools
import json
import queue
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Deque, Dict, Iterator, List, Optional, Set

SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8"
SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",  # disable nginx response buffering
}


@dataclass(frozen=True)
class ServerSentEvent:
    id: int
    event: str
    data: Dict[str, Any]
    timestamp: float

    def encode(self) -> str:
        payload = json.dumps(self.data, separators=(",", ":"), sort_keys=True, default=str)
        return f"id: {self.id}\nevent: {self.event}\ndata: {payload}\n\n"


def encode_sse(event: str, data: Dict[str, Any], event_id: Optional[int] = None) -> str:
    """Encode a one-off SSE frame (used by finite streams such as chaos runs)."""
    payload = json.dumps(data, separators=(",", ":"), sort_keys=True, default=str)
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {payload}\n\n"


def sse_comment(text: str = "keep-alive") -> str:
    return f": {text}\n\n"


class Subscription:
    def __init__(self, broker: "EventBroadcaster", max_queue: int) -> None:
        self._broker = broker
        self.queue: "queue.Queue[ServerSentEvent]" = queue.Queue(maxsize=max_queue)
        self.dropped = 0

    def offer(self, evt: ServerSentEvent) -> None:
        try:
            self.queue.put_nowait(evt)
        except queue.Full:
            # Slow consumer: drop the oldest frame rather than blocking publishers.
            try:
                self.queue.get_nowait()
            except queue.Empty:  # pragma: no cover - race
                pass
            self.dropped += 1
            try:
                self.queue.put_nowait(evt)
            except queue.Full:  # pragma: no cover - race
                pass

    def get(self, timeout: float) -> Optional[ServerSentEvent]:
        try:
            return self.queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self) -> None:
        self._broker.unsubscribe(self)


class EventBroadcaster:
    """Thread-safe fan-out pub/sub with a bounded replay history."""

    def __init__(self, history_size: int = 256, subscriber_queue_size: int = 1024) -> None:
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._history: Deque[ServerSentEvent] = deque(maxlen=history_size)
        self._subscribers: Set[Subscription] = set()
        self._subscriber_queue_size = subscriber_queue_size

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def publish(self, event: str, data: Dict[str, Any]) -> ServerSentEvent:
        with self._lock:
            evt = ServerSentEvent(id=next(self._ids), event=event, data=data, timestamp=time.time())
            self._history.append(evt)
            subscribers = list(self._subscribers)
        for sub in subscribers:
            sub.offer(evt)
        return evt

    def history(self, after_id: int = 0) -> List[ServerSentEvent]:
        with self._lock:
            return [e for e in self._history if e.id > after_id]

    def subscribe(self, last_event_id: Optional[int] = None) -> Subscription:
        sub = Subscription(self, self._subscriber_queue_size)
        with self._lock:
            if last_event_id is not None:
                for evt in self._history:
                    if evt.id > last_event_id:
                        sub.offer(evt)
            self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            self._subscribers.discard(sub)

    def stream(
        self,
        last_event_id: Optional[int] = None,
        heartbeat_seconds: float = 15.0,
        max_events: Optional[int] = None,
        retry_ms: int = 3000,
    ) -> Iterator[str]:
        """
        Yield SSE frames forever (or until ``max_events`` frames were delivered). Heartbeat comments
        are emitted when idle so proxies keep the connection open and dead clients are detected.
        """
        sub = self.subscribe(last_event_id)
        delivered = 0
        try:
            yield f"retry: {retry_ms}\n" + sse_comment("sentinel-sre event stream connected")
            while max_events is None or delivered < max_events:
                evt = sub.get(timeout=heartbeat_seconds)
                if evt is None:
                    yield sse_comment()
                    continue
                delivered += 1
                yield evt.encode()
        finally:
            sub.close()
