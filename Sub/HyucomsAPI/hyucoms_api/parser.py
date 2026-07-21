"""Parsers for Hucoms text and multipart responses."""

from __future__ import annotations

import re
from collections.abc import Iterator

from .errors import HucomsStreamError
from .models import ParsedResponse


_KEY_VALUE = re.compile(r"^\s*([^=\s][^=]*?)\s*=\s*(.*?)\s*$")
_ERROR = re.compile(r"^\s*error\s*:\s*(.*)$", re.IGNORECASE)


def _clean_value(value: str) -> str:
    # The manual appends comments such as "* if supported" to examples.
    return re.sub(r"\s+\*\s+.*$", "", value).strip()


def parse_text(text: str) -> ParsedResponse:
    """Parse a Hucoms ``key = value`` body while retaining sections and raw text."""

    values: dict[str, str] = {}
    sections: dict[str, dict[str, str]] = {}
    current: dict[str, str] | None = None
    message: str | None = None
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        error = _ERROR.match(stripped)
        if error:
            message = error.group(1).strip()
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            section_name = stripped[1:-1].strip()
            current = sections.setdefault(section_name, {})
            continue
        match = _KEY_VALUE.match(line)
        if not match:
            continue
        key, value = match.groups()
        value = _clean_value(value)
        values[key.strip()] = value
        if current is not None:
            current[key.strip()] = value
    return ParsedResponse(values=values, sections=sections, raw_text=text, message=message)


def _header(headers: dict[str, str], name: str) -> str | None:
    wanted = name.lower()
    return next((value for key, value in headers.items() if key.lower() == wanted), None)


def _boundary(content_type: str) -> bytes:
    match = re.search(r"boundary\s*=\s*(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.I)
    if not match:
        raise HucomsStreamError("multipart response has no boundary")
    return (match.group(1) or match.group(2)).encode("utf-8")


def iter_multipart(data: bytes, content_type: str) -> Iterator[bytes]:
    """Yield payloads from a buffered multipart/x-mixed-replace response."""

    boundary = b"--" + _boundary(content_type)
    for part in data.split(boundary)[1:]:
        part = part.lstrip(b"\r\n")
        if not part or part.startswith(b"--"):
            continue
        header_blob, separator, payload = part.partition(b"\r\n\r\n")
        if not separator:
            header_blob, separator, payload = part.partition(b"\n\n")
        if not separator:
            raise HucomsStreamError("multipart part has no header separator")
        headers: dict[str, str] = {}
        for line in header_blob.decode("latin-1").splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip()] = value.strip()
        length = _header(headers, "Content-Length")
        if length:
            try:
                payload = payload[: int(length)]
            except ValueError as exc:
                raise HucomsStreamError(f"invalid multipart Content-Length: {length}") from exc
        else:
            payload = payload.rstrip(b"\r\n")
        if payload:
            yield payload
