# 18회차 구현 — 실카 낮 프레임 **예약 캡처**

목표: 내일 아침 06:33 부터 사람 개입 없이 실카(`real-camera-2`) 낮 프레임이 자동으로 쌓인다.
낮 프레임은 그 시간에만 얻을 수 있는 희소 자원이고, 검출·오버레이는 저장된 프레임 위에서 나중에 몇 번이든
재실행할 수 있다(골든 세트와 같은 논리) — 그래서 **캡처를 판정과 분리**했다.

---

## 1. 변경·신규 파일

| 파일 | 구분 | 내용 |
|---|---|---|
| `SettingAgent/src/tools/realCamCapture.ts` | 신규 | 캡처 도구 본체(3단계 검증 경로 + manifest 누적 + best-effort 검출·오버레이) |
| `SettingAgent/test/realCamCapture.test.ts` | 신규 | 순수 로직 유닛 12건(파일명·시각·PTZ 동일판정·manifest 병합/실패분기) |
| `SettingAgent/scripts/realcam_capture.cmd` | 신규 | 작업 스케줄러 실행 래퍼(cwd 고정 + 로그 append) |
| `.gitignore`(루트) | 수정 2줄 | `SettingAgent/test/fixtures/realCamDaylight/` 제외(골든 세트와 같은 취급) |

기존 소스는 **한 줄도 수정하지 않았다**. 특히 `src/ground/*`(검출 알고리즘), `src/tools/realFrameOverlay.ts`,
`config/*.json`, 정본 `data/Place01/PtzCamRoi.json`, DB 는 무접촉이다.

---

## 2. 캡처 경로 — 리더가 실측 검증한 3단계 그대로

```
① GET /viewer/api/ptz?source=real-camera-2&cam=1              → 현재 PTZ
② GET /viewer/api/snapshot?...&preset=1&mode=manual&pan=①&tilt=①&zoom=①  → JPEG
③ GET /viewer/api/ptz ...                                     → 전후 일치 확인
```

- `mode` 는 필수(빠뜨리면 400), `preset` 도 필수 숫자. **`mode=preset` 은 쓰지 않는다.**
- `/viewer/api/move` 호출 없음. ②는 "지금 있는 자리를 그대로 되돌려주는" 값이라 장비가 움직이지 않는다.
- ③이 ①과 다르면 `WARN` 로그를 남기고 manifest 에 `ptzUnchanged:false` 로 기록한다(은닉하지 않는다).
  허용오차는 pan/tilt 0.05° · zoom 0.05 — real-camera-2 의 네이티브 1 스텝(pan 0.01° / tilt 0.0164° /
  zoom 0.0021x)의 수 배라 인코더 지터는 흡수하고 사람이 만드는 도 단위 변화는 잡는다.

### 저장물
- 프레임: `test/fixtures/realCamDaylight/frame_<YYYYMMDD>_<HHmmss>.jpg` (로컬 시각 기준)
- 같은 초의 파일이 이미 있으면 **덮어쓰지 않고 스킵**(exit 0).
- `manifest.json` 은 **누적 갱신**한다. 항목 필드:
  `file / capturedAtLocal(오프셋 포함) / capturedAtUtc / viewerPtz / viewerPtzAfter /
   nativePtz{panpos,tiltpos,zoompos} / snapshotPtz(X-PTZ-* 헤더) / sha256_12 / bytes / imgW / imgH / ptzUnchanged`
- **네이티브 환산은 지어내지 않았다.** 17b/17c 가 쓴 경로 그대로 —
  `buildSourceRegistry(loadToolsConfig()).get('real-camera-2').toNativePtz(viewerPtz)`(순수 범위 사상, 장비 미호출).
  실패하면 `nativePtz:null` + `nativePtzNote` 에 사유를 적고 뷰어 PTZ 만 남긴다.

### 기록 순서(의도적)
프레임 파일 → manifest → 로그 → 검출/오버레이. 뒤쪽이 죽어도 **희소 자원(프레임)은 이미 디스크에 있다**.
실제로 개발 중 로그 단계에서 죽은 실행(20:28:35)이 있었는데 프레임과 manifest 항목은 온전히 남았다.

---

## 3. 검출·오버레이 (best-effort — 실패해도 캡처는 성공)

캡처 성공 후 이어서:
1. `POST /rpc` → `roi.auto.detect {source:'real-camera-2', consensus:false, expectedBays:10}` 1회
2. `npx tsx src/tools/realFrameOverlay.ts real-camera-2 reports/overlay_daylight/overlay_<stamp>.png 10`

둘 다 실패는 `WARN` 로그만 남기고 **exit code 를 오염시키지 않는다**(Unity 미기동 시 `roi.show2d` 가
~11초 타임아웃나는 알려진 현상 포함).

> ⚠️ **알아 둘 차이**: `realFrameOverlay.ts` 는 인자로 프레임 파일을 받지 않고 **자기가 라이브 프레임을
> 한 장 더 찍는다**(17b 설계 그대로). 따라서 오버레이 PNG 의 원본은 같은 시각의 **다른** 프레임이며
> manifest 의 `sha256_12` 와 일치하지 않는다. 저장된 프레임 위에 오버레이를 다시 그리려면 별도 작업이
> 필요하다 — 이번 범위(요청 밖 리팩토링 금지)에서는 손대지 않았다.
> `realFrameOverlay` 의 프레임 취득은 `requestImage(1,1)`(= `mode:'preset'`)인데, `RealPtzSource.snapshot`
> 은 `mode==='manual'` 일 때만 `move()` 를 부르므로(`RealPtzSource.ts:233`) **실카는 이 경로에서도 움직이지 않는다.**

---

## 4. 실행 래퍼 + 작업 스케줄러

`scripts/realcam_capture.cmd`:
```
cd /d "D:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent"
if not exist "reports" mkdir "reports"
call npx tsx src/tools/realCamCapture.ts >> "reports\realcam_capture.log" 2>&1
exit /b %ERRORLEVEL%
```

### 라이브 실행에서 잡은 함정 2건(둘 다 수정 완료)
1. **`.cmd` 는 ASCII 주석만 쓴다.** 처음엔 프로젝트 관행대로 한글 주석을 넣었는데, `cmd.exe` 가 배치 파일을
   OEM 코드페이지로 읽어 UTF-8 한글이 명령 구분자로 오해되며 `'실행하므로' is not recognized ...` 로
   **2번째 줄에서 배치가 깨졌다**. 한글 설명은 이 문서에 두고 `.cmd` 는 영문 주석으로 고정했다.
2. **로그 파일 이중 오픈(EBUSY).** `.cmd` 가 `>>` 로 같은 로그를 배타 핸들로 열고 있으면 도구의
   `appendFileSync` 가 `EBUSY` 로 죽는다(실측). 이제 `log()` 는 파일 append 실패를 **삼키고** 표준출력으로만
   내보낸다 — 그 표준출력이 곧 같은 파일로 리다이렉트되므로 줄은 유실되지 않는다. 수동 실행(리다이렉트 없음)에서는
   append 가 성공한다. 즉 두 경로 중 항상 정확히 하나가 산다(중복 기록 없음).

### 등록된 작업 (5개 — `schtasks` 는 한 작업에 다중 시각을 못 넣는다)
```
schtasks /create /tn "ParkAgent_RealCamDaylight_0633" /tr "D:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\scripts\realcam_capture.cmd" /sc DAILY /st 06:33 /f
   (0733 / 0833 / 1033 / 1233 동일 패턴)
```

`schtasks /query` 원문:
```
Folder: \
TaskName                                 Next Run Time          Status
======================================== ====================== ===============
ParkAgent_RealCamDaylight_0633           2026-07-30 오전 6:33:0 Ready
ParkAgent_RealCamDaylight_0733           2026-07-30 오전 7:33:0 Ready
ParkAgent_RealCamDaylight_0833           2026-07-30 오전 8:33:0 Ready
ParkAgent_RealCamDaylight_1033           2026-07-30 오전 10:33: Ready
ParkAgent_RealCamDaylight_1233           2026-07-30 오후 12:33: Ready
```
상세(`/v`, 0633):
```
Task To Run:          D:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\scripts\realcam_capture.cmd
Scheduled Task State: Enabled
Run As User:          hdw-goback
Schedule Type:        Daily
Start Time:           오전 6:33:00
```

**실제 스케줄러 경유 1회 강제 실행으로 검증** — `schtasks /run /tn ParkAgent_RealCamDaylight_0633`
→ `Last Result: 0`, 프레임 `frame_20260729_203100.jpg` 저장 확인.

### 제거 방법 (마스터가 되돌리는 명령)
```
schtasks /delete /tn "ParkAgent_RealCamDaylight_0633" /f
schtasks /delete /tn "ParkAgent_RealCamDaylight_0733" /f
schtasks /delete /tn "ParkAgent_RealCamDaylight_0833" /f
schtasks /delete /tn "ParkAgent_RealCamDaylight_1033" /f
schtasks /delete /tn "ParkAgent_RealCamDaylight_1233" /f
```
PowerShell 한 줄: `@('0633','0733','0833','1033','1233') | % { schtasks /delete /tn "ParkAgent_RealCamDaylight_$_" /f }`

---

## 5. 검증 결과

| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | **285 파일 3632 테스트 전량 green** (기준선 284/3620 + 신규 1파일 12건) |
| 수동 1회 실행 | 성공(아래) |
| 래퍼 `.cmd` 를 다른 cwd(`C:\`)에서 실행 | exit 0, 로그 append 정상 |
| 스케줄러 경유 실행 | `Last Result: 0` |
| 실패 분기(서버 미기동) | `ERROR ... GET .../viewer/api/ptz 실패: TypeError: fetch failed` + **exit 1** (13099 로 임시 변경해 실측 후 원복) |
| `git check-ignore` | `.gitignore:33` 이 프레임·manifest 모두 제외 확인 |

누적 6프레임 전부 `ptzUnchanged=true`, 네이티브 `zoompos=10677 / tiltpos=786` 불변:
```
frame_20260729_202543.jpg 0a737d6776d8 84041B
frame_20260729_202654.jpg 562ff727e6e2 82084B
frame_20260729_202835.jpg 824431bc3e6d 83115B   ← EBUSY 로 죽은 실행. 프레임·manifest 는 온전(오버레이만 없음)
frame_20260729_202939.jpg 27a8021dfe60 83250B
frame_20260729_203100.jpg 87675f5a77ab 84052B   ← 스케줄러 경유
frame_20260729_203442.jpg ac161eaa5445 83476B   ← 최종 코드 기준 happy path
```
(야간 프레임 — **배관 검증용**이지 검출 판정용이 아니다.)

---

## 6. 전제 조건 — 무엇이 꺼져 있으면 실패하는가

| 조건 | 없으면 |
|---|---|
| SettingAgent 서버가 **13020** 에서 기동 중 | ①에서 `fetch failed` → **캡처 실패, exit 1** |
| 실카 `real-camera-2`(Hucoms) 네트워크 도달 + 자격증명 유효 | ②가 502 → **캡처 실패, exit 1** |
| PC 가 켜져 있고 사용자 `hdw-goback` 로그온(작업이 사용자 계정으로 등록됨) | 트리거 미발화 — 프레임 0장 |
| `node`/`npx` 가 스케줄러 세션 PATH 에 있음 | 래퍼가 즉시 실패(로그에 남음) |
| Unity 시뮬레이터 | **불필요**. 꺼져 있어도 캡처는 성공한다(검출·오버레이만 WARN 으로 강등) |

## 7. 미검증 항목 (추측하지 않고 그대로 적는다)

- **낮 조도에서의 검출 성능**: 이번에 저장한 6장은 전부 야간이다. 낮 프레임의 검출·오버레이 품질은 미검증.
- **잠금 화면/로그오프 상태의 트리거 동작**: 작업을 `/ru` 없이 현재 사용자로 등록했다. 로그온 상태에서
  `schtasks /run` 은 검증했지만, 06:33 시점에 세션이 잠겨 있거나 로그오프인 경우는 미검증이다.
- **`ptzUnchanged:false` 경로**: 실제로 PTZ 가 바뀐 상황을 만들지 않았다(실카 이동 금지). 판정 함수 자체는
  유닛으로 덮었지만 라이브 관측은 없다.
- **`roi.auto.detect` 오류 응답 분기**: 이번 실행은 5프리셋 모두 정상 반환이라 `body.error` 경로는 라이브 미관측.
- **manifest 손상 복구 분기**: 유닛으로만 덮었다(라이브에서 깨뜨려 보지 않았다).
- **`expectedBays:10` 의 타당성**: 리더 지시값을 그대로 썼다. 자동 결정은 18회차 소관이 아니다.
