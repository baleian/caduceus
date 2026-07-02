"""Data plane (U2): OpenAI-compatible /v1 proxy.

MUST NOT import from ``caduceus.control`` (two-plane rule) — the only
control-plane touchpoints are the EventSink port and the TokenResolver,
both injected by ``daemon.py``.
"""
