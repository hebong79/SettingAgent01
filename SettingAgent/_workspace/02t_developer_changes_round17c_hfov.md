# 17c회차 구현 — 실카 화각을 `cam-001` 실측표로 교체(줌 반영)

> Goal: `real-camera-2` 검출 quad 가 실제 주차면 크기와 맞는다(직전 4.6배 작았다).
> 이 라운드도 **검출 알고리즘을 1줄도 바꾸지 않았다** — `src/ground/bayGrid.ts`·`bayGeometry.ts`·
> `cameraIntrinsics.ts` 무접촉. 바뀐 것은 **화각 공급원 하나**다.

## 1. 변경 파일

| 파일 | 변경 |
|---|---|
| `data/lens_calibration.json` | `real-camera-2.cameraSpec` 에서 **단일점 `zoomHfov:[{z:0,h:58.5}]` 제거**(`heightM:13` 유지). 상속 근거를 `_zoomHfov` 주석에 기록. `real-camera-1` 무접촉 |
| `src/rpc/services/roiAuto.ts` | `readGroundSpec` 에 **`model` 프리셋 상속** 추가(+`zoomHfovFrom` 출처 필드), `PRESETS` import, `hfovFrom` 에 보간값·표 출처 노출, **단일점 경고 → 표범위 클램프 경고**로 교체, 틸트 문구 "미검증"→"실측 확정"(⚠ 해제), `TILT_CENTIDEG_PER_DEG` 주석 정정, `realMissing` 문구 갱신 |
| `src/tools/realFrameOverlay.ts` | 헤더의 거짓 경고 줄 교체(표 점수·출처·틸트 실측확정 + 표범위 밖일 때만 ⚠ 클램프), `source` 문자열에 보간값·표 출처, 주석 정정 |
| `test/roiAutoSource.test.ts` | 17b 의 58.5° 전제 테스트 5건을 17c 전제로 교체 + 신규 3건(줌 반영·클램프 경고·표 동일성). 20테스트 |

**손대지 않은 것**: `packages/lens-calib/**`(실측표 원본 — **한 자리도 고치지 않았다**), `src/ground/*`,
`config/tools.config.json`, 정본 `data/Place01/PtzCamRoi.json`, DB, `roi.auto.apply` 배선,
`expectedBays` 자동 결정(18회차), `real-camera-1` 항목.

## 2. ★ 캘리브 상속을 어떻게 처리했나 — **상속 메커니즘을 그대로 썼다(복제 0)**

### 판단 ①: SettingAgent 는 `@parkagent/lens-calib` 을 **이미 의존한다** → 복제 불필요

루트 `package.json` 의 `workspaces: ["packages/*", "SettingAgent"]` 로 묶여 있고, SettingAgent 소스가
이미 5개 파일에서 이 패키지를 import 한다(`src/calibrate/lensCorrection.ts:13` 등이 `CameraCalibration` 을
직접 쓴다). 그래서 `roiAuto.ts` 에서 `import { PRESETS } from '@parkagent/lens-calib'` 한 줄로 끝났다.
**실측 13점을 `lens_calibration.json` 이나 SettingAgent 코드에 복제하지 않았다** — 표는 한 벌(
`packages/lens-calib/src/presets.ts:26-40`)뿐이고, 그 파일의 황금값 테스트가 계속 유일한 수문장이다.

### 판단 ②: `cameraSpec` 블록 우회는 **불필요해졌다** — 17b 가 걱정한 문제가 소멸한다

17b 는 `centeringGain` 이 끊길까 봐 표를 `cameraSpec` 블록에 숨겼다. 그 걱정의 근거는
`packages/lens-calib/src/calibration.ts:154`:
```ts
centeringGain: spec.centeringGain ?? (spec.zoomHfov ? null : inherited?.centeringGain) ?? null,
```
**표를 상속받으면 JSON 에 `zoomHfov` 자체를 쓰지 않는다** → `spec.zoomHfov` 가 undefined →
`inherited?.centeringGain`(cam-001 13점)이 그대로 살아 있다. 즉 이번 방식은 조준 게인을 건드리지 않는다.
(17b 의 우회는 그 시점엔 옳았다. 자기 표를 얹으려 했기 때문이다.)

### 판단 ③: 상속 규칙을 `readGroundSpec` 에 **같은 순서로** 심었다

`CameraCalibration.from`(`calibration.ts:150,153`)이 `spec.zoomHfov ?? inherited?.zoomHfov`,
`inherited = spec.model ? getPreset(spec.model) : defaults` 인 것과 같은 순서다:

```
1. cameraSpec.zoomHfov      (이 블록 전용 실측표 — 있으면 최우선)
2. 최상위 zoomHfov          (lens-calib 조준 스키마 · real-camera-1 이 이 모양)
3. PRESETS[model].zoomHfov  (★ 17c 신규 — real-camera-2 가 여기로 온다)
```

`getPreset` 대신 `PRESETS[model]?.` 로 조회했다 — `getPreset` 은 미등록 이름에 **throw** 하는데
`readGroundSpec` 은 "모르면 null" 계약(전체가 try/catch 로 감싸여 있다)이라 오타가 모든 제원을
조용히 날려버린다. 옵셔널 조회는 화각만 null 이 되어 기존 거부 경로로 정확히 떨어진다.

★ **설치고는 상속하지 않는다.** 설치고는 렌즈가 아니라 **설치 현장**의 값이라 모델 공통이 아니다
(`heightM` 은 계속 그 카메라 항목에서만 온다 — `real-camera-2` 는 13m).

### 상속이 정당한 근거(리더 제시 · 확인함)
`.claude/worktrees/feat-lens-calib-web-ui/SettingAgent/data/lens_calib_result_real-camera-2.json` —
`verdict:"pass"`, `calibration:"cam-001"`, `usable 17/18`, `worstPx 8.4`, `measuredAt 2026-07-27`.
**"real-camera-2 는 캘리브 없음"(U15·14회차 §18-⑦)은 틀린 확립사실이었다.**

★ **정확히 무엇이 검증됐나(과대해석 금지)**: 그 파일의 `checks` 는 `{zoom, residualPx, gainNeeded,
gainApplied}` 3점(z 0/8000/16384)이다 — 직접 잰 것은 **화각이 아니라 센터링 게인 k** 이고,
z0 0.991 vs 0.988 · z8000 1.101 vs 1.110 · z16384 0.752 vs 0.765 로 cam-001 값과 맞았다.
`k = f_펌웨어 / f_렌즈`(`presets.ts:7`)이므로 세 줌 전 구간에서 k 가 맞는다는 것은
**이 개체의 f_렌즈 곡선이 cam-001 의 것과 같다**는 뜻이고, `zoomHfov` 는 그 f 곡선의 표현이다.
즉 근거는 **직접이 아니라 간접(강하지만 1단계 추론)**이다 — 화각 3점 이상을 직접 재면 확정된다.

## 3. 수치 — 무엇이 얼마나 바뀌었나

| | 17b | 17c |
|---|---|---|
| 표 | 1점 `{z:0, h:58.5}` | cam-001 13점 (z 0~16384) |
| zoompos 10677 의 화각 | 58.500° (클램프) | **13.766950°** (z10338 14.68° ~ z12161 9.77° 선형보간) |
| f (1920px) | 1714.20335px | **7952.24225px** |
| 비 | — | **×4.639** |

z=0 의 표값은 **57.14°** 로 마스터의 사양값 58.5° 와 같은 자리다 — **마스터 값이 틀린 게 아니라
줌을 반영하지 않았던 것**이 확인됐다.

## 4. 줌이 실제로 반영되는가 — 검증

`intrinsics.source` 에 **보간 결과와 표 출처**를 함께 찍게 했다:
```
zoomHfov@z=10677→13.767°←model:cam-001 내장 실측표
```
그리고 `groundModelFromIntrinsics` 가 기존대로 `fov 13.767° horizontal … → f 7952.2px` 를 붙인다.
유닛에서 **같은 프레임·다른 zoompos** 로 두 번 돌려 f 가 실제로 갈라지는 것을 고정했다
(z=0 → 1755px 대 / z=10677 → 7952px 대, 비 > 4).

## 5. 경고 채널 정정

| | 17b | 17c |
|---|---|---|
| 화각 | `⚠ 수평화각 고정 58.5° — 1점뿐이라 줌이 바뀌어도 같은 화각` (이제 **거짓**) | **제거**. 대신 `zoomRaw` 가 표 범위 `[min z, max z]` **밖일 때만** `⚠ … 클램프` (단일점 표는 lo=hi 라 이 한 조건으로 함께 걸린다) |
| 틸트 | `⚠ … 사양·문서 근거뿐 실측 대조 0건. **양수 = 아래** 로 가정했다` | `하향 틸트 7.86° = 네이티브 tiltpos 786 ÷ 100. centidegree 단위와 **양수 = 아래** 부호는 실기 cam-001 실측으로 확정된 규약이다(@parkagent/lens-calib `geometry.ts:3-6`)` — **⚠ 를 뗐다** |

★ `⚠` 를 뗀 이유: 웹(`app.js` 의 `apCriticalWarnings`)이 `⚠` 로 시작하는 issue 만 접이식 **밖으로**
끌어내 상시 노출한다. 확정 사실을 거기 두면 진짜 경고가 묻힌다. 값·출처는 계속 issues 에 남는다.

**근거**(`packages/lens-calib/src/geometry.ts:3-6`):
```
부호 규약 (Hucoms, 실기 cam-001 실측 확정):
  tiltpos + = 아래를 봄 → 고도각 e = −tilt
  각도 단위는 centidegree(1/100°)
```
→ 17b 보고의 "부호 미검증"을 **"실측 확정"으로 정정**한다. `tiltpos/100` 도, 부호도 옳았다.

## 6. 검증 실측

1. `npx tsc --noEmit` → **exit 0**
2. `npx vitest run` → **284파일 3620테스트 전량 green** (기준선 284/3617 대비 +3: 신규 5 − 폐기 2)
3. 유닛(`test/roiAutoSource.test.ts` 20테스트)
   - ⓐ 상속표 = `PRESETS['cam-001'].zoomHfov` 동일성 + z10677 → **13.766950082281953**(`toBeCloseTo(13.77, 2)`)
   - ⓑ z=0 → **57.14°**
   - ⓒ 표 밖 클램프: z=−1 → 57.14° / z=65535 → 2.39°
   - ⓓ 13.767°·1920px → f **≈7952px**, 1714.20335 대비 **×4.64**
   - ★ 줌이 다르면 f 가 달라진다(z0 vs z10677, 비 > 4)
   - ★ 표 안 → `⚠` 0건 / 표 밖(z=20000) → `⚠ … 범위 [0, 16384] 밖 … 클램프 … 2.390°`
   - ⓔ UI `cameraSpec{30°,21°,6.2m}` 가 파일·상속·PTZ 를 이김(f 3582.77, `⚠` 0건)
   - ⓕ 설치고 없으면 **거부 유지**(화각은 상속돼도 진행하지 않음)
4. **실호출**(13020, nodemon 자동 반영 · **서버 재시작 0회**, PTZ 이동 명령 0회): §7
5. **시뮬 무회귀**: `simulator-1` cam1:p1 `consensus:false`
   → `frameHash 2fecd51b1e5f` · `focalPx 2932.79189` · `quads 7` ·
   `q0 [{0.85795,0.56809},{0.73171,0.50051},{0.8315,0.49049},{0.96998,0.55461}]` ·
   `intrinsics.source "sim-place-meta(preset)"` · `⚠` 0건 — **17회차와 비트 동일**

## 7. 실카 실검출 — 응답 issues 원문

`roi.auto.detect {source:"real-camera-2", consensus:false, expectedBays:10}` → **거부 없음**
(preset `1:1`, `frameHash 4f4d2c4ef584`, `paintLines 20`, **`focalPx 7952.24225`**, `quads 1`)

```
지면모델 주입: real:real-camera-2(zoomHfov@z=10677→13.767°←model:cam-001 내장 실측표, tilt 7.86°←PTZ tiltpos 786/100, 설치고 13m←lens_calibration.cameraSpec) (fov 13.767° horizontal, tilt 7.86°, 설치고 13m → f 7952.2px)
하향 틸트 7.86° = 네이티브 tiltpos 786 ÷ 100. centidegree 단위와 **양수 = 아래** 부호는 실기 cam-001 실측으로 확정된 규약이다(@parkagent/lens-calib `geometry.ts:3-6`).
지상고 자가보정: 13.000m → 12.772m (관측 칸간격 2.5447m vs 규격 2.5m, 계수 0.98243, 표본 5)
근변선 재적합 pass1: 표본 20/61, 잔차 11.63px, 법선 c=-1019.0953 (이동 19.7172px), 각 85.52458°, 근변지지 0.810
근변선 재적합 pass2: 표본 36/61, 잔차 14.20px, 법선 c=-1028.6319 (이동 9.5366px), 각 85.06614°, 근변지지 0.810
```
`⚠` **0건**(zoompos 10677 이 표 범위 [0,16384] 안이라 클램프 없음).
PTZ 는 이동 없이 그대로다(`GET /viewer/api/ptz?cam=1&source=real-camera-2` →
`tilt −44.410909 / zoom 23.80853` = 17b 와 동일 → tiltpos 786 / zoompos 10677).

## 8. 오버레이 산출물

- **신규**: `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\reports\overlay_r17\real2_fixed.png`
- **보존**: `d:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent\reports\overlay_r17\real2_current.png`(17b · **삭제하지 않음**)

```
frameHash 73314b0e29b4  1920×1080  네이티브 zoompos 10677 tiltpos 786
hfov 13.77° · tilt 7.86° · 설치고 13m · f 7952.24px
직선 18 · 가설 8 · 코너 3 · 자동quad 2 · expectedBays 10
```
헤더 4번째 줄이 `zoomHfov 13점(model:cam-001 내장 실측표) · tilt 양수=아래(실측 확정)` 로 바뀌었다.

**육안 비교(전 vs 후)**: 17b 의 quad 는 실제 주차면 폭의 1/4 남짓한 얇은 조각이었고, 17c 의 quad 는
전방선 위에서 **주차면 1칸에 해당하는 폭**으로 커졌다. 크기 축은 goal 방향으로 움직였다.
★ **최종 판정은 리더 몫**이다.

## 9. 부작용·미검증 (은닉 금지)

- **★ 두 오버레이의 촬영 조건이 다르다 — 크기 외 지표를 직접 비교하지 마라.** 17b 는 **주간**,
  17c 는 **야간**(19:56 캡처)이다. 그래서 검출 직선이 48 → 18 로 줄고 quad 수가 5 → 2 로 줄었다.
  이 감소는 이번 변경 때문이 아니라 **조도** 때문일 가능성이 크다(구분 실험 미수행 = **미검증**).
  크기 축(f ×4.64)만이 이번 변경의 확정 효과다.
- **`expectedBays 10` 을 줘도 quad 가 1~2 개다.** f 가 커져 한 면이 화면에서 커진 만큼 프레임에
  들어오는 면 수가 준 것이 자연스러운 귀결이지만, 야간 조도 저하와 뒤섞여 있다. 검출 알고리즘·
  `expectedBays` 자동결정은 **18회차 소관**이라 손대지 않았다.
- **`지상고 자가보정` 이 f 1714 일 때도, f 7952 일 때도 규격 2.5m 에 ±2% 로 맞는다**(2.4947m vs 2.5447m).
  4.6배 다른 초점거리에서 같은 지표가 통과한다면 그 자가보정은 **f 오차에 둔감**하다는 뜻이고,
  17b 가 그 값을 "자기일관성" 근거로 인용한 것은 **약한 근거였다**. 원인 규명 미수행 = **미검증**.
- **설치고 13m 는 마스터 구두 실측**("약 13m"). 줄자 기록 없음 — 이번에도 그대로 뒀다.
- **`cam-001` 표를 `real-camera-2` 에 쓰는 것의 한계**: `presets.ts:7-9` 가 경고하듯 k 의 분모는
  개체차를 탄다. 다만 화각(`zoomHfov`)은 게인(k)과 다른 축이고, `lens_calib_result_real-camera-2.json`
  의 `verdict:"pass"` 가 이 개체에서 검증된 결과다. **그 검증 파일은 워크트리
  `.claude/worktrees/feat-lens-calib-web-ui/` 안에 있고 현재 브랜치 작업트리에는 없다** —
  이 라운드의 정당성이 그 파일에 걸려 있으므로 리더가 정본 위치로 승격할지 판단이 필요하다.
- **`roi.auto.apply` 는 이번에도 실호출하지 않았다**(마스터 제약). 17b 가 남긴 "제원이 갖춰져
  CONFLICT 관문을 통과하고 minIoU 에서 막힌다"는 분석은 **여전히 코드 확인만**이다.
- `real2_fixed.png` 의 `frameHash 73314b0e29b4` 는 RPC 실호출(`4f4d2c4ef584`)과 **다른 프레임**이다
  — 라이브 카메라라 캡처 시점이 다르면 프레임이 다르다(17b 와 같은 성질).
