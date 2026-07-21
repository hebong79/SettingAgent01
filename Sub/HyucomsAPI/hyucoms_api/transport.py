"""Standard-library HTTP transport used by :mod:`hyucoms_api`."""

from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Mapping

from .errors import HucomsHTTPError, HucomsTransportError
from .models import HttpResponse, StreamResponse


class UrllibTransport:
    """A small urllib transport with no third-party runtime dependency."""

    def request(self, url: str, *, headers: Mapping[str, str], timeout: float) -> HttpResponse:
        request = urllib.request.Request(url, headers=dict(headers), method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return HttpResponse(
                    status=response.status,
                    reason=response.reason or "",
                    headers=dict(response.headers.items()),
                    body=response.read(),
                    url=url,
                )
        except urllib.error.HTTPError as exc:
            raise HucomsHTTPError(exc.code, exc.reason or "") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise HucomsTransportError(str(exc)) from exc

    def open(self, url: str, *, headers: Mapping[str, str], timeout: float) -> StreamResponse:
        request = urllib.request.Request(url, headers=dict(headers), method="GET")
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            raise HucomsHTTPError(exc.code, exc.reason or "") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise HucomsTransportError(str(exc)) from exc
        return StreamResponse(
            status=response.status,
            reason=response.reason or "",
            headers=dict(response.headers.items()),
            stream=response,
            url=url,
        )
