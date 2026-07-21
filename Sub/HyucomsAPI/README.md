# Hucoms Camera API

휴컴스 카메라 HTTP API Version 1.22를 Python 표준 라이브러리만으로 호출하는 독립 클라이언트입니다.
`Sub/HyucomsAPI` 폴더를 통째로 복사해 사용할 수 있으며, 실제 카메라와 같은 네트워크에 연결된 Python 3.10 이상이면 됩니다.

## 빠른 시작

```python
import datetime
from hyucoms_api import HucomsCameraClient

camera = HucomsCameraClient(
    host="192.168.1.30",
    username="admin",
    password="admin",
    timeout=10,
)

print(camera.get_server_name().as_dict())
camera.set_color(bright=60, contrast=55, saturation=70)
camera.set_day_night("auto", interval=5, irlink=True)
camera.set_server_date(datetime.datetime.now())

with open("snapshot.jpg", "wb") as output:
    output.write(camera.get_jpeg())

for frame in camera.iter_mjpeg(source="input1", refresh=0):
    # 원하는 시점에 break하면 HTTP stream이 닫힙니다.
    process(frame)
```

패키지를 설치하지 않고 실행할 때는 `Sub/HyucomsAPI`의 부모 경로를 `PYTHONPATH`에 추가하면 됩니다. 프로젝트에 패키지로 설치하려면 해당 폴더에서 `python -m pip install .`을 실행합니다.

## 기능 카탈로그

`HucomsCameraClient`는 PDF에 정의된 다음 기능을 모두 제공합니다.

- 시스템: `get_server_name`, `set_server_name`, `get_server_date`, `set_server_date`, `get_mac`, `reboot`, `factory_reset`, `factory_reset_keep_network`, `set_web_port`, `get_language`, `set_language`, `get_ip_config`, `set_ip_config`, `get_dns`, `set_dns`, `get_model_name`, `get_version_info`
- 이벤트: `get_alarm_input`, `set_alarm_input`, `get_alarm_output`, `set_alarm_output`, `get_motion`, `set_motion`, `get_record_event`, `set_record_event`
- 카메라: `get/set_day_night`, `get/set_color`, `get/set_night_color`, `get_image_capabilities`, `get/set_white_balance`, `get/set_wdr`, `get/set_effect`, `get/set_slow_shutter`, `get/set_shutter_speed`, `get/set_dnr`, `get/set_defog`
- 스트림: `set_http_api`, `get/set_osd`, `get/set_privacy`, `get/set_tv_out`, `get_video`, `set_video`, `set_video_encoder`, `get_max_video_size`, `get/set_audio`, `get/set_rtsp`, `get_connection_info`
- 이벤트/영상: `get_events`, `iter_events`, `set_alarm_output_state`, `get_jpeg`, `iter_mjpeg`
- PTZ: `get/set_ptz_status`, `reset_lens`, `go_ptzf_position`, `get_ptzf_position`, `move_pan_tilt`, `one_push_focus`, `move_zoom_focus`, `set/go/clear_preset`, `auto_pan`, `auto_pan_cw`, `auto_pan_ccw`, `center_ptz`
- 통합/Capability: `get_system_info_1/2/3`, `get_capabilities_video_all/video/video_codec/resolution/framerate/bitrate/quality`, `get_capabilities_audio_all/audio/audio_codec`, `get_capabilities_ptz_all/ptz`

함수명과 PDF의 CGI endpoint/action/query 매핑은 [HUCOMS_API_DESIGN.md](HUCOMS_API_DESIGN.md)에 정리되어 있습니다. 문서에 없는 모델별 확장 필드는 대부분의 `set_*` 함수에 `**fields`로 전달할 수 있고, 저수준 호출은 다음처럼 사용할 수 있습니다.

```python
camera.request(
    "/cgi-bin/control/servername.cgi",
    {"action": "getservername"},
)
```

## 응답과 예외

설정/조회 응답은 `ParsedResponse`입니다.

```python
result = camera.get_capabilities_video_all()
print(result.values)      # 평탄화된 key/value
print(result.sections)    # [Capabilities Video] 등 섹션별 값
print(result.raw_text)    # 카메라 원문
```

`HucomsTransportError`(통신), `HucomsHTTPError`(HTTP 상태), `HucomsResponseError`(카메라 `Error:`), `HucomsValidationError`(호출 전 인자 오류), `HucomsStreamError`(multipart 오류)를 구분합니다. 비밀번호는 예외 메시지나 내부 URL 표시용 문자열에 포함하지 않습니다.

## 운영 주의

- PDF API는 기본적으로 `http://`의 query에 `id`와 `passwd`를 넣습니다. 신뢰된 내부망에서 사용하세요.
- `reboot`, `factory_reset`, `set_ip_config`, `set_web_port`는 장비 연결을 끊을 수 있습니다.
- PTZ/영상 codec/오디오 등은 모델별 지원 여부가 다릅니다. 먼저 capability 함수로 확인하세요.
- `iter_mjpeg`와 `iter_events`는 스트리밍 iterator입니다. 종료 시 `break`하면 response가 닫힙니다.

## 테스트

실제 카메라 없이 fake transport로 실행합니다.

```text
python -m unittest discover -s tests -v
```
