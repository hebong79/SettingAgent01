# 클릭 → 그 지점으로 정확히 이동: 렌즈 캘리브레이션 코드 지도

> "광각 CCTV 화면을 마우스로 클릭하면 그 지점이 정확히 가운데로 온다"를 담당하는 코드가
> 어디에 어떻게 흩어져 있는지 정리한 문서. 2026-07-24 기준 코드 실사.

## 0. 먼저 짚을 것 — 이 시스템은 "곡면율(배럴 왜곡)"을 보정하지 않는다

찾으시는 "광각 렌즈 곡면율 캘리브레이션 테이블"에 해당하는 코드는 **없다**. `k1/k2` 같은
방사왜곡 계수를 추정하거나 언디스토션을 거는 경로는 이 저장소 어디에도 없다. 대신 실측으로
확인된 사실은 이렇다 (`tools/centering_calib` 105샘플, cam-001, 2026-07-14):

- 카메라 펌웨어의 `setcenter`는 **정확한 직선(tan/핀홀) 기하 + 1/cos(tilt) 짐벌 커플링**을
  이미 쓰고 있다. 팬 스윕과 틸트 스윕으로 각각 역산한 초점거리가 0.1% 이내로 일치한다.
- 틀린 것은 기하가 아니라 **상수 하나** — 펌웨어가 믿는 초점거리 `f_fw`가 실제 렌즈의
  `f_true`와 어긋난다. 줌인할수록 벌어진다.

그래서 실제로 테이블화된 것은 곡면율이 아니라 **줌별 스칼라 두 개**다:

| 테이블 | 뜻 | 쓰는 곳 |
|---|---|---|
| `ZOOM_HFOV_TABLE` (`{z, h}`) | 이 렌즈가 줌 z에서 실제로 보는 수평 화각 | **표시**(오버레이·역투영) |
| `CENTERING_GAIN_TABLE` (`{z, k}`) | `k = f_fw / f_true`, 클릭 편심을 미리 곱해줄 배율 | **조준**(클릭 센터링) |

프로젝트의 원칙 한 줄: **"조준은 펌웨어 모델, 표시는 tan 핀홀 — 둘을 섞지 말 것."**

---

## 1. 핵심 파일 — 여기만 보면 된다

### [packages/web-ui/src/camera-intrinsics.mjs](packages/web-ui/src/camera-intrinsics.mjs)
캘리브레이션 **테이블의 단일 원본(JS)**. 브라우저 오버레이와 Node 백엔드가 이 한 벌을 공유한다.

- [camera-intrinsics.mjs:27-41](packages/web-ui/src/camera-intrinsics.mjs#L27-L41) —
  `ZOOM_HFOV_TABLE`. 13개 앵커(z0 57.14° … z16384 2.39°). z≈16384에서 광학이 **포화**하고
  z15000→16384 구간에서 화각이 절반으로 꺾이므로 그 밴드에 앵커가 촘촘하다.
- [camera-intrinsics.mjs:113-128](packages/web-ui/src/camera-intrinsics.mjs#L113-L128) —
  `CENTERING_GAIN_TABLE`. 14개 앵커. **단조가 아니다**: 와이드 0.988 → z8000~14000에서 ~1.11
  (언더슈트 10%) → z16384에서 0.765 (펌웨어 모델이 먼저 포화해 이번엔 오버슈트).
- [camera-intrinsics.mjs:56-65](packages/web-ui/src/camera-intrinsics.mjs#L56-L65) —
  `sampleCurve()`: 구간선형 보간 + 양끝 **클램프**(외삽 금지, 렌즈가 포화하므로).
- [camera-intrinsics.mjs:218-227](packages/web-ui/src/camera-intrinsics.mjs#L218-L227) —
  **`applyCenteringGain()` — 클릭이 실제로 보정되는 지점.**
  ```js
  const k  = centeringGain(zoomPos, table);
  const ax = cx + (x - cx) * k;      // 프레임 중심 기준으로 편심을 k배
  const ay = cy + (y - cy) * k;      // 프레임 밖이면 clamp + clamped:true 보고
  ```
- [camera-intrinsics.mjs:167-207](packages/web-ui/src/camera-intrinsics.mjs#L167-L207) —
  `resolveIntrinsics()`: 프리셋 이름(`"cam-001"`) / 실측 객체 / 없음(=보정 안 함)을 해석.
  기기별 **opt-in**이다. 값이 없으면 보정 없이 원본 좌표로 조준한다.
- [camera-intrinsics.mjs:49-52](packages/web-ui/src/camera-intrinsics.mjs#L49-L52) —
  `vfovFromHfov()`: 표시용 세로 화각(tan). 조준 모델의 선형 비율(≈0.436)로 대체 금지.

보정 공식이 근사가 아니라 **정확한** 이유 (파일 주석 96-100행):
```
atan(k·dx / f_fw) == atan(dx / f_true)    ⟺    k = f_fw / f_true
```
초점거리 배율오차는 편심 비례 오차이므로, 편심을 k배 밀면 **모든 편심·모든 틸트에서** 상쇄된다.
위치별 오차 테이블도, 폐루프 재조준도 필요 없다.

### [packages/cctv-client/src/calibration.mjs](packages/cctv-client/src/calibration.mjs)
**테이블을 만들어내는 솔버.** 클릭 스윕 샘플 → 두 곡선.

| 함수 | 하는 일 |
|---|---|
| [`predictLanding()`:50](packages/cctv-client/src/calibration.mjs#L50) | 초점 f 가정 하에 클릭한 내용이 **어디 떨어져야 하는지** 3D 회전으로 예측 (펌웨어 모델 미사용) |
| [`fitTrueFocal()`:100](packages/cctv-client/src/calibration.mjs#L100) | 관측된 착지 픽셀을 가장 잘 설명하는 단일 `f_true`를 황금분할 탐색으로 피팅 |
| [`firmwareFocal()`:120](packages/cctv-client/src/calibration.mjs#L120) | 텔레메트리(PTZ 변화)만으로 `f_fw` 역산 — 영상 없이. 팬/틸트 두 경로가 독립 검증 |
| [`undershootSlope()`:145](packages/cctv-client/src/calibration.mjs#L145) | 잔차/편심 기울기의 **중앙값** = 운영자가 체감하는 오차 |
| [`usableSamples()`:65](packages/cctv-client/src/calibration.mjs#L65) | 약한 매칭(peak<0.6), 모호한 매칭(margin<0.02), 교차축 이상치 제거 |
| [`solveZoom()`:166](packages/cctv-client/src/calibration.mjs#L166) | 한 줌의 `{hfov, gain, residualPx, fitRmsPx}` |
| [`buildCalibration()`:200](packages/cctv-client/src/calibration.mjs#L200) | 전체 스윕 → `{zoomHfov, centeringGain, residual, skipped}` |

게인은 `f_fw/f_true`가 아니라 **잔차 기울기**에서 뽑는다(둘은 일치하지만 기울기가 열화에 강함,
164-166행). 검증 패스에서는 `g = 1 - k_applied/k_true` 관계로 이미 걸린 보정을 되돌려 계산한다.

### [apps/backend-core/src/frame-match.mjs](apps/backend-core/src/frame-match.mjs)
카메라가 알려줄 수 없는 유일한 값 — **"클릭한 내용이 이동 후 어디에 있나"** 를 측정.
BEFORE 프레임에서 클릭 주변 패치를 떼어 AFTER 프레임 중앙 근처에서 찾는다.
Zero-mean NCC, 1/4 스케일 coarse → 풀해상도 fine → 상관 피크 **포물선 보간(서브픽셀)**.
OpenCV 의존 없음(sharp만 사용) — [frame-match.mjs:1-19](apps/backend-core/src/frame-match.mjs#L1-L19).

### [apps/backend-core/src/calibration-manager.mjs](apps/backend-core/src/calibration-manager.mjs)
**인앱 캘리브레이션 잡** (설정 탭 버튼의 실체).

- [:30-39](apps/backend-core/src/calibration-manager.mjs#L30-L39) — 스윕 격자.
  전체: 줌 14단계 × (dx 6 + dy 2) = 112 클릭(≈20분). 검증: 3줌 × 6 = 18 클릭(≈3분).
- [`measureClick()`:108](apps/backend-core/src/calibration-manager.mjs#L108) — 한 샘플의 전 과정:
  앵커로 이동 → 정착 → 스냅샷 → `centerPoint({rawAim})` → 정착 → 스냅샷 → 매칭 → 잔차.
- **`rawAim: true`** ([:187](apps/backend-core/src/calibration-manager.mjs#L187)) — 전체 캘리브레이션은
  기존 보정을 우회한다. 안 그러면 재려는 대상을 보정 너머로 재게 된다. 검증은 반대로 보정을
  **켜고** 돈다(그게 검증의 질문이므로).
- [`explain()`:158](apps/backend-core/src/calibration-manager.mjs#L158) — 실패 사유를 dark/smooth/
  featureless로 구분해 보고. 측정 못 한 줌은 `incomplete`이지 **합격이 아니다**([:227-231](apps/backend-core/src/calibration-manager.mjs#L227-L231)).
- [:277-294](apps/backend-core/src/calibration-manager.mjs#L277-L294) — 실패·취소해도 **항상 원래 PTZ로 복귀**,
  샘플은 `localfiles/calibration/<device>/` 에 감사용 저장.

---

## 2. 테이블은 어떻게 만들어지나 (생성 절차)

한 줄 요약: **카메라에게 일부러 빗나가게 클릭시키고, 얼마나 빗나갔는지 영상에서 재서, 그 빗나감을
설명하는 초점거리 하나를 푼다.** 자를 대는 것도, 체커보드를 드는 것도 아니다 — 카메라가 자기
자신을 잰다.

### 2.1 한 샘플 = 한 클릭

[`measureClick()` calibration-manager.mjs:108](apps/backend-core/src/calibration-manager.mjs#L108)

```
1. 앵커 PTZ(사용자가 켜둔 그 구도) + 목표 zoom 으로 이동 → settleGoto()
2. BEFORE 스냅샷 + PTZ 읽기            ← ptzBefore
3. centerPoint({ x: 960+dx, y: 540+dy, rawAim: true })   ← 일부러 편심 클릭
4. 정착 대기 → AFTER 스냅샷 + PTZ 읽기  ← ptzAfter
5. locateClickedInJpegs(before, after, {clickX, clickY})
     → landedX/landedY  (클릭한 내용이 실제로 떨어진 위치)
6. residualX = landedX - 960,  residualY = landedY - 540   ← 이게 "덜 온 만큼"
```

완벽한 카메라라면 `landed == (960, 540)`, 즉 잔차 0이다. 실제로는 z8000에서 dx=480 클릭에
**48px 남는다**. 그 48px이 신호 전부다.

핵심은 3번의 **`rawAim: true`** — 전체 캘리브레이션은 이미 설치된 보정을 우회한다. 안 그러면
재려는 대상을 보정 너머로 재게 된다([:187](apps/backend-core/src/calibration-manager.mjs#L187)).

**"어디 떨어졌나"를 재는 법** ([`locateClicked()` frame-match.mjs:184](apps/backend-core/src/frame-match.mjs#L184)):

| 파라미터 | 값 | 이유 |
|---|---|---|
| 패치 | 클릭 주변 96×96 (`half=48`) | 무늬를 담기에 충분하고 회전 왜곡은 무시할 크기 |
| 탐색창 | 프레임 중심 ±368px (`search=320`) | 제대로 됐으면 중앙에 있어야 하니까 |
| coarse | 1/4 스케일(`step=4`) 전 창 | 후보 3개 추림 |
| fine | 풀해상도, 후보당 ±24px | 포물선 보간으로 **서브픽셀** |
| 유사도 | Zero-mean NCC | 두 스냅샷 사이 노출이 변하므로 SSD는 밝기를 쫓아감 |

샘플의 신뢰도는 **세 숫자**로 나온다:
- `peak` — NCC 점수. 0.6 미만이면 붙잡을 게 없었다.
- `margin` — 1등 로브가 2등보다 얼마나 높은가. **점수보다 이게 중요하다.** 실측 사례: 0.898 피크
  옆 8px에 0.897 로브 — OpenCV와 이 매처가 서로 다른 로브를 골랐고 **둘 다 10px 틀렸다**.
  점수는 아무것도 말해주지 않았고 margin(0.0008 vs 정상 0.04+)이 전부를 말했다.
- `contrast` — 패치의 RMS 대비. 실패 원인을 **"장면이 반복 무늬"** 와 **"화면에 아무것도 없음
  (야간·민무늬)"** 으로 가른다. 후자만 낮에 다시 오면 해결된다 (`LOW_CONTRAST = 12`).

### 2.2 어디를 몇 번 클릭하나 (스윕 격자)

[calibration-manager.mjs:27-39](apps/backend-core/src/calibration-manager.mjs#L27-L39)

```js
FULL_ZOOMS = [0, 2000, 3000, 5129, 8000, 10338, 12161,
              14000, 15000, 15400, 15800, 16100, 16384, 22000]   // 14
FULL_DX    = [-720, -480, -240, 240, 480, 720]                   // 가로 6 (dy=0)
FULL_DY    = [-300, 300]                                          // 세로 2 (dx=0)
                                            → 14 × 8 = 112 클릭 ≈ 20분
VERIFY_ZOOMS = [0, 8000, 16384]
VERIFY_DX/DY = [-600,-300,300,600] / [-300,300]  → 3 × 6 = 18 클릭 ≈ 3분
```

격자 설계 이유:
- **줌 앵커가 15000~16384에 몰려 있다** — 이 밴드에서 렌즈 화각이 절반(4.88°→2.39°)으로 꺾인다.
  성글게 재면 보간이 그 절벽을 직선으로 뭉개 거짓말을 한다.
- **22000이 있다** — 광학은 16384에서 포화하지만 펌웨어 모델은 계속 좁아진다고 믿는다. 그래서
  그 너머는 **오버슈트**로 부호가 뒤집힌다(실측 -33%). 호밍 근접 줌이 22000이라 반드시 재야 한다.
- **가로/세로를 따로 클릭한다**(dx만, dy만) — 팬 축이 월드 수직축이라 가로 클릭에는 짐벌 커플링
  1/cos(tilt)이 섞이고 세로 클릭에는 안 섞인다. 둘을 분리해야 두 독립 추정이 나온다.
- **교차축 잔차 검사**의 근거가 된다: 가로로만 클릭했는데 세로로 40px 넘게 움직였다면 매처가
  엉뚱한 걸 물었다는 뜻이므로 버린다([calibration.mjs:73-74](packages/cctv-client/src/calibration.mjs#L73-L74)).

### 2.3 샘플 → 숫자 (솔버)

[calibration.mjs](packages/cctv-client/src/calibration.mjs)에서 **완전히 독립된 세 경로**로 같은 답에 도달한다.
이 삼중화가 이 캘리브레이션을 믿을 수 있게 만드는 유일한 이유다.

**(a) `f_true` — 영상만 쓰는 경로** ([`fitTrueFocal()`:100](packages/cctv-client/src/calibration.mjs#L100))

측정된 before/after PTZ와 측정된 착지 픽셀만으로, "이 3D 회전이 이 픽셀 이동을 설명하려면
초점거리가 얼마여야 하나"를 푼다. **펌웨어 모델이 전혀 안 들어간다.**

```
클릭 픽셀 → 카메라 좌표 광선:   u = (clickX-960)/f,  v = -(clickY-540)/f
                                ray = F₀ + R₀·u + U₀·v          (before 자세 기저)
after 자세로 재투영:             x̂ = 960 + f·(ray·R₁)/(ray·F₁)
                                ŷ = 540 - f·(ray·U₁)/(ray·F₁)
비용:                            RMS( (x̂-landedX)² + (ŷ-landedY)² )   전 샘플
탐색:                            황금분할, f ∈ [400, 400000], 220회   (비용이 f에 단봉)
```
자세 기저 `basis()`는 `a = -pan/100°`, `e = -tilt/100°` (Hucoms 부호 규약: panpos+ = 시계방향,
tiltpos+ = 아래로) — [calibration.mjs:36-44](packages/cctv-client/src/calibration.mjs#L36-L44).

**(b) `f_fw` — 텔레메트리만 쓰는 경로** ([`firmwareFocal()`:120](packages/cctv-client/src/calibration.mjs#L120))

영상 없이, 카메라가 스스로 보고한 PTZ 변화만으로:
```
가로 클릭:  f = |dx| / ( tan|Δpan| · cos(tilt) )    ← 짐벌 커플링 포함
세로 클릭:  f = |dy| /   tan|Δtilt|                  ← 커플링 없음
```
**이 둘이 0.1% 이내로 일치한다는 사실이 "펌웨어 기하는 정확하다"의 증명이다.** 선형 모델이면
불가능하고, 커플링을 안 걸면 틸트 6°~33°에서 20% 흔들려야 한다.

**(c) `g` — 모델 없는 경로** ([`undershootSlope()`:145](packages/cctv-client/src/calibration.mjs#L145))

```
g = median( residual / d )     d = dx 또는 dy
```
운영자가 실제로 보는 것 그 자체. 중앙값이라 나쁜 매칭 하나가 흔들지 못한다.

**최종 게인은 (c)에서 뽑는다** ([`solveZoom()`:166](packages/cctv-client/src/calibration.mjs#L166)):
```js
k = gainApplied / (1 - g)          // g < 0.9 일 때만 (그 이상은 측정 실패)
```
`f_fw/f_true`와 일치하지만 기울기 쪽이 **열화에 강하다** — 초점 피팅 하나가 실패해도 게인은 안
흔들린다. `gainApplied`는 검증 패스용: 이미 보정이 걸린 채 잰 값에서 참 게인을 복원한다
(생성 패스는 rawAim이므로 1).

**화각은 (a)에서 뽑는다**:
```js
hfov = 2 · atan(960 / f_true)      // hfovFromFocal, calibration.mjs:158
```

같이 나오는 진단값:
- `residualPx = |g| × 480` — "1/4 프레임 클릭이 몇 px 빗나가나". 생성 패스에서는 **카메라가 가진
  오차**, 검증 패스에서는 **보정 후 남은 오차**. 같은 숫자, 반대 의미 — 검증이 별도 패스인 이유.
- `fitRmsPx` — 단일 초점이 모든 착지를 얼마나 잘 설명하나. 곡선 자체의 오차 막대.

### 2.4 줌 포인트 → 테이블

[`buildCalibration()`:200](packages/cctv-client/src/calibration.mjs#L200)

```
샘플 전체 → zoomAnchor 로 그룹 → 줌마다 solveZoom()
  ├─ hfov 와 gain 이 **둘 다** 나온 줌만 앵커로 채택
  │    (한쪽만 나온 줌을 넣으면 FOV 곡선에 구멍이 생기고 보간이 그걸 추측으로 덮는다)
  └─ 못 쓴 줌은 skipped[] 에 사유와 함께 남긴다 — 숨기지 않는다
앵커가 2개 미만이면 throw (장면 부족 / 카메라 미정착)

결과:
  zoomHfov      = [{ z, h: hfov.toFixed(2) }, ...]
  centeringGain = [{ z, k: gain.toFixed(3) }, ...]
  residual      = { beforePx: 최악 잔차, fitRmsPx: 최악 피팅오차, byZoom: {...} }
  skipped       = [{ zoom, usable, of, why }]
```

이 두 배열이 곧 [camera-intrinsics.mjs](packages/web-ui/src/camera-intrinsics.mjs)의
`ZOOM_HFOV_TABLE` / `CENTERING_GAIN_TABLE`과 **같은 모양**이다. 내장 프리셋 `"cam-001"`은
2026-07-14에 이 절차로 나온 출력을 소스에 박아 넣은 것이다.

읽을 때는 [`sampleCurve()`](packages/web-ui/src/camera-intrinsics.mjs#L56-L65)가 구간선형 보간 +
양끝 클램프. **외삽하지 않는다** — 마지막 앵커 너머는 렌즈가 포화하므로 그대로 유지가 맞고,
첫 앵커 아래는 존재하지 않는다.

### 2.5 저장

`POST /api/calibration/save` → [`saveDeviceIntrinsics()` control-api.mjs:862](apps/backend-core/src/control-api.mjs#L862)

```jsonc
// config.json — 해당 기기 엔트리 하나만 외과적으로 read-modify-write
"devices": { "list": [{
  "id": "cam-001",
  "intrinsics": {
    "model": "cam-001",              // 원래 프리셋명이 있었으면 보존 (기종 기록)
    "zoomHfov":      [{ "z": 0, "h": 57.14 }, ...],
    "centeringGain": [{ "z": 0, "k": 0.988 }, ...],
    "measuredAt": "2026-07-14T...",
    "residual": { "beforePx": 51.4, "fitRmsPx": 2.1, "byZoom": {...} }
  }
}]}
```
- 전역이 아니라 **그 기기에만** 들어간다 (개체의 성질이지 프로토콜의 성질이 아니므로).
- 임시파일 → `rename` 원자적 교체. config에는 비밀번호도 있어 통째 덮어쓰지 않는다.
- 구 `centeringGain` 키는 삭제한다 (둘이 남으면 드리프트).
- **백엔드 재시작 필요** (`pm2 restart baro-backend`).
- 감사용 원본 샘플은 `localfiles/calibration/<device>/<timestamp>-<mode>.json`.

### 2.6 검증 패스 — 만든 표가 맞는지

같은 스윕을 **보정을 켜고**, 3줌 18클릭만 돈다([calibration-manager.mjs:208-241](apps/backend-core/src/calibration-manager.mjs#L208-L241)).
질문이 "이 카메라에 지금 걸린 보정이 맞나?"이므로 보정이 루프 안에 있어야 한다.

| 판정 | 조건 |
|---|---|
| `pass` | 모든 줌 측정 성공 + 최악 잔차 ≤ **10px** (사람이 못 느끼는 경계) |
| `fail` | 측정은 됐는데 10px 초과 → 이 개체는 다른 값이 필요. 표의 "이 카메라에 필요" 열이 그 값 |
| `incomplete` | 한 줌이라도 측정 실패 → **합격이 아니다.** 못 본 줌을 통과시키는 게 최악의 결과 |

### 2.7 실제로 돌리는 법

**운영 (권장)** — CCTV **설정 탭 → 카메라 캘리브레이션**
1. **검증(3분)** 먼저. 내장 프리셋이 이 개체에도 맞는지 본다. 합격이면 끝.
2. 불합격이면 **전체 캘리브레이션(20분)** → 결과 표 확인 → **이 기기에 저장** → 백엔드 재시작.
3. 저장 후 다시 **검증**해서 잔차가 실제로 줄었는지 확인.

돌리기 전 조건 — 이건 권고가 아니라 **측정 가능 조건**이다:
- **밝을 때.** 야간·저조도는 노이즈 리덕션이 화면을 뭉개서 고배율부터 측정 실패한다
  (실측: 야간 z16384에서 6샘플 중 2개 너무 어둡고 3개 상관면이 평평).
- **차량·주차선처럼 무늬가 있는 쪽**을 향한 상태로. 하늘·빈 아스팔트는 찾을 게 없다.
- 스윕 중에는 다른 이동 API가 409로 차단된다([control-api.mjs:36-40](apps/backend-core/src/control-api.mjs#L36-L40)).
  실패·취소해도 카메라는 항상 원래 PTZ로 복귀한다.

**개발·교차검증 (파이썬 독립 구현)** — [tools/centering_calib/](tools/centering_calib/)
```bash
PY=tools/baro_detector_api/.venv/Scripts/python.exe   # cv2/numpy 있는 인터프리터

ZOOMS=0,5129,8000,12161 $PY measure_center.py         # 1) 스윕 (끝나면 원 PTZ 복귀)
ZOOMS=8000 TILTS=600,1500,2400,3300 $PY measure_center.py   # 틸트 커플링까지
$PY analyze.py ../../localfiles/centering/<run>/samples.json # 2) 분석
$PY verify_stream_fov.py                              # 3) 스트림/스냅샷 화각 일치 확인
```
운영 경로가 아니다. Node 매처가 OpenCV보다 엄격하다는 사실을 이 대조로 찾아냈다.

### 2.8 표를 손으로 고칠 때

- `ZOOM_HFOV_TABLE`을 고치면 **UE C++ 미러 `HucomsProtocol.h::ZoomPosToHFov`도 같이** 고쳐야 한다.
  이게 어긋나면 시뮬레이터가 렌더와 다른 표로 조준한다.
- 와이드 화각을 상수로 두 번 적기 금지 — [camera-projection.mjs:44](packages/web-ui/src/camera-projection.mjs#L44)가
  `ZOOM_HFOV_TABLE[0].h`를 기본값으로 읽는 이유다. 예전 `69.88`이 그렇게 측정보다 오래 살아남았다.
- 앵커는 **z 오름차순 · h/k 양수**여야 한다([`normCurve()`](packages/web-ui/src/camera-intrinsics.mjs#L152-L162)가 검증).
- 두 표는 **다른 축**이다. 조준용 게인을 표시에, 표시용 화각을 조준에 쓰지 말 것.

---

## 3. 클릭 한 번의 전체 경로 (마우스 → 카메라 회전)

```
브라우저                                     백엔드                         카메라
────────────────────────────────────────────────────────────────────────────────
mouseup (드래그 아님)
  cctv.html:661 window "mouseup"
  cctv.html:614 viewPoint(e)
    화면 px → 원본 프레임 px 로 환산
    (naturalWidth 기준, 미로드 시 1920×1080)
        │
        ▼ POST /barocalory/api/center {x, y, frameWidth, frameHeight, speed}
                                       control-api.mjs:153
                                         scalePointToHucomsFrame()  → 1920×1080 정규화
                                         getPtzPosition()           → 현재 zoompos 확보
                                             │
                                             ▼ client.centerPoint({x, y, zoompos})
                                       hucoms-camera-client.mjs:152
                                         #aimPoint() :104
                                           applyCenteringGain()  ← ★ 곡선 적용
                                             k = sampleCurve(CENTERING_GAIN_TABLE, z)
                                             (x,y) → 중심기준 k배 → 클램프
                                             │
                                             ▼ GET /cgi-bin/control/ptz_centering.cgi
                                                action=setcenter&type=point
                                                center.pointx/y = 보정된 좌표      ──► 회전
                                             │
                                       waitForPtzSettle()  ← 텔레메트리 정착
        ◄── {sent, ptz} ─────────────────────┘
  motion.settled()  ← 화면(MJPEG) 상 움직임이 멎을 때까지 (프리뷰 ~2초 지연 보정)
  finalizeCenterMarker()  → 마커를 화면 중앙 십자로
```

각 지점:

1. **화면 좌표 → 프레임 좌표** — [cctv.html:614-627](apps/backend-core/public/cctv.html#L614-L627) `viewPoint()`.
   `<img>` 표시 크기와 `naturalWidth/Height` 비율로 환산.
2. **클릭 vs 드래그 판정** — [cctv.html:667](apps/backend-core/public/cctv.html#L667) 8px 임계.
   드래그면 `/api/center-box`(박스줌)로 간다.
3. **API 진입** — [control-api.mjs:153-169](apps/backend-core/src/control-api.mjs#L153-L169).
   `zoompos`를 미리 읽어 클라이언트에 넘긴다(게인이 줌의 함수라 두 번 물을 필요 없게).
4. **보정 적용** — [hucoms-camera-client.mjs:104-110, 152-165](packages/cctv-client/src/hucoms-camera-client.mjs#L104-L165).
   `this.centeringGainTable`이 없으면(=시뮬레이터, 미보정 기기) 그대로 통과.
5. **박스줌 경로** — [hucoms-camera-client.mjs:167-196](packages/cctv-client/src/hucoms-camera-client.mjs#L167-L196).
   박스의 **중심만** 보정해 박스를 통째로 평행이동. 크기는 목표 줌을 정하는 값이라 건드리지 않는다.
6. **표시상 정착 대기** — [camera-preview.mjs:145-189](packages/web-ui/src/camera-preview.mjs#L145-L189)
   `watchDisplayedMotion()`. 64×36 다운샘플 프레임 차분으로 "화면이 멎었는지"를 본다.
   PTZ 텔레메트리 정착과 프리뷰 표시는 최대 ~2초 어긋나므로 마커 UI는 이쪽을 기준으로 움직인다.

---

## 4. 조준(aiming) 모델 vs 표시(display) 모델

같은 tan 기하지만 **역할이 다르고 섞으면 안 된다**.

### 조준 — 픽셀 → PTZ 델타
[`pixelToPtzDelta()` fov-convert.mjs:125](packages/cctv-client/src/fov-convert.mjs#L125).
펌웨어의 `setcenter`가 무엇을 하는지의 재현식. 픽셀을 카메라 좌표계 광선으로 되돌린 뒤,
그 광선이 새 광축이 되도록 팬/틸트를 푼다. 팬 축이 월드 수직축이라 **가로로만 클릭해도 틸트가
딸려 온다**(와이드·틸트 16.81°에서 dx=480 → dtilt=-62cd, 실측과 0 centidegree 일치).

### 표시 — 월드/PTZ → 픽셀
- [`projectWorldToPixel()` camera-projection.mjs:109](packages/web-ui/src/camera-projection.mjs#L109) —
  월드 좌표를 렌더된 픽셀로. UE `ProjectWorldToScreen`과 일치(sim `/scene/project`로 검증).
- [`ptzToWidePixel()` fov-convert.mjs:74](packages/cctv-client/src/fov-convert.mjs#L74) —
  근접 호밍된 PTZ를 와이드 프레임 픽셀로 역투영(주차면 점 오버레이).
- [`vlaDeltaToPixel()` fov-convert.mjs:24](packages/cctv-client/src/fov-convert.mjs#L24) —
  **선형** 모델. VLA 각도 델타가 선형 가정 하에 측정됐기 때문에 그 측정의 정확한 역함수.
  tan 변환과 섞지 말 것(주석 15-20행).

---

## 5. 운영 흐름 (UI · API · 저장)

| 단계 | 위치 |
|---|---|
| UI 카드 | [cctv.html:313-338](apps/backend-core/public/cctv.html#L313-L338) 설정 탭 → 카메라 캘리브레이션 |
| 결과 표시 | [cctv.html:1220-1305](apps/backend-core/public/cctv.html#L1220-L1305) 곡선 표·잔차·검증 판정 |
| API | [control-api.mjs:87-124](apps/backend-core/src/control-api.mjs#L87-L124) `/api/calibration/{status,start,stop,save}` |
| 점유 잠금 | [control-api.mjs:36-40](apps/backend-core/src/control-api.mjs#L36-L40) 스윕 중 모든 이동 API 409 |
| 저장 | [control-api.mjs:862+](apps/backend-core/src/control-api.mjs#L862) `saveDeviceIntrinsics()` → `config.json`의 `devices.list[].intrinsics` 만 외과적으로 read-modify-write (재시작 필요) |

절차: **검증(3분) 먼저 → 합격이면 끝 → 불합격이면 전체(20분) → 저장 → 백엔드 재시작.**
조건: 밝을 때, 차량·주차선처럼 무늬가 있는 쪽을 향해서. 야간·저조도는 고배율부터 측정 실패한다.

---

## 6. 검증·교차구현

- **단위 테스트**
  - [packages/cctv-client/test/calibration.test.mjs](packages/cctv-client/test/calibration.test.mjs) — 솔버
  - [packages/cctv-client/test/centering-gain.test.mjs](packages/cctv-client/test/centering-gain.test.mjs) — 게인 곡선·보간·클램프
  - [packages/web-ui/src/camera-projection.test.mjs](packages/web-ui/src/camera-projection.test.mjs) — 투영
  - [packages/cctv-client/test/fake-camera-client.test.mjs](packages/cctv-client/test/fake-camera-client.test.mjs) — 짐벌 커플링 재현
  - [apps/backend-core/test/control-api.test.mjs](apps/backend-core/test/control-api.test.mjs) — 클릭이 스케일돼 카메라로 가는 배선
- **독립 파이썬 구현(교차검증용)** — [tools/centering_calib/](tools/centering_calib/)
  `measure_center.py`(스윕) / `analyze.py`(분석) / `verify_stream_fov.py`(스트림·스냅샷 화각 일치).
  운영 경로는 아니다. Node 매처가 OpenCV보다 엄격하다는 사실을 이 대조로 찾아냈다.
- **C++ 미러** — UE 시뮬레이터 `HucomsProtocol.h::ZoomPosToHFov`. 표가 바뀌면 **같이 갱신**해야 한다.

---

## 7. 알려진 한계

1. **프레임 가장자리**(|dx| > 약 865px = 반폭의 90%): 보정 좌표가 `setcenter`의 0..1920 범위를
   넘어 클램프된다 → 부분 보정. `applyCenteringGain`이 `clamped: true`로 보고한다.
   완전 해결책은 `f_true`를 아는 지금, 목표 PTZ를 직접 계산해 `goptzfpos` 절대이동하는 것.
2. **개체차 미측정** — 실카메라 1대(cam-001)뿐. `k = f_펌웨어 / f_렌즈`에서 분자는 펌웨어 상수라
   같은 모델이면 공통이지만 분모는 개체차를 탄다. 그래서 프리셋은 자동 적용이 아니라
   **기기별 opt-in**이고 검증이 먼저다. 오차가 우리의 절반보다 작은 개체에 프리셋을 걸면
   보정이 오히려 오차를 키운다.
3. **시뮬레이터는 보정 금지** — UE sim은 자기가 렌더하는 표와 같은 표로 `setcenter`에 답하므로
   이미 정확하다(k=1). `verifyOnly` 플래그로 전체 캘리브레이션 자체를 막는다
   ([calibration-manager.mjs:256-258](apps/backend-core/src/calibration-manager.mjs#L256-L258)).
4. **박스줌은 중심만** 보정한다. 박스 크기(=목표 줌)는 별개 문제로 남아 있다.
5. **방사왜곡(곡면율)은 여전히 미모델링.** 현재 잔차(정중앙 클릭 1px, 보정 후 z8000에서 0.30%)
   수준에서는 tan 핀홀 + 초점 스칼라로 충분히 설명된다. 더 넓은 렌즈나 더 엄격한 요구가 생기면
   그때 별도 항으로 들어가야 한다.
