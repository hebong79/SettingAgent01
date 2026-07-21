"""Exception types for the Hucoms camera client."""


class HucomsError(Exception):
    """Base class for all Hucoms client errors."""


class HucomsTransportError(HucomsError):
    """A connection, DNS, timeout, or other transport failure."""


class HucomsHTTPError(HucomsError):
    """The camera returned a non-success HTTP status."""

    def __init__(self, status: int, reason: str = "") -> None:
        self.status = status
        self.reason = reason
        detail = f"HTTP {status}"
        if reason:
            detail += f": {reason}"
        super().__init__(detail)


class HucomsResponseError(HucomsError):
    """The camera returned an application-level ``Error: ...`` response."""

    def __init__(self, message: str, *, response: object | None = None) -> None:
        self.message = message
        self.response = response
        super().__init__(message)


class HucomsValidationError(HucomsError, ValueError):
    """An argument is outside the range or format documented by Hucoms."""


class HucomsStreamError(HucomsError):
    """The camera's multipart stream is malformed."""
