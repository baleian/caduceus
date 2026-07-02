"""FastAPI router for the OpenAI-compatible surface — thin, service-delegating."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from caduceus.proxy.service import ProxyService


def build_proxy_router(service: ProxyService) -> APIRouter:
    router = APIRouter()

    @router.api_route(
        "/v1/{path:path}",
        methods=["GET", "POST"],
        include_in_schema=False,
    )
    async def proxy_v1(request: Request, path: str) -> Response:  # noqa: ARG001
        return await service.handle(request)

    return router
