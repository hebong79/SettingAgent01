"""Independent Hucoms camera HTTP API client.

The package intentionally has no third-party runtime dependency.
"""

from .client import HucomsCameraClient
from .errors import (
    HucomsError,
    HucomsHTTPError,
    HucomsResponseError,
    HucomsStreamError,
    HucomsTransportError,
    HucomsValidationError,
)
from .models import HttpResponse, ParsedResponse, StreamResponse
from .parser import iter_multipart, parse_text

__all__ = [
    "HucomsCameraClient",
    "HucomsError",
    "HucomsHTTPError",
    "HucomsResponseError",
    "HucomsStreamError",
    "HucomsTransportError",
    "HucomsValidationError",
    "HttpResponse",
    "ParsedResponse",
    "StreamResponse",
    "iter_multipart",
    "parse_text",
]
