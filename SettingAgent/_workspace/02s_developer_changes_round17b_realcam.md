# 17b회차 구현 — 실카 제원 배선(`real-camera-2` 에서 실제로 검출이 돈다)

> Goal: 마스터가 `real-camera-2` 를 보며 「검출」을 누르면 **거부되지 않고** 실제 실카 프레임에서
> 주차면 후보가 나온다. 정확도는 다음 이터레이션.
> 이 라운드도 **검출 알고리즘을 1줄도 바꾸지 않았다**(`src/ground/bayGrid.ts`·`bayGeometry.ts`·
> `cameraIntrinsics.ts` 무접촉 — `cameraIntrinsics` 는 기존 함수 `interpolateHfov`·`focalPxOf`·
> `groundModelFromIntrinsics` **사용만** 했다).

## 1. 변경 파일

| 파일 | 변경 |
|---|---|
| `data/lens_calibration.json` | `real-camera-2` 항목에 **`cameraSpec` 블록** 신설(`zoomHfov:[{z:0,h:58.5}]`, `heightM:13`). `real-camera-1` 무접촉 |
| `src/rpc/services/roiAuto.ts` | `readGroundSpec`(신설·export), `lensCalibFile()` 지연 해석, 실카 제원 해석에 **PTZ 틸트 피드백** 배선, `FrameSpec`(zoomRaw+tiltRaw), `warningsFor` 경고 채널, `realMissing` 갱신 |
| `src/tools/realFrameOverlay.ts` | **신규** — 실카 라이브 프레임 1장 육안검증 오버레이 도구 |
| `web/index.html` | 「도색선 자동검출」 패널에 **`예상 주차면 수`**(`#ap-bays`) 입력 |
| `web/app.js` | `expectedBays` 전송, 실카+빈칸 경고, `⚠` issues 를 접이식 밖으로 노출(`apCriticalWarnings`), `apNum` 추출 |
| `web/app.css` | `#ap-msg { white-space: pre-line }` — 경고를 요약과 다른 줄에 |
| `test/roiAutoSource.test.ts` | 거부 테스트를 제원 없는 id(`real-camera-none`)로 이관 + **17b 신규 7테스트** |

**손대지 않은 것**: `src/ground/*`, `config/tools.config.json`, 정본 `data/Place01/PtzCamRoi.json`, DB,
`roi.auto.apply` 의 source 배선, `expectedBays` 자동 결정(18회차 소관).

## 2. ★ 설계 이탈 1건 — 제원을 `cameraSpec` 블록에 넣었다(최상위 `zoomHfov` 가 아니라)

리더 지시는 "`real-camera-2` 항목에 `zoomHfov: [{z:0,h:58.5}]` 추가"였다. **그대로 하면 실카의
클릭 조준(센터링 게인)이 조용히 꺼진다.** 코드 근거:

`packages/lens-calib/src/calibration.ts:151` (`CameraCalibration.from`)
```ts
centeringGain: spec.centeringGain ?? (spec.zoomHfov ? null : inherited?.centeringGain) ?? null,
```
`real-camera-2` 는 현재 `model:"cam-001"` · `enabled:true` 라 프리셋의 `centeringGain`(13점)을 **상속받아
실제로 보정 중**이다(`loadLensCorrector` → `hasGain=true` → 비항등 corrector). 최상위에 `zoomHfov` 를
얹는 순간 위 규칙이 `centeringGain: null` 로 끊어 `IDENTITY_CORRECTOR` 로 강등된다 — 작동 중인 기능의
무고지 회귀다. (그 상속 규칙 자체는 옳다: "자기 화각을 쟀으면 남의 게인은 더 이상 안 맞는다".
다만 우리 1점 표는 그 카메라의 줌 곡선 실측이 아니다.)

그래서 **lens-calib 이 소비하지 않는 `cameraSpec` 블록**에 넣었다:
```json
"cameraSpec": { "zoomHfov": [{ "z": 0, "h": 58.5 }], "heightM": 13 }
```
- **필드명 근거**: RPC 파라미터 `cameraSpec`(`heightM`·`tiltDeg`·`hfovDeg`)과 **같은 이름**이다.
  이 블록은 곧 그 파라미터의 기본값이고, UI 입력이 오면 UI 가 이긴다 — 같은 이름이라 규칙이 자명하다.
  (후보였던 `installHeightM` 은 코드 어디에도 없는 새 이름이라 채택하지 않았다. 기존 관행은
  `PresetIntrinsics.heightM`(cameraIntrinsics.ts:33)와 `bayGeometry` 의 `cameraHeightM` 두 가지인데,
  이 블록이 `cameraSpec` 인 이상 `heightM` 이 유일하게 일관된 선택이다.)
- **하위호환**: `readGroundSpec` 은 `cameraSpec.zoomHfov ?? 최상위 zoomHfov` 순으로 읽는다 →
  `real-camera-1` 의 최상위 13점 실측표는 그대로 동작한다.
- `upsertLensCalibration`(`lensCalibFile.ts:63`)이 `...prev` 로 병합하므로 향후 렌즈 캘리브 실측이
  이 블록을 지우지 않는다(확인함).

## 3. 실카 제원 해석 배선

`resolverFor` 의 `hucoms` 분기가 이제 **세 값을 자동으로 채운다**. 우선순위는 항상 **UI 입력 > 자동**.

| 값 | 자동 출처 | UI 우선 |
|---|---|---|
| 수평화각 | `lens_calibration.json` → `cameraSpec.zoomHfov` 를 **네이티브 zoompos** 로 `interpolateHfov` | `cameraSpec.hfovDeg` |
| 하향 틸트 | **PTZ 피드백** — 네이티브 `tiltpos / 100` | `cameraSpec.tiltDeg` |
| 설치고 | `lens_calibration.json` → `cameraSpec.heightM` | `cameraSpec.heightM` |

### 네이티브 PTZ 를 어떻게 얻었나
`RealPtzSource.readNativePtz` 는 **private** 이라 쓸 수 없다. 대신 `CameraSource` 공개 계약인
`toNativePtz` 로 **되돌린다**(`nativePtzOf`) — 캡처가 돌려준 뷰어 PTZ 를 그 소스 자신의 환산기로
역변환하는 것이라 단위 가정이 없고, 양방향 모두 같은 `mapRange` 라 클램프 구간 안에서 정확한 역이다.
**PTZ 이동 명령은 보내지 않았다**(`snapshot(mode:'preset')` = 현재 위치 캡처만).

실측 왕복 검산: 뷰어 tilt `-44.410909` → tiltpos **786**, 뷰어 zoom `23.80853` → zoompos **10677**.
(라이브 `GET /viewer/api/ptz?source=real-camera-2` 값과 응답 `intrinsics.source` 가 일치.)

### 틸트 단위·부호 — 어디까지가 사실인가
- **단위(centidegree)는 문서 근거가 있다**: `docs/20260725_002405_*.md:29` (`tiltRange −2000~9000`,
  단위 centidegree), pan `0~35999` = 0.00~359.99° 와 같은 단위족. → `tiltpos/100 = 도`.
- **부호는 가정이다**: 범위가 −20.00°~+90.00° 인 점(돔 카메라의 전형적 "수평 0 / 바로 아래 +90")에서
  **양수 = 하향**으로 두었다. **실측 대조 0건**이다. 17회차가 지적한 뷰어의 `[-2000,9000]→[-90,90]`
  선형 range-fit 은 각도가 아니므로 **쓰지 않았다**(네이티브로 되돌린 뒤 /100 만 한다).
- 부호를 뒤집지 않았고, **쓴 값을 응답 issues 에 그대로 노출**했다 → 화면 결과로 사람이 판정한다.

## 4. ★ 경고 채널(조용히 두지 않는다)

`IntrinsicsResolver.warningsFor(frameSpec)` 를 추가해 **거부는 아니지만 결과 해석에 필수인 사실**을
`issues` 에 싣는다. 시뮬 경로는 `warningsFor` 가 없어 **issues 가 비트 동일**하다(§6 회귀 확인).

1. **단일점 화각표** — 표가 1점이면 줌이 바뀌어도 같은 화각이다. 그 프레임의 네이티브 줌을 함께 찍는다.
2. **틸트 부호 가정** — centidegree 해석·양수=아래 가정임을 값과 함께 밝힌다.

웹은 `⚠` 로 시작하는 issue 를 접이식(`<details>`) **밖으로** 끌어내 `#ap-msg` 에 줄바꿈해 붙인다.
접혀 있으면 아무도 안 본다.

## 5. UI — 예상 주차면 수

`#ap-bays`(비우면 미전송 = 기존 동작 = 정본 면수). 툴팁에 명시:
> 실카는 수동 정본이 없어 비워두면 1면만 검출된다. 화면에 보이는 주차면 수를 입력하라. (18회차에 자동 결정으로 대체 예정)

**실카 소스인데 비어 있으면** 실행 메시지 앞에 경고가 붙는다(`selectedSourceIsReal()` 게이트).
근거: `roiAuto.ts` 의 `expectedBays = p.expectedBays ?? 정본 면수` → 실카는 정본 0 → `max(1,0)=1`.

## 6. 검증 실측

1. `npx tsc --noEmit` → **exit 0**
2. `npx vitest run` → **284파일 3617테스트 전량 green**(기준선 284/3610 + 신규 7)
3. 유닛(`test/roiAutoSource.test.ts` 17테스트):
   - ⓐ 단일점 `zoomHfov` → z 0/1/5000/10677/16384/65535 전부 58.5°
   - ⓑ 58.5°·1920px → f **1714.20335px**(`toBeCloseTo(1714.2, 1)`)
   - ⓒ UI `cameraSpec{30°,21°,6.2m}` 가 파일·PTZ 자동해석을 이김(f 3582.77, `⚠` 0건)
   - ⓓ 설치고 없으면 **거부 유지**(화각만 있어도 진행하지 않음), 제원 전무 실카는 **프레임조차 안 찍음**
   - 파일 cameraSpec+PTZ 틸트로 거부 없이 검출 진행 / 경고 2종 노출 / `expectedBays` 수용
4. **실호출**(13020, nodemon 자동 반영 · 서버 재시작 0회): §7
5. **시뮬 무회귀**: `source:"simulator-1"`, `camId:1 presetIdx:1`, `consensus:false`
   → `frameHash 2fecd51b1e5f` · `focalPx 2932.79189` · `quads 7` ·
   `q0 [{0.85795,0.56809},{0.73171,0.50051},{0.8315,0.49049},{0.96998,0.55461}]` ·
   `intrinsics.source "sim-place-meta(preset)"` · `⚠` 0건 — 17회차와 동일.

## 7. 실카 실검출 — 응답 issues 원문

`roi.auto.detect {source:"real-camera-2", consensus:false, expectedBays:10}` → **거부 없음, quads 10**
(preset `1:1`, `frameHash 1ab71c3f2787`, `paintLines 45`, `focalPx 1714.20335`)

```
지면모델 주입: real:real-camera-2(zoomHfov@z=10677, tilt 7.86°←PTZ tiltpos 786/100, 설치고 13m←lens_calibration.cameraSpec) (fov 58.500° horizontal, tilt 7.86°, 설치고 13m → f 1714.2px)
⚠ 수평화각 고정 58.5° — "real-camera-2" 의 zoomHfov 실측표가 1점뿐이라 **줌이 바뀌어도 같은 화각**을 쓴다(이번 프레임의 네이티브 줌 10677). 초점거리가 줌을 따라가지 않으므로 주차면 크기가 통째로 어긋난다 — 줌별 실측표(real-camera-1 처럼)를 채우거나 패널의 수평화각을 직접 입력하라.
⚠ 하향 틸트 7.86° 는 네이티브 tiltpos 786 을 centidegree 로 해석한 값이다(사양·문서 근거뿐 실측 대조 0건). **양수 = 아래** 로 가정했다 — 화면 결과가 위아래로 뒤집혀 보이면 패널의 틸트에 부호를 바꿔 직접 입력하라.
지상고 자가보정: 13.000m → 13.028m (관측 칸간격 2.4947m vs 규격 2.5m, 계수 1.00213, 표본 27)
```

★ 마지막 줄이 흥미롭다: 이미지 관측 칸간격이 규격 2.5m 대비 **0.2% 오차**로 맞았다.
설치고 13m 가 이 프레임에서 자기일관적이라는 뜻이다(정답 보장은 아니다 — 자기일관과 정확은 다르다).

## 8. 오버레이 산출물

`reports/overlay_r17/real2_current.png` — `npx tsx src/tools/realFrameOverlay.ts real-camera-2 reports/overlay_r17/real2_current.png 10`

```
frameHash 62cd8504ae05  1920×1080  네이티브 zoompos 10677 tiltpos 786
hfov 58.5° · tilt 7.86° · 설치고 13m · f 1714.20px
직선 48 · 가설 3 · 코너 6 · 자동quad 5 · expectedBays 10
```
좌상단 헤더에 제원·frameHash·경고를 찍었다. 수동 정본이 없어 **초록은 없고** 빨강(자동 quad)·
노랑(전방선)·주황(근변코너)·회색(검출 직선)만 그려진다 — 정상이다.

**새 도구를 만든 이유**: `roiAutoOverlay.ts` 는 *디렉터리에 쌓인 골든/캐시 프레임 배치* 도구이고
제원을 정본 메타에서만 얻는다. 실카는 프레임이 파일에 없고(라이브) 제원 출처도 다르다. 두 축을
한 파일에 섞으면 배치 도구가 실카 배선을 끌고 다니게 된다. JSON 스키마 지식만 `readGroundSpec`
export 로 공유해 드리프트를 막았다.

## 9. 부작용·미검증 (은닉 금지)

- **`roi.auto.apply` 의 거부 방어막이 약해졌다.** `cameraRuntime.selectedCameraId = "real-camera-2"`
  이므로 apply 의 기본 소스가 실카고, 17회차에는 제원 미상 → `CONFLICT` 로 **구조적으로** 막혔다.
  이제 제원이 갖춰져 그 관문을 통과한다. 다만 그 뒤 `minIoU`(기본 0.98) 게이트가 실카 검출 ↔ 시뮬
  정본을 대조하므로 IoU ≈ 0 → `CONFLICT` + 정본 무변경으로 여전히 막힌다(코드 확인, **실호출 미검증**).
- **틸트 부호 미검증**(§3). 값 7.86° 하향은 그럴듯하지만 실측 대조 0건이다.
- **화각 58.5° 는 현재 줌에서 거의 확실히 틀리다.** 네이티브 zoompos 10677 인데 1점 표가 광각단
  값으로 클램프한다(참고: `cam-001` 프리셋의 같은 줌 구간 실측은 ≈14°). 이번 목표는 "거부되지 않고
  나오는 것"이므로 그대로 두고 경고로 노출했다. 다음 이터레이션의 1순위다.
- **설치고 13m 는 마스터 구두 실측("약 13m")**이다. 줄자 기록 없음.
- 오버레이 PNG 의 `frameHash 62cd8504ae05` 는 RPC 실호출(`1ab71c3f2787`)과 **다른 프레임**이다 —
  라이브 카메라라 캡처 시점이 다르면 프레임이 다르다. 같은 제원·같은 알고리즘이지만 quad 수가
  10 vs 5 로 갈린 것은 그 때문이다(차량·조명 변화). 프레임 고정 대조가 필요하면 별도 캡처 저장이 필요하다.
- **육안 판정은 리더 몫** — PNG 를 보고 다음 이터레이션의 방향(화각? 틸트 부호? expectedBays?)을 정해야 한다.
