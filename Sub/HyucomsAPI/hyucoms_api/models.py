"""Small, dependency-free data models used by the client."""

from dataclasses import dataclass, field
from typing import Mapping


@dataclass(frozen=True)
class HttpResponse:
    status: int
    reason: str
    headers: Mapping[str, str]
    body: bytes
    url: str = ""


@dataclass(frozen=True)
class ParsedResponse:
    """A lossless-enough representation of Hucoms text/plain responses."""

    values: dict[str, str] = field(default_factory=dict)
    sections: dict[str, dict[str, str]] = field(default_factory=dict)
    raw_text: str = ""
    message: str | None = None

    def get(self, key: str, default: str | None = None) -> str | None:
        return self.values.get(key, default)

    def require(self, key: str) -> str:
        value = self.values.get(key)
        if value is None:
            raise KeyError(key)
        return value

    def __getitem__(self, key: str) -> str:
        return self.values[key]

    def as_dict(self) -> dict[str, str]:
        return dict(self.values)


@dataclass(frozen=True)
class StreamResponse:
    """Streaming HTTP response. The caller must close it."""

    status: int
    reason: str
    headers: Mapping[str, str]
    stream: object
    url: str = ""

    def close(self) -> None:
        close = getattr(self.stream, "close", None)
        if close:
            close()
