"""Fail-closed LiteLLM proxy callback for trusted GHCP identity propagation."""

from __future__ import annotations

import re
from collections.abc import MutableMapping
from typing import Any, Final

from fastapi import HTTPException
from litellm.caching import DualCache
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth
from litellm.types.utils import CallTypesLiteral

IDENTITY_HEADER: Final = "X-User-Identity"
TRUSTED_METADATA_KEY: Final = "trusted_user_id"
_VALID_IDENTITY: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$")


class TrustedIdentityHook(CustomLogger):
    """Replace all caller identity headers with virtual-key-owned metadata."""

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache: DualCache,
        data: dict,
        call_type: CallTypesLiteral,
    ) -> Exception | str | dict | None:
        del cache, call_type

        _remove_request_identity_headers(data)
        if user_api_key_dict.via_virtual_key is not True:
            raise HTTPException(
                status_code=401,
                detail="Inference requires a LiteLLM virtual key.",
            )

        metadata = user_api_key_dict.metadata
        identity = metadata.get(TRUSTED_METADATA_KEY) if isinstance(metadata, dict) else None
        if not isinstance(identity, str):
            raise HTTPException(
                status_code=403,
                detail="Virtual key is missing trusted identity metadata.",
            )

        trusted_identity = identity.strip()
        if not _VALID_IDENTITY.fullmatch(trusted_identity):
            raise HTTPException(
                status_code=403,
                detail="Virtual key trusted identity metadata is invalid.",
            )

        extra_headers = data.setdefault("extra_headers", {})
        if not isinstance(extra_headers, dict):
            raise HTTPException(status_code=400, detail="extra_headers must be an object.")
        extra_headers[IDENTITY_HEADER] = trusted_identity
        return data


def _remove_request_identity_headers(data: MutableMapping[str, Any]) -> None:
    _remove_identity_header(data.get("headers"))
    _remove_identity_header(data.get("extra_headers"))

    proxy_request = data.get("proxy_server_request")
    if isinstance(proxy_request, MutableMapping):
        _remove_identity_header(proxy_request.get("headers"))

    for metadata_name in ("metadata", "litellm_metadata"):
        metadata = data.get(metadata_name)
        if isinstance(metadata, MutableMapping):
            _remove_identity_header(metadata.get("headers"))


def _remove_identity_header(value: Any) -> None:
    if not isinstance(value, MutableMapping):
        return
    for key in list(value.keys()):
        if isinstance(key, str) and key.casefold() == IDENTITY_HEADER.casefold():
            del value[key]


trusted_identity_hook = TrustedIdentityHook()
