from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass


class ServiceTokenError(ValueError):
    pass


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(f"{value}{'=' * (-len(value) % 4)}")


@dataclass(frozen=True, slots=True)
class ServiceTokenClaims:
    subject: str
    audience: str
    tenant_id: str
    authorization_context_hash: str
    expires_at: int


def issue_service_token(
    secret: str,
    *,
    subject: str,
    audience: str,
    tenant_id: str,
    authorization_context_hash: str,
    ttl_seconds: int = 60,
    now: int | None = None,
) -> str:
    issued_at = int(time.time() if now is None else now)
    header = _encode(json.dumps({"alg": "HS256", "typ": "HMAC-JWT"}, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    payload = _encode(json.dumps({
        "sub": subject,
        "aud": audience,
        "tenant_id": tenant_id,
        "authorization_context_hash": authorization_context_hash,
        "iat": issued_at,
        "exp": issued_at + max(1, min(ttl_seconds, 120)),
    }, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    message = f"{header}.{payload}".encode("ascii")
    signature = _encode(hmac.new(secret.encode("utf-8"), message, hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def verify_service_token(
    token: str,
    secret: str,
    *,
    audience: str,
    tenant_id: str,
    authorization_context_hash: str,
    now: int | None = None,
) -> ServiceTokenClaims:
    try:
        header, payload, supplied_signature = token.split(".")
        expected_signature = _encode(hmac.new(secret.encode("utf-8"), f"{header}.{payload}".encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise ServiceTokenError("SERVICE_TOKEN_SIGNATURE_INVALID")
        metadata = json.loads(_decode(header))
        claims = json.loads(_decode(payload))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ServiceTokenError("SERVICE_TOKEN_INVALID") from error
    if metadata.get("alg") != "HS256" or metadata.get("typ") != "HMAC-JWT":
        raise ServiceTokenError("SERVICE_TOKEN_ALGORITHM_INVALID")
    current = int(time.time() if now is None else now)
    if int(claims.get("exp") or 0) <= current:
        raise ServiceTokenError("SERVICE_TOKEN_EXPIRED")
    if claims.get("aud") != audience or claims.get("tenant_id") != tenant_id:
        raise ServiceTokenError("SERVICE_TOKEN_SCOPE_INVALID")
    if claims.get("authorization_context_hash") != authorization_context_hash:
        raise ServiceTokenError("SERVICE_TOKEN_CONTEXT_INVALID")
    subject = str(claims.get("sub") or "")
    if not subject:
        raise ServiceTokenError("SERVICE_TOKEN_SUBJECT_INVALID")
    return ServiceTokenClaims(
        subject=subject,
        audience=audience,
        tenant_id=tenant_id,
        authorization_context_hash=authorization_context_hash,
        expires_at=int(claims["exp"]),
    )
