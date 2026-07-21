# 휴컴스 카메라 HTTP API 설계서

- 문서명: Hucoms Camera API Client
- 기준 문서: `etc/HTTP_API_Hucoms_V1.22.pdf` (Version 1.22)
- 작성: 코덱스5.6 솔이
- 대상 경로: `Sub/HyucomsAPI`
- 목표: 휴컴스 카메라의 HTTP CGI API를 장비와 애플리케이션 사이의 독립적인 Python 클라이언트로 제공

## 1. 설계 목표

1. `Sub/HyucomsAPI` 폴더만 복사해도 사용할 수 있는 독립 패키지로 만든다.
2. PDF에 정의된 모든 기능군을 빠짐없이 함수로 노출한다.
3. 복잡한 CGI query 문자열을 사용자가 직접 만들지 않아도 되게 한다.
4. 장비의 응답이 `key = value` 형태의 text/plain임을 고려해 구조화된 Python 값으로 변환한다.
5. 모델별로 지원 여부가 다른 기능(예: PTZ, WDR, H.265)은 호출 자체는 가능하게 하되, 장비가 반환하는 오류를 일관된 예외로 전달한다.
6. 테스트 시 실제 카메라 없이도 가짜 HTTP transport로 모든 query와 parser를 검증한다.
7. 비밀번호가 URL 문자열, 로그, 예외 메시지에 노출되지 않도록 한다.

## 2. 범위

### 포함 기능

- 시스템: 서버명, 서버 날짜, MAC, 재부팅/공장 초기화, Web 포트, 언어, IP, DNS, 모델명, 펌웨어 정보
- 이벤트: Alarm Input/Output, Motion, Event Record
- 카메라: Day/Night, Color, White Balance, WDR, Effect, Slow Shutter, Shutter Speed, DNR, Defog
- 스트림: HTTP API on/off, OSD, Privacy Area, TV Out, Video, Audio, RTSP, stream 연결 정보
- 이벤트 조회 및 Relay: event polling, alarm-out on/off
- 이미지: JPEG 단일 프레임, MJPEG multipart 스트림
- PTZ: 상태/위치, Pan/Tilt 이동, Zoom/Focus 이동, Preset/Auto Pan, Centering
- Unified Command: serverinfo1/2/3
- Capability: Video 7종, Audio 3종, PTZ 2종

### 제외 또는 제한

- 카메라의 CGI가 제공하지 않는 사용자 관리, HTTPS, ONVIF SOAP, 녹화 파일 다운로드는 범위 밖이다.
- MJPEG/Event는 무한 스트림일 수 있으므로 호출자가 `iter_*` iterator를 소비하고 종료해야 한다.
- HTTP API 문서에는 모든 응답의 정확한 JSON schema가 없으므로, 응답은 일반적인 `Mapping[str, str]` 및 섹션 구조로 보존한다.

## 3. 디렉터리 및 모듈 구조

```text
Sub/HyucomsAPI/
├─ __init__.py          # 공개 API 재-export
├─ client.py             # HucomsCameraClient 및 전체 endpoint wrapper
├─ transport.py          # urllib 기반 독립 HTTP transport, response model
├─ models.py             # credential/config, 공통 enum/typed dataclass
├─ parser.py             # text/plain, 섹션, multipart parser
├─ errors.py             # 예외 계층
├─ pyproject.toml        # 표준 라이브러리만 사용하는 최소 패키지 정의
├─ README.md             # 빠른 시작 및 함수 카탈로그
├─ HUCOMS_API_DESIGN.md  # 본 설계서
└─ tests/
   ├─ test_parser.py
   └─ test_client.py
```

기본 실행 환경은 Python 3.10 이상이다. 런타임 의존성은 Python 표준 라이브러리만 사용한다.

## 4. 사용성 설계

### 생성

```python
from hyucoms_api import HucomsCameraClient

camera = HucomsCameraClient(
    host="192.168.1.30",
    username="admin",
    password="admin",
    timeout=10,
)
```

`host`는 IP 또는 hostname을 받고, `base_url`을 직접 지정하면 HTTP port가 다른 장비도 사용할 수 있다. 인증 query의 필드명은 PDF 규격대로 `id`/`passwd`를 사용한다.

### 호출 규칙

- `get_*`/`*_status`/`get_capabilities_*`: 구조화된 `ParsedResponse` 또는 `dict` 반환
- `set_*`, 동작 명령: `ParsedResponse` 반환. 응답 body가 비어 있는 PTZ 동작도 성공이면 정상 반환
- `get_jpeg`: `bytes` 반환
- `iter_mjpeg`, `iter_events`: `Iterator[bytes]` 또는 `Iterator[EventMessage]` 반환
- 모든 함수는 query를 URL 인코딩한다.
- endpoint별 저수준 호출이 필요한 경우 `request(path, params)`를 공개한다.

### 공통 옵션

`request()`에는 다음을 지원한다.

- `timeout`: 호출별 timeout override
- `headers`: 호출별 HTTP header
- `raw`: 파싱하지 않은 `HttpResponse` 필요 시 사용

기본 retry는 자동으로 하지 않는다. 카메라 설정/재부팅 API는 재시도 시 부작용이 생길 수 있으므로, 재시도가 필요하면 호출자가 명시적으로 수행한다.

## 5. 응답 및 오류 설계

휴컴스 text 응답은 다음처럼 파싱한다.

```text
[Section]
key = value
key = value * comment
Error: unsupported command
```

`ParsedResponse`는 다음 정보를 가진다.

- `values: dict[str, str]`: 마지막 key 기준 평탄화된 값
- `sections: dict[str, dict[str, str]]`: 섹션별 값
- `raw_text: str`: 원문 보존
- `message`: Error 응답이면 오류 내용

예외 계층:

- `HucomsError`: 최상위 예외
- `HucomsTransportError`: DNS, 연결, timeout 등 통신 오류
- `HucomsHTTPError`: HTTP 상태 코드 오류
- `HucomsResponseError`: HTTP 200이지만 body가 `Error:`인 장비 오류
- `HucomsValidationError`: 호출 전 로컬 인자 검증 실패
- `HucomsStreamError`: multipart 경계/스트림 형식 오류

예외에는 민감한 password를 넣지 않는다. URL을 표시해야 하면 password query는 마스킹한다.

## 6. 함수 설계 및 PDF endpoint 매핑

클라이언트는 아래의 고수준 함수를 제공한다. `get_*`와 `set_*`의 데이터 클래스는 선택 사항이며, 함수는 `**fields` 오버라이드도 허용해 모델별 확장을 수용한다.

### 6.1 System Configuration

| 함수 | CGI path | action |
|---|---|---|
| `get_server_name`, `set_server_name` | `/cgi-bin/control/servername.cgi` | `getservername`, `setservername` |
| `get_server_date`, `set_server_date` | `/cgi-bin/control/serverdate.cgi` | `getdate`, `setdate` |
| `get_mac` | `/cgi-bin/control/servermac.cgi` | `getmac` |
| `reboot`, `factory_reset`, `factory_reset_keep_network` | `/cgi-bin/control/reboot.cgi` | `setreboot`, `setfactory`, `setfactoryexip` |
| `set_web_port` | `/cgi-bin/control/webport.cgi` | `setwebport` |
| `get_language`, `set_language` | `/cgi-bin/control/language.cgi` | `getlang`, `setlang` |
| `get_ip_config`, `set_ip_config` | `/cgi-bin/control/netset.cgi` | `getip`, `setip` |
| `get_dns`, `set_dns` | `/cgi-bin/control/dnsset.cgi` | `getdns`, `setdns` |
| `get_model_name` | `/cgi-bin/control/servermodel.cgi` | `getservermodel` |
| `get_version_info` | `/cgi-bin/control/versioninfo.cgi` | `getversioninfo` |

날짜는 `datetime`을 받되, `set_server_date`는 PDF의 year/month/day/hour/minute/second query로 변환한다.

### 6.2 Event Configuration

| 함수 | CGI path | 주요 fields |
|---|---|---|
| `get_alarm_input`, `set_alarm_input` | `alarmin.cgi` | `allstatus`, `alarmin{n}.enable/name/type` |
| `get_alarm_output`, `set_alarm_output` | `alarmout.cgi` | `allstatus`, `alarmout{n}.enable/name/link/time` |
| `get_motion`, `set_motion` | `motion.cgi` | status, duration, level, size, `area1..area18` |
| `get_record_event`, `set_record_event` | `recordevent.cgi` | status, streamid, link, save, prev/next, maxsize |

`motion`은 area를 `Mapping[int, int]` 또는 개별 `area1..area18` field로 받을 수 있고, `0..0xFFFFFF` 범위를 검증한다. Alarm link/record link/save는 PDF의 bit mask를 정수로 전달한다.

### 6.3 Camera Configuration

| 함수 | CGI path | action |
|---|---|---|
| `get_day_night`, `set_day_night` | `camdaynight.cgi` | `getdaynight`, `setdaynight` |
| `get_color`, `set_color`, `get_night_color`, `set_night_color`, `get_image_capabilities` | `camcolor.cgi` | `getcolor`, `setcolor`, `getncolor`, `setncolor`, `getCapabilitiesImage` |
| `get_white_balance`, `set_white_balance` | `camwhitebal.cgi` | `getwb`, `setwb` |
| `get_wdr`, `set_wdr` | `camwdr.cgi` | `getwdr`, `setwdr` |
| `get_effect`, `set_effect` | `cameffect.cgi` | `geteffect`, `seteffect` |
| `get_slow_shutter`, `set_slow_shutter` | `camslowshut.cgi` | `getslowsh`, `setslowsh` |
| `get_shutter_speed`, `set_shutter_speed` | `camshutspeed.cgi` | `getshutterspd`, `setshutterspd` |
| `get_dnr`, `set_dnr` | `camdnr.cgi` | `getdnr`, `setdnr` |
| `get_defog`, `set_defog` | `camdefog.cgi` | `getdefog`, `setdefog` |

공통으로 enable/disable, mode enum, 숫자 범위(밝기 등 1~100)를 로컬 검증한다. 문서상 모델 선택 기능은 필수 조건을 강제하지 않고 장비 응답으로 판단한다.

### 6.4 Stream Configuration

| 함수 | CGI path | 설명 |
|---|---|---|
| `set_http_api` | `httpapi.cgi` | HTTP API enable/disable |
| `get_osd`, `set_osd` | `osd.cgi` | OSD, 날짜/시간/이벤트/text 옵션 |
| `get_privacy`, `set_privacy` | `privacy.cgi` | privacy 영역 1~16, 좌표/색상 |
| `get_tv_out`, `set_tv_out` | `tvout.cgi` | TV out 및 NTSC/PAL |
| `get_video`, `set_video`, `get_max_video_size` | `videoset.cgi` | capture 1~3, encoder 1~3 |
| `get_audio`, `set_audio` | `audioset.cgi` | codec, in/out, gain, sampling |
| `get_rtsp`, `set_rtsp` | `rtspset.cgi` | RTSP/RTP/RTCP/multicast/authority |
| `get_connection_info` | `connectinfo.cgi` | all 또는 stream1~3 연결 정보 |

비디오 설정의 `encoder_number`로 `setvideo1..3`를 만들고, encoder field 이름을 PDF 그대로 전송한다. 변경 후 `need_reboot = yes` 응답은 caller가 확인할 수 있도록 보존한다.

### 6.5 Event, Alarm, Image

| 함수 | CGI path | 반환 |
|---|---|---|
| `get_events` | `requestevent.cgi` | 한 번의 event 응답 |
| `iter_events` | `requestevent.cgi` | multipart text event iterator |
| `set_alarm_output_state` | `ctrl_alarmout.cgi` | on/off 결과 |
| `get_jpeg` | `/cgi-bin/image/jpeg.cgi` | JPEG `bytes` |
| `iter_mjpeg` | `/cgi-bin/image/mjpeg.cgi` | JPEG frame `bytes` iterator |

`get_jpeg`는 응답의 `Content-Type`을 확인하고 오류 text이면 `HucomsResponseError`로 변환한다. multipart parser는 boundary를 header에서 추출하고 각 part의 `Content-Length`를 우선 사용한다.

### 6.6 PTZ

| 함수 | CGI path | 설명 |
|---|---|---|
| `get_ptz_status`, `set_ptz_status`, `reset_lens`, `go_ptzf_position`, `get_ptzf_position` | `ptzf_status.cgi` | PT/ZF enable, lens reset, 절대 위치 |
| `move_pan_tilt` | `pt_control.cgi` | pan/tilt 방향과 speed |
| `one_push_focus`, `move_zoom_focus` | `zf_control.cgi` | one-push AF, zoom/focus |
| `set_preset`, `go_preset`, `clear_preset`, `auto_pan`, `auto_pan_cw`, `auto_pan_ccw` | `preset_control.cgi` | preset 및 auto pan |
| `center_ptz` | `ptz_centering.cgi` | box/point 중심 이동 |

Pan/tilt 위치와 PTZ 속도는 PDF 범위를 로컬 검증한다. 장비 미지원 PTZ는 `HucomsResponseError`로 전달한다.

### 6.7 Unified Command와 Capabilities

| 함수 | CGI path | action |
|---|---|---|
| `get_system_info_1` | `serverinfo1.cgi` | `getsysinfo1` |
| `get_system_info_2` | `serverinfo2.cgi` | `getsysinfo2` |
| `get_system_info_3` | `serverinfo3.cgi` | `getsysinfo3` |
| `get_capabilities_video_all`, `get_capabilities_video`, `get_capabilities_video_codec`, `get_capabilities_resolution`, `get_capabilities_framerate`, `get_capabilities_bitrate`, `get_capabilities_quality` | `capabilityvideo.cgi` | PDF B1.1~B1.7 |
| `get_capabilities_audio_all`, `get_capabilities_audio`, `get_capabilities_audio_codec` | `capabilityaudio.cgi` | PDF B2.1~B2.3 |
| `get_capabilities_ptz_all`, `get_capabilities_ptz` | `capabilityptz.cgi` | PDF B3.1~B3.2 |

Capability 응답은 `sections`와 `values`를 모두 유지하고, `;` 구분 capability 값은 별도 변환하지 않아 장비별 원문을 잃지 않게 한다.

## 7. 검증 정책

- 문자열: empty 금지 여부는 PDF가 명시한 필드에만 적용
- enum: PDF의 소문자 값을 기본으로 사용하되 대문자 입력은 normalize
- 범위: 정수/포트/좌표/속도/시간을 호출 전에 검증
- IP: `ipaddress.ip_address`로 IPv4만 허용
- 포트: 80 또는 3000~60000, RTSP/RTP 포트는 문서 범위 적용
- endpoint path: 선행 `/` 유무와 무관하게 표준화

검증 실패는 네트워크 요청을 하지 않고 `HucomsValidationError`를 발생시킨다.

## 8. 테스트 전략 (goal/loop)

### Loop 1 - 설계 기준 확인

- PDF endpoint/action/parameter 표와 공개 함수 목록 일치 여부 점검
- 패키지 import와 실제 카메라 없는 상태의 unit test 준비

### Loop 2 - 핵심 transport/parser 구현

- query encoding, timeout, auth field, password masking
- text response, section response, Error response
- JPEG와 multipart frame parser

### Loop 3 - 전체 wrapper 구현

- 각 wrapper가 올바른 path/action/query를 만드는지 fake transport로 검증
- PDF의 범위 검증 오류가 사전에 발생하는지 확인

### Loop 4 - 사용성/문서 검증

- README quick start와 함수 카탈로그 업데이트
- `python -m unittest discover -s tests -v` 실행
- compile/import 및 diff 점검

### Loop 종료 조건

모든 PDF 기능군이 함수로 노출되고, unit test가 성공하며, 독립 폴더에서 표준 라이브러리만으로 import 가능하면 goal을 완료한다. 실제 카메라가 없으므로 통신 성공 자체는 fake transport 검증으로 대체하고, 실장비 확인이 필요한 항목은 README에 명시한다.

## 9. 보안 및 운영 주의

- 카메라 기본 인증은 평문 HTTP query이므로 신뢰된 내부망에서만 사용한다.
- 애플리케이션 로그에 `str(request.url)`을 남기지 않는다.
- `factory_reset`/`reboot`는 즉시 장비 상태를 바꾸므로 별도 확인 없이 자동 호출하지 않는다.
- IP/포트 변경 후 현재 client의 base URL은 자동으로 바뀌지 않는다. 새 주소로 client를 다시 생성한다.

