"""High-level, complete wrapper around the Hucoms HTTP CGI API v1.22."""

from __future__ import annotations

import datetime as _dt
import re
from collections.abc import Iterator, Mapping
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

from .errors import HucomsHTTPError, HucomsResponseError, HucomsStreamError, HucomsValidationError
from .models import HttpResponse, ParsedResponse, StreamResponse
from .parser import iter_multipart, parse_text
from .transport import UrllibTransport


def _value(value: Any) -> str:
    if isinstance(value, bool):
        return "enable" if value else "disable"
    return str(value)


def _put(params: dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        params[key] = _value(value)


def _range(name: str, value: int, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise HucomsValidationError(f"{name} must be an integer between {low} and {high}")
    return value


def _enum(name: str, value: str, allowed: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value.lower() not in allowed:
        raise HucomsValidationError(f"{name} must be one of: {', '.join(allowed)}")
    return value.lower()


def _number(name: str, value: int, low: int, high: int) -> int:
    return _range(name, value, low, high)


def _indexed(name: str, number: int, maximum: int) -> str:
    return f"{name}{_number(name, number, 1, maximum)}"


def _enabled(value: str | bool) -> str:
    return _enum("enabled", _value(value), ("enable", "disable"))


def _port(name: str, value: int) -> int:
    if value != 80 and not 3000 <= value <= 60000:
        raise HucomsValidationError(f"{name} must be 80 or between 3000 and 60000")
    return value


def _rtsp_port(name: str, value: int) -> int:
    if value != 554 and not 3000 <= value <= 60000:
        raise HucomsValidationError(f"{name} must be 554 or between 3000 and 60000")
    return value


def _ipv4(name: str, value: str) -> str:
    import ipaddress

    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise HucomsValidationError(f"{name} must be a valid IPv4 address") from exc
    if address.version != 4:
        raise HucomsValidationError(f"{name} must be an IPv4 address")
    return value


class HucomsCameraClient:
    """Easy-to-use client for cameras implementing Hucoms HTTP API v1.22.

    The optional ``transport`` argument is intentionally small: an object with
    ``request(url, headers, timeout)`` and ``open(url, headers, timeout)``
    methods can be injected for tests or an application-specific HTTP stack.
    """

    CONTROL = "/cgi-bin/control/"
    IMAGE = "/cgi-bin/image/"

    def __init__(
        self,
        host: str | None = None,
        username: str = "admin",
        password: str = "admin",
        *,
        base_url: str | None = None,
        timeout: float = 10.0,
        transport: Any | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        if not host and not base_url:
            raise HucomsValidationError("host or base_url is required")
        if timeout <= 0:
            raise HucomsValidationError("timeout must be greater than zero")
        if base_url:
            parsed = urlsplit(base_url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                raise HucomsValidationError("base_url must include http(s) scheme and host")
            self.base_url = base_url.rstrip("/")
        else:
            assert host is not None
            self.base_url = host if host.startswith(("http://", "https://")) else f"http://{host}"
            self.base_url = self.base_url.rstrip("/")
        self.username = username
        self.password = password
        self.timeout = timeout
        self.transport = transport or UrllibTransport()
        self.headers = {"Accept": "text/plain, */*", **(dict(headers or {}))}

    def _build_url(self, path: str, params: Mapping[str, Any] | None = None) -> str:
        normalized = path if path.startswith("/") else f"/{path}"
        query: dict[str, Any] = {"id": self.username, "passwd": self.password}
        query.update(dict(params or {}))
        query_string = urlencode(query, doseq=True)
        return f"{self.base_url}{normalized}?{query_string}"

    @staticmethod
    def _safe_url(url: str) -> str:
        parsed = urlsplit(url)
        query = re.sub(r"([&?]passwd=)[^&]*", r"\1***", parsed.query)
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))

    def request(
        self,
        path: str,
        params: Mapping[str, Any] | None = None,
        *,
        timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
        raw: bool = False,
    ) -> ParsedResponse | HttpResponse:
        """Call an arbitrary CGI endpoint using Hucoms authentication."""

        url = self._build_url(path, params)
        response: HttpResponse = self.transport.request(
            url, headers={**self.headers, **(dict(headers or {}))}, timeout=timeout or self.timeout
        )
        if response.status < 200 or response.status >= 300:
            raise HucomsHTTPError(response.status, response.reason)
        if raw:
            return response
        parsed = parse_text(response.body.decode("utf-8", errors="replace"))
        if parsed.message is not None:
            raise HucomsResponseError(parsed.message, response=parsed)
        return parsed

    def _control(self, script: str, action: str | None = None, **params: Any) -> ParsedResponse:
        if action is not None:
            params = {"action": action, **params}
        result = self.request(f"{self.CONTROL}{script}.cgi", params)
        assert isinstance(result, ParsedResponse)
        return result

    def _open(self, path: str, params: Mapping[str, Any] | None = None, *, timeout: float | None = None) -> StreamResponse:
        url = self._build_url(path, params)
        response: StreamResponse = self.transport.open(url, headers=self.headers, timeout=timeout or self.timeout)
        if response.status < 200 or response.status >= 300:
            response.close()
            raise HucomsHTTPError(response.status, response.reason)
        return response

    # ---------------------------- System configuration ----------------------------
    def get_server_name(self) -> ParsedResponse:
        return self._control("servername", "getservername")

    def set_server_name(self, name: str) -> ParsedResponse:
        if not name or len(name) > 10 or not re.fullmatch(r"[A-Za-z0-9]+", name):
            raise HucomsValidationError("server name must be 1-10 English letters/digits")
        return self._control("servername", "setservername", servername=name)

    def get_server_date(self) -> ParsedResponse:
        return self._control("serverdate", "getdate")

    def set_server_date(self, value: _dt.datetime | _dt.date, *, second: int | None = None) -> ParsedResponse:
        if isinstance(value, _dt.datetime):
            second = value.second if second is None else second
        elif not isinstance(value, _dt.date):
            raise HucomsValidationError("value must be datetime.date or datetime.datetime")
        second = 0 if second is None else _range("second", second, 0, 59)
        return self._control(
            "serverdate",
            "setdate",
            year=_range("year", value.year, 1970, 2031),
            month=_range("month", value.month, 1, 12),
            day=_range("day", value.day, 1, 31),
            hour=getattr(value, "hour", 0),
            minute=getattr(value, "minute", 0),
            second=second,
        )

    def get_mac(self) -> ParsedResponse:
        return self._control("servermac", "getmac")

    def reboot(self) -> ParsedResponse:
        return self._control("reboot", "setreboot")

    def factory_reset(self) -> ParsedResponse:
        return self._control("reboot", "setfactory")

    def factory_reset_keep_network(self) -> ParsedResponse:
        return self._control("reboot", "setfactoryexip")

    def set_web_port(self, port: int) -> ParsedResponse:
        return self._control("webport", "setwebport", webport=_port("webport", port))

    def get_language(self) -> ParsedResponse:
        return self._control("language", "getlang")

    def set_language(self, language: str) -> ParsedResponse:
        language = _enum("language", language, ("english", "korean", "polish", "russian", "persian"))
        return self._control("language", "setlang", language=language)

    def get_ip_config(self) -> ParsedResponse:
        return self._control("netset", "getip")

    def set_ip_config(
        self,
        mode: str,
        *,
        ip_address: str | None = None,
        netmask: str | None = None,
        gateway: str | None = None,
    ) -> ParsedResponse:
        mode = _enum("mode", mode, ("static", "dhcp"))
        params: dict[str, Any] = {"mode": mode}
        for key, value in (("ipaddress", ip_address), ("netmask", netmask), ("gateway", gateway)):
            if value is not None:
                params[key] = _ipv4(key, value)
        return self._control("netset", "setip", **params)

    def get_dns(self) -> ParsedResponse:
        return self._control("dnsset", "getdns")

    def set_dns(self, first: str, second: str | None = None) -> ParsedResponse:
        params = {"firstdns": _ipv4("firstdns", first)}
        if second is not None:
            params["seconddns"] = _ipv4("seconddns", second)
        return self._control("dnsset", "setdns", **params)

    def get_model_name(self) -> ParsedResponse:
        return self._control("servermodel", "getservermodel")

    def get_version_info(self) -> ParsedResponse:
        return self._control("versioninfo", "getversioninfo")

    # ------------------------------ Event configuration ---------------------------
    def get_alarm_input(self, number: int = 1) -> ParsedResponse:
        item = _indexed("alarmin", number, 16)
        return self._control("alarmin", f"get{item}")

    def set_alarm_input(
        self,
        number: int = 1,
        *,
        all_status: str | bool | None = None,
        enabled: str | bool | None = None,
        name: str | None = None,
        input_type: str | None = None,
        **fields: Any,
    ) -> ParsedResponse:
        item = _indexed("alarmin", number, 16)
        params = dict(fields)
        _put(params, "allstatus", _enabled(all_status) if all_status is not None else None)
        _put(params, f"{item}.enable", _enabled(enabled) if enabled is not None else None)
        _put(params, f"{item}.name", name)
        if input_type is not None:
            params[f"{item}.type"] = _enum("input_type", input_type, ("nc", "no"))
        return self._control("alarmin", f"set{item}", **params)

    def get_alarm_output(self, number: int = 0) -> ParsedResponse:
        item = _indexed("alarmout", number, 16) if number else "alarmout0"
        return self._control("alarmout", f"get{item}")

    def set_alarm_output(
        self,
        number: int = 1,
        *,
        all_status: str | bool | None = None,
        enabled: str | bool | None = None,
        name: str | None = None,
        link: int | None = None,
        duration: int | None = None,
        **fields: Any,
    ) -> ParsedResponse:
        item = _indexed("alarmout", number, 16)
        params = dict(fields)
        _put(params, "allstatus", _enabled(all_status) if all_status is not None else None)
        _put(params, f"{item}.enable", _enabled(enabled) if enabled is not None else None)
        _put(params, f"{item}.name", name)
        if link is not None:
            params[f"{item}.link"] = _range("link", link, 0, 7)
        if duration is not None and duration != 1:
            _range("duration", duration, 5, 180)
        elif duration is not None:
            params[f"{item}.time"] = duration
        if duration is not None and duration != 1:
            params[f"{item}.time"] = duration
        return self._control("alarmout", f"set{item}", **params)

    def get_motion(self, number: int = 1, *, size: str | None = None) -> ParsedResponse:
        item = _indexed("motion", number, 16)
        params = {f"{item}.size": size} if size else {}
        return self._control("motion", f"get{item}", **params)

    def set_motion(
        self,
        number: int = 1,
        *,
        all_status: str | bool | None = None,
        duration: int | None = None,
        timeoff: int | None = None,
        enabled: str | bool | None = None,
        name: str | None = None,
        level: int | None = None,
        size: str | None = None,
        areas: Mapping[int, int] | None = None,
        **fields: Any,
    ) -> ParsedResponse:
        item = _indexed("motion", number, 16)
        params = dict(fields)
        _put(params, "allstatus", _enabled(all_status) if all_status is not None else None)
        if duration is not None:
            params["mdduration"] = _range("duration", duration, 0, 10)
        if timeoff is not None:
            params["mdtimeoff"] = _range("timeoff", timeoff, 1, 2)
        _put(params, f"{item}.enable", _enabled(enabled) if enabled is not None else None)
        _put(params, f"{item}.name", name)
        if level is not None:
            params[f"{item}.level"] = _range("level", level, 1, 5)
        _put(params, f"{item}.size", size)
        if areas:
            for area, mask in areas.items():
                params[f"{item}.area{_range('area number', area, 1, 18)}"] = _range("area mask", mask, 0, 0xFFFFFF)
        return self._control("motion", f"set{item}", **params)

    def get_record_event(self) -> ParsedResponse:
        return self._control("recordevent", "getrecevent")

    def set_record_event(
        self,
        *,
        status: str | bool | None = None,
        stream_id: str | None = None,
        link: int | None = None,
        save: int | None = None,
        time_previous: int | None = None,
        time_next: int | None = None,
        max_size: int | None = None,
        **fields: Any,
    ) -> ParsedResponse:
        params = dict(fields)
        _put(params, "record.status", _enabled(status) if status is not None else None)
        if stream_id is not None:
            params["record.streamid"] = _enum("stream_id", stream_id, ("stream1", "stream2", "stream3"))
        if link is not None:
            params["record.link"] = _range("link", link, 0, 7)
        if save is not None:
            params["record.save"] = _range("save", save, 0, 3)
        if time_previous is not None:
            params["record.timeprev"] = _range("time_previous", time_previous, 0, 5)
        if time_next is not None:
            params["record.timenext"] = _range("time_next", time_next, 5, 30)
        if max_size is not None:
            params["record.maxsize"] = _range("max_size", max_size, 4096, 10240)
        return self._control("recordevent", "setrecevent", **params)

    # -------------------------------- Camera configuration ------------------------
    def get_day_night(self) -> ParsedResponse:
        return self._control("camdaynight", "getdaynight")

    def set_day_night(self, mode: str, *, interval: int | None = None, ptn: int | None = None, ptd: int | None = None, irlink: str | bool | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        params["mode"] = _enum("mode", mode, ("day", "night", "auto", "lpr"))
        if interval is not None:
            params["interval"] = _range("interval", interval, 1, 200)
        if ptn is not None:
            params["ptn"] = _range("ptn", ptn, 1, 990)
        if ptd is not None:
            params["ptd"] = _range("ptd", ptd, 1, 990)
        if ptn is not None and ptd is not None and ptn < ptd:
            raise HucomsValidationError("ptn must be greater than or equal to ptd")
        _put(params, "irlink", _enabled(irlink) if irlink is not None else None)
        return self._control("camdaynight", "setdaynight", **params)

    def get_color(self) -> ParsedResponse:
        return self._control("camcolor", "getcolor")

    def set_color(self, *, bright: int | None = None, contrast: int | None = None, saturation: int | None = None, sharp: int | None = None, edge: int | None = None, hue: int | None = None, night: bool = False, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        for key, value in (("bright", bright), ("contrast", contrast), ("saturation", saturation), ("sharp", sharp), ("edge", edge), ("hue", hue)):
            if value is not None:
                params[key] = _range(key, value, 1, 100)
        return self._control("camcolor", "setncolor" if night else "setcolor", **params)

    def get_night_color(self) -> ParsedResponse:
        return self._control("camcolor", "getncolor")

    def set_night_color(self, **fields: Any) -> ParsedResponse:
        """Set the night color profile (the PDF calls this ``setncolor``)."""

        return self.set_color(night=True, **fields)

    def get_image_capabilities(self) -> ParsedResponse:
        return self._control("camcolor", "getCapabilitiesImage")

    def get_white_balance(self) -> ParsedResponse:
        return self._control("camwhitebal", "getwb")

    def set_white_balance(self, mode: str, *, user_red: int | None = None, user_blue: int | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        params["mode"] = _enum("mode", mode, ("auto", "indoor", "outdoor", "fluorescent", "user", "push", "autoindoor"))
        if user_red is not None:
            params["userred"] = _range("user_red", user_red, 1, 100)
        if user_blue is not None:
            params["userblue"] = _range("user_blue", user_blue, 1, 100)
        return self._control("camwhitebal", "setwb", **params)

    def get_wdr(self) -> ParsedResponse:
        return self._control("camwdr", "getwdr")

    def set_wdr(self, status: str | bool, mode: str, *, compensation_mode: str | None = None, dwdr_mode: str | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        params["wdrstatus"] = _enabled(status)
        params["mode"] = _enum("mode", mode, ("compensation", "dwdr"))
        if compensation_mode is not None:
            params["compensationmode"] = _enum("compensation_mode", compensation_mode, ("front", "back"))
        if dwdr_mode is not None:
            params["dwdrmode"] = _enum("dwdr_mode", dwdr_mode, ("step1", "step2", "step3", "step4", "step5"))
        return self._control("camwdr", "setwdr", **params)

    def get_effect(self) -> ParsedResponse:
        return self._control("cameffect", "geteffect")

    def set_effect(self, *, colorbar: str | bool | None = None, mono_image: str | bool | None = None, negative: str | bool | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        _put(params, "colorbar", _enabled(colorbar) if colorbar is not None else None)
        _put(params, "monoimg", _enabled(mono_image) if mono_image is not None else None)
        _put(params, "negative", _enabled(negative) if negative is not None else None)
        return self._control("cameffect", "seteffect", **params)

    def get_slow_shutter(self) -> ParsedResponse:
        return self._control("camslowshut", "getslowsh")

    def set_slow_shutter(self, status: str | bool, value: int, **fields: Any) -> ParsedResponse:
        return self._control("camslowshut", "setslowsh", slowshutstatus=_enabled(status), slowshutter=_range("value", value, 1, 100), **fields)

    def get_shutter_speed(self) -> ParsedResponse:
        return self._control("camshutspeed", "getshutterspd")

    def set_shutter_speed(self, mode: str, *, max_exposure: int | None = None, suppress: str | None = None, shutter_speed: int | None = None, agc_value: int | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        params["shutmode"] = _enum("mode", mode, ("auto", "suppressroll", "user"))
        if max_exposure is not None:
            params["maxexposure"] = _range("max_exposure", max_exposure, 1, 6)
        if suppress is not None:
            params["suppress"] = _enum("suppress", suppress, ("week", "strong"))
        if shutter_speed is not None:
            params["shutspeed"] = _range("shutter_speed", shutter_speed, 1, 9)
        if agc_value is not None:
            params["agcvalue"] = _range("agc_value", agc_value, 1, 100)
        return self._control("camshutspeed", "setshutterspd", **params)

    def get_dnr(self) -> ParsedResponse:
        return self._control("camdnr", "getdnr")

    def set_dnr(self, status: str | bool, mode: str, *, value: int | None = None, dynamic: str | bool | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        params["dnstatus"] = _enabled(status)
        params["mode"] = _enum("mode", mode, ("dnr2d", "dnr3d"))
        if value is not None:
            params["dnrvalue"] = _range("value", value, 1, 100)
        _put(params, "dynamic", _enabled(dynamic) if dynamic is not None else None)
        return self._control("camdnr", "setdnr", **params)

    def get_defog(self) -> ParsedResponse:
        return self._control("camdefog", "getdefog")

    def set_defog(self, enabled: str | bool, mode: str, *, value: int | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        params["defogen"] = _enabled(enabled)
        params["mode"] = _enum("mode", mode, ("auto", "manual"))
        if value is not None:
            params["defogvalue"] = _range("value", value, 1, 100)
        return self._control("camdefog", "setdefog", **params)

    # -------------------------------- Stream configuration ------------------------
    def set_http_api(self, enabled: str | bool) -> ParsedResponse:
        return self._control("httpapi", "setapi", apictrlstatus=_enabled(enabled))

    def get_osd(self) -> ParsedResponse:
        return self._control("osd", "getosd")

    def set_osd(self, *, status: str | bool | None = None, text_on: str | bool | None = None, text: str | None = None, date_on: str | bool | None = None, date_type: str | None = None, time_on: str | bool | None = None, event_on: str | bool | None = None, event_day_night_on: str | bool | None = None, event_motion_on: str | bool | None = None, event_sensor_on: str | bool | None = None, event_relay_on: str | bool | None = None, event_shock_on: str | bool | None = None, font: str | None = None, size: str | None = None, color: str | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        for key, value in (("osdstatus", status), ("texton", text_on), ("dateon", date_on), ("timeon", time_on), ("eventon", event_on), ("eventdnon", event_day_night_on), ("eventmdon", event_motion_on), ("eventsenson", event_sensor_on), ("eventrelayon", event_relay_on), ("eventshock", event_shock_on)):
            _put(params, key, _enabled(value) if value is not None else None)
        _put(params, "textstr", text)
        if date_type is not None:
            params["datetype"] = _enum("date_type", date_type, ("yyyy-mm-dd", "dd-mm-yyyy", "mm-dd-yyyy", "year, month, day"))
        if font is not None:
            params["osdfont"] = _enum("font", font, ("english",))
        if size is not None:
            params["osdsize"] = _enum("size", size, ("big", "small"))
        if color is not None:
            params["osdcolor"] = color
        return self._control("osd", "setosd", **params)

    def get_privacy(self, number: int = 1) -> ParsedResponse:
        item = _indexed("privacy", number, 16)
        return self._control("privacy", f"get{item}")

    def set_privacy(self, number: int = 1, *, all_status: str | bool | None = None, enabled: str | bool | None = None, color: int | None = None, start_x: int | None = None, start_y: int | None = None, end_x: int | None = None, end_y: int | None = None, **fields: Any) -> ParsedResponse:
        item = _indexed("privacy", number, 16)
        params = dict(fields)
        _put(params, "allstatus", _enabled(all_status) if all_status is not None else None)
        _put(params, f"{item}.enable", _enabled(enabled) if enabled is not None else None)
        if color is not None:
            params[f"{item}.color"] = _range("color", color, 1, 8)
        for key, value, high in (("startx", start_x, 319), ("starty", start_y, 239), ("endx", end_x, 320), ("endy", end_y, 240)):
            if value is not None:
                params[f"{item}.{key}"] = _range(key, value, 0 if key.startswith("start") else 1, high)
        return self._control("privacy", f"set{item}", **params)

    def get_tv_out(self) -> ParsedResponse:
        return self._control("tvout", "gettvout")

    def set_tv_out(self, enabled: str | bool, tv_type: str, **fields: Any) -> ParsedResponse:
        return self._control("tvout", "settvout", tvoutstatus=_enabled(enabled), tvtype=_enum("tv_type", tv_type, ("ntsc", "pal")), **fields)

    def get_video(self) -> ParsedResponse:
        return self._control("videoset", "getvideo")

    def get_max_video_size(self) -> ParsedResponse:
        return self._control("videoset", "getmaxsize")

    def set_video(self, *, video_flip: str | None = None, captures: Mapping[int, Mapping[str, Any]] | None = None, encoders: Mapping[int, Mapping[str, Any]] | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        if video_flip is not None:
            params["videoflip"] = _enum("video_flip", video_flip, ("normal", "mirror", "flip", "both"))
        for number, capture in (captures or {}).items():
            prefix = _indexed("capture", number, 3)
            for key, value in capture.items():
                params[f"{prefix}.{key}"] = _value(value)
        for number, encoder in (encoders or {}).items():
            prefix = _indexed("encoder", number, 3)
            for key, value in encoder.items():
                params[f"{prefix}.{key}"] = _value(value)
        # A setvideo# request changes one encoder; send one request per supplied encoder.
        if encoders:
            result: ParsedResponse | None = None
            for number in encoders:
                result = self._control("videoset", f"setvideo{_number('encoder', number, 1, 3)}", **params)
            assert result is not None
            return result
        return self._control("videoset", "setvideo1", **params)

    def set_video_encoder(self, number: int, **fields: Any) -> ParsedResponse:
        prefix = _indexed("encoder", number, 3)
        return self._control("videoset", f"setvideo{number}", **{f"{prefix}.{key}": value for key, value in fields.items()})

    def get_audio(self) -> ParsedResponse:
        return self._control("audioset", "getaudio")

    def set_audio(self, *, codec: str | None = None, input_enabled: str | bool | None = None, input_gain: int | None = None, output_enabled: str | bool | None = None, output_gain: int | None = None, sampling: int | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        if codec is not None:
            params["audiocodec"] = _enum("codec", codec, ("ulaw", "alaw"))
        _put(params, "audioinenable", _enabled(input_enabled) if input_enabled is not None else None)
        _put(params, "audiooutenable", _enabled(output_enabled) if output_enabled is not None else None)
        if input_gain is not None:
            params["audioingain"] = _range("input_gain", input_gain, 1, 100)
        if output_gain is not None:
            params["audiooutgain"] = _range("output_gain", output_gain, 1, 100)
        if sampling is not None:
            params["audiosampling"] = _enum("sampling", str(sampling), ("8000", "16000"))
        return self._control("audioset", "setaudio", **params)

    def get_rtsp(self) -> ParsedResponse:
        return self._control("rtspset", "getrtsp")

    def set_rtsp(self, *, rtsp_port: int | None = None, rtp_port_start: int | None = None, rtp_port_end: int | None = None, rtcp_enabled: str | bool | None = None, time_limit: int | None = None, multicast_enabled: str | bool | None = None, multicast_ttl: int | None = None, multicast_video_ip: str | None = None, multicast_video_port: int | None = None, multicast_audio_ip: str | None = None, multicast_audio_port: int | None = None, authority_enabled: str | bool | None = None, **fields: Any) -> ParsedResponse:
        params = dict(fields)
        if rtsp_port is not None:
            params["rtspport"] = _rtsp_port("rtsp_port", rtsp_port)
        if rtp_port_start is not None or rtp_port_end is not None:
            if rtp_port_start is None or rtp_port_end is None:
                raise HucomsValidationError("rtp_port_start and rtp_port_end must be provided together")
            params["rtpport"] = f"{_port('rtp_port_start', rtp_port_start)},{_port('rtp_port_end', rtp_port_end)}"
        for key, value in (("rtcpenable", rtcp_enabled), ("multicastenable", multicast_enabled), ("authorityenable", authority_enabled)):
            _put(params, key, _enabled(value) if value is not None else None)
        if time_limit is not None and time_limit not in (0,) and not 60 <= time_limit <= 300:
            raise HucomsValidationError("time_limit must be 0 or between 60 and 300")
        _put(params, "rtsptimelimit", time_limit)
        if multicast_ttl is not None:
            params["multicastttl"] = _range("multicast_ttl", multicast_ttl, 1, 128)
        for key, value in (("multicastvideoip", multicast_video_ip), ("multicastaudioip", multicast_audio_ip)):
            if value is not None:
                address = _ipv4(key, value)
                if not 224 <= int(address.split(".")[0]) <= 239:
                    raise HucomsValidationError(f"{key} must be a class-D multicast IPv4 address")
                params[key] = address
        for key, value in (("multicastvideoport", multicast_video_port), ("multicastaudioport", multicast_audio_port)):
            if value is not None:
                params[key] = _port(key, value)
        return self._control("rtspset", "setrtsp", **params)

    def get_connection_info(self, stream: str = "all") -> ParsedResponse:
        stream = _enum("stream", stream, ("all", "stream1", "stream2", "stream3"))
        return self._control("connectinfo", "getconnect", stream=stream)

    # -------------------------------- Events, relay, image ------------------------
    def get_events(self, event_type: str = "all") -> ParsedResponse | list[ParsedResponse]:
        event_type = _enum("event_type", event_type, ("alarmin", "alarmout", "motion", "videotamper", "audiodetect_high", "audiodetect_low", "audiodetect_warning_high", "audiodetect_warning_low", "all"))
        result = self.request(f"{self.CONTROL}requestevent.cgi", {"action": "getevent", "eventtype": event_type}, headers={"Accept": "multipart/x-mixed-replace, text/plain"}, raw=True)
        assert isinstance(result, HttpResponse)
        content_type = next((v for k, v in result.headers.items() if k.lower() == "content-type"), "")
        if "multipart" in content_type.lower():
            return [parse_text(part.decode("utf-8", errors="replace")) for part in iter_multipart(result.body, content_type)]
        parsed = parse_text(result.body.decode("utf-8", errors="replace"))
        if parsed.message:
            raise HucomsResponseError(parsed.message, response=parsed)
        return parsed

    def iter_events(self, event_type: str = "all", *, timeout: float | None = None) -> Iterator[ParsedResponse]:
        event_type = _enum("event_type", event_type, ("alarmin", "alarmout", "motion", "videotamper", "audiodetect_high", "audiodetect_low", "audiodetect_warning_high", "audiodetect_warning_low", "all"))
        response = self._open(f"{self.CONTROL}requestevent.cgi", {"action": "getevent", "eventtype": event_type}, timeout=timeout)
        try:
            for payload in self._iter_stream_parts(response):
                parsed = parse_text(payload.decode("utf-8", errors="replace"))
                if parsed.message:
                    raise HucomsResponseError(parsed.message, response=parsed)
                yield parsed
        finally:
            response.close()

    def set_alarm_output_state(self, number: int = 1, state: str | bool = "off") -> ParsedResponse:
        item = _indexed("alarmout", number, 16)
        return self._control("ctrl_alarmout", "setalarmout", **{item: _enum("state", _value(state), ("on", "off"))})

    def get_jpeg(self, *, timeout: float | None = None) -> bytes:
        result = self.request(f"{self.IMAGE}jpeg.cgi", raw=True, timeout=timeout)
        assert isinstance(result, HttpResponse)
        content_type = next((v for k, v in result.headers.items() if k.lower() == "content-type"), "")
        parsed = parse_text(result.body.decode("utf-8", errors="replace")) if "image" not in content_type.lower() else None
        if parsed and parsed.message:
            raise HucomsResponseError(parsed.message, response=parsed)
        return result.body

    def iter_mjpeg(self, *, source: str | None = None, refresh: int | None = None, timeout: float | None = None) -> Iterator[bytes]:
        params: dict[str, Any] = {}
        if source is not None:
            params["source"] = _enum("source", source, ("input1", "input2"))
        if refresh is not None:
            params["refresh"] = _range("refresh", refresh, 0, 300)
        response = self._open(f"{self.IMAGE}mjpeg.cgi", params, timeout=timeout)
        try:
            yield from self._iter_stream_parts(response)
        finally:
            response.close()

    @staticmethod
    def _iter_stream_parts(response: StreamResponse) -> Iterator[bytes]:
        content_type = next((v for k, v in response.headers.items() if k.lower() == "content-type"), "")
        match = re.search(r"boundary\s*=\s*(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.I)
        if not match:
            raise HucomsStreamError("multipart stream has no boundary")
        boundary = b"--" + (match.group(1) or match.group(2)).encode("utf-8")
        buffer = b""
        stream = response.stream
        while True:
            chunk = stream.read(65536)
            if not chunk:
                return
            buffer += chunk
            while True:
                start = buffer.find(boundary)
                if start < 0:
                    buffer = buffer[-len(boundary) :]
                    break
                buffer = buffer[start + len(boundary) :]
                if buffer.startswith(b"--"):
                    return
                buffer = buffer.lstrip(b"\r\n")
                header_end = buffer.find(b"\r\n\r\n")
                separator_len = 4
                if header_end < 0:
                    header_end = buffer.find(b"\n\n")
                    separator_len = 2
                if header_end < 0:
                    break
                header_text = buffer[:header_end].decode("latin-1", errors="replace")
                length_match = re.search(r"^content-length\s*:\s*(\d+)\s*$", header_text, re.I | re.M)
                if length_match:
                    length = int(length_match.group(1))
                    if len(buffer) < header_end + separator_len + length:
                        break
                    begin = header_end + separator_len
                    payload = buffer[begin : begin + length]
                    buffer = buffer[begin + length :]
                    yield payload
                else:
                    begin = header_end + separator_len
                    next_boundary = buffer.find(boundary, begin)
                    if next_boundary < 0:
                        break
                    yield buffer[begin:next_boundary].rstrip(b"\r\n")
                    buffer = buffer[next_boundary:]

    # -------------------------------- PTZ -----------------------------------------
    def get_ptz_status(self) -> ParsedResponse:
        return self._control("ptzf_status", "getptzstatus")

    def set_ptz_status(self, *, pan_tilt: str | bool | None = None, zoom_focus: str | bool | None = None) -> ParsedResponse:
        params: dict[str, Any] = {}
        _put(params, "ptstatus", _enabled(pan_tilt) if pan_tilt is not None else None)
        _put(params, "zfstatus", _enabled(zoom_focus) if zoom_focus is not None else None)
        return self._control("ptzf_status", "setptzstatus", **params)

    def reset_lens(self) -> ParsedResponse:
        return self._control("ptzf_status", "lensreset")

    def go_ptzf_position(self, *, pan: int | None = None, tilt: int | None = None, zoom: int | None = None, focus: int | None = None, pan_speed: int = 0, tilt_speed: int = 0, zoom_speed: int = 0, focus_speed: int = 0) -> ParsedResponse:
        params: dict[str, Any] = {}
        for key, value, low, high in (("panpos", pan, 0, 35999), ("tiltpos", tilt, -2000, 9000), ("zoompos", zoom, 0, 65535), ("focuspos", focus, 0, 65535)):
            if value is not None:
                params[key] = _range(key, value, low, high)
        for key, value in (("panspeed", pan_speed), ("tiltspeed", tilt_speed), ("zoomspeed", zoom_speed), ("focusspeed", focus_speed)):
            params[key] = _range(key, value, 0, 100)
        return self._control("ptzf_status", "goptzfpos", **params)

    def get_ptzf_position(self) -> ParsedResponse:
        return self._control("ptzf_status", "getptzfpos")

    def move_pan_tilt(self, *, pan: str | None = None, tilt: str | None = None, pan_speed: int | None = None, tilt_speed: int | None = None) -> ParsedResponse:
        params: dict[str, Any] = {}
        if pan is not None:
            params["pan"] = _enum("pan", pan, ("right", "left", "stop"))
        if tilt is not None:
            params["tilt"] = _enum("tilt", tilt, ("up", "down", "stop"))
        if pan_speed is not None:
            params["panspeed"] = _range("pan_speed", pan_speed, 1, 100)
        if tilt_speed is not None:
            params["tiltspeed"] = _range("tilt_speed", tilt_speed, 1, 100)
        return self._control("pt_control", "setptmove", **params)

    def one_push_focus(self) -> ParsedResponse:
        return self._control("zf_control", "onepush")

    def move_zoom_focus(self, *, zoom: str | None = None, focus: str | None = None, zoom_speed: int | None = None, focus_speed: int | None = None) -> ParsedResponse:
        params: dict[str, Any] = {}
        if zoom is not None:
            params["zoom"] = _enum("zoom", zoom, ("in", "out", "stop"))
        if focus is not None:
            params["focus"] = _enum("focus", focus, ("in", "out", "stop"))
        if zoom_speed is not None:
            params["zoomspeed"] = _range("zoom_speed", zoom_speed, 1, 100)
        if focus_speed is not None:
            params["focusspeed"] = _range("focus_speed", focus_speed, 1, 100)
        return self._control("zf_control", "setzfmove", **params)

    def set_preset(self, number: int) -> ParsedResponse:
        return self._control("preset_control", "setpreset", number=_range("number", number, 1, 255))

    def go_preset(self, number: int) -> ParsedResponse:
        return self._control("preset_control", "gopreset", number=_range("number", number, 1, 255))

    def clear_preset(self, number: int) -> ParsedResponse:
        return self._control("preset_control", "clearpreset", number=_range("number", number, 1, 255))

    def auto_pan(self, point_a: int, point_b: int, speed: int) -> ParsedResponse:
        return self._control("preset_control", "autopan", pos_a=_range("point_a", point_a, 1, 255), pos_b=_range("point_b", point_b, 1, 255), speed=_range("speed", speed, 1, 255))

    def auto_pan_cw(self, speed: int) -> ParsedResponse:
        return self._control("preset_control", "autopan_cw", speed=_range("speed", speed, 1, 255))

    def auto_pan_ccw(self, speed: int) -> ParsedResponse:
        return self._control("preset_control", "autopan_ccw", speed=_range("speed", speed, 1, 255))

    def center_ptz(self, *, kind: str, speed: int | None = None, start_x: int | None = None, start_y: int | None = None, end_x: int | None = None, end_y: int | None = None, point_x: int | None = None, point_y: int | None = None) -> ParsedResponse:
        kind = _enum("kind", kind, ("box", "point"))
        params: dict[str, Any] = {"type": kind}
        if speed is not None:
            params["speed"] = _range("speed", speed, 1, 100)
        for key, value, high in (("center.startx", start_x, 1920), ("center.starty", start_y, 1080), ("center.endx", end_x, 1920), ("center.endy", end_y, 1080), ("center.pointx", point_x, 1920), ("center.pointy", point_y, 1080)):
            if value is not None:
                params[key] = _range(key, value, 0, high)
        if kind == "box":
            if start_x is None or start_y is None or end_x is None or end_y is None:
                raise HucomsValidationError("box centering requires start_x, start_y, end_x, and end_y")
            if start_x > end_x or start_y > end_y:
                raise HucomsValidationError("box start coordinates must not exceed end coordinates")
        elif point_x is None or point_y is None:
            raise HucomsValidationError("point centering requires point_x and point_y")
        return self._control("ptz_centering", "setcenter", **params)

    # ------------------------------ Unified/capabilities --------------------------
    def get_system_info_1(self) -> ParsedResponse:
        return self._control("serverinfo1", "getsysinfo1")

    def get_system_info_2(self) -> ParsedResponse:
        return self._control("serverinfo2", "getsysinfo2")

    def get_system_info_3(self) -> ParsedResponse:
        return self._control("serverinfo3", "getsysinfo3")

    def get_capabilities_video_all(self) -> ParsedResponse:
        return self._control("capabilityvideo", "getCapabilitiesVideoAll")

    def get_capabilities_video(self) -> ParsedResponse:
        return self._control("capabilityvideo", "getVideo")

    def get_capabilities_video_codec(self) -> ParsedResponse:
        return self._control("capabilityvideo", "getVideoCodec")

    def get_capabilities_resolution(self) -> ParsedResponse:
        return self._control("capabilityvideo", "getResolution")

    def get_capabilities_framerate(self) -> ParsedResponse:
        return self._control("capabilityvideo", "getFramerate")

    def get_capabilities_bitrate(self) -> ParsedResponse:
        return self._control("capabilityvideo", "getBitrate")

    def get_capabilities_quality(self) -> ParsedResponse:
        return self._control("capabilityvideo", "getQuality")

    def get_capabilities_audio_all(self) -> ParsedResponse:
        return self._control("capabilityaudio", "getCapabilitiesAudioAll")

    def get_capabilities_audio(self) -> ParsedResponse:
        return self._control("capabilityaudio", "getAudio")

    def get_capabilities_audio_codec(self) -> ParsedResponse:
        return self._control("capabilityaudio", "getAudioCodec")

    def get_capabilities_ptz_all(self) -> ParsedResponse:
        return self._control("capabilityptz", "getCapabilitiesPTZAll")

    def get_capabilities_ptz(self) -> ParsedResponse:
        return self._control("capabilityptz", "getPTZ")
