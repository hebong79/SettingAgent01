# 02 구현 — 개별 center+zoom 반경 게이트 + 줌 사다리

대상 계약: `_workspace/00_goal.md` · 설계: `_workspace/01_architect_plan.md` (B 모드 이터레이션 1)
작성: 2026-07-21 · 구현자
검증 상태: `npx tsc --noEmit` 통과 · 기존 vitest **184 파일 / 2147 테스트 전건 통과(무수정)**

---

## 1. 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `src/calibrate/platePtz.ts` | opts 3필드 추가 · 실패사유 3건 추가 · `centerOnPlate` 최초선정 게이트 · `captureDetectPick`(신규 private) · **`centerAndZoomByLadder`(신규 public)** · `recenterTo`(신규 private) |
| `src/calibrate/PtzCalibrator.ts` | `PlatePtzApi` 에 사다리 Partial 결합 · `centerOnPoint` 에 사다리 분기 + 기존 경로에 `initialRadiusNorm` 주입 · `ladderEnabled`/`pointRadius`/`ladderOpts`(신규 private) · 상수 1건 |
| `src/config/toolsConfig.ts` | `CalibrateSchema` 에 optional 4필드 추가(기본값 미기재 → 기존 config 파일 무수정 동작) |
| `src/api/calibrateRoutes.ts` | **무변경**(설계대로 — reason 은 그대로 통과) |
| `src/viewer/*` | **무변경**. `zoom_saturated` grep 결과 뷰어에 reason 한글 매핑 테이블이 **존재하지 않음**(설계 §9-4 미확인 항목 해소) → 신규 3건 추가 불요 |

영속화 경로 없음(사다리는 DB/JSON 에 쓰지 않는다) → round5 규약 대상 아님. 확인 완료.

---

## 2. 신규 시그니처

```ts
// platePtz.ts — 기존 2메서드와 동급의 3번째 공개 메서드(무상태·단독 호출)
async centerAndZoomByLadder(
  camIdx: number, presetIdx: number, point: NormalizedPoint, startPtz: Ptz,
): Promise<PlatePtzResult>

// platePtz.ts — 네이티브/기하 분기의 유일 지점
private async recenterTo(
  camIdx: number, p: NormalizedPoint, ptz: Ptz, gainRef: PtzGain,
): Promise<{ ok: boolean; ptz: Ptz; mode: 'native' | 'geometric' }>

// platePtz.ts — captureAndDetect 본체 + 기각 사유 관측용 부가정보
private async captureDetectPick(
  camIdx: number, presetIdx: number, ptz: Ptz, prior: NormalizedRect, radius: number | null,
): Promise<{ plate: PlateBox | null; rejected: boolean; count: number; nearestDist: number | null }>
```

`captureAndDetect` 는 `captureDetectPick(...).plate` 를 반환하는 얇은 래퍼로 축소 —
**기존 호출처 4곳(probeGain·centerOnPlate 루프·zoomToPlateWidth 2곳) 무변경, 동작 동일.**

```ts
// PtzCalibrator.ts — 기존 테스트 스텁(2메서드만 구현) 하위호환
type PlatePtzApi = Pick<PlatePtz, 'centerOnPlate' | 'zoomToPlateWidth'> &
  Partial<Pick<PlatePtz, 'centerAndZoomByLadder'>>;
```

---

## 3. 신규 상수·기본값과 근거

| 심볼 | 위치 | 값 | 근거 |
|---|---|---|---|
| `PlatePtzOpts.initialRadiusNorm` | platePtz | **기본 undefined = 게이트 없음** | 배치(`calibrateSlot`)는 `plateRoi` 미주입 → prior 가 화면중앙이고 acquire zoom 에서 판이 중앙을 크게 벗어날 수 있다. 무조건 게이트는 배치를 대량 미검으로 죽인다. **클릭 경로만 옵트인**이 유일하게 안전한 형태 |
| `POINT_MATCH_RADIUS_DEFAULT` | PtzCalibrator | **0.10** | 클릭정밀도 ±0.02 + 차체↔판 오프셋 ≤0.08 = worst 0.10 **이상**이면서 이웃 판 최소 간격 0.11 **미만**인 구간. 0.11↑ 이면 이웃 오채택이 되살아나 게이트가 무의미, 0.08(추적값)이면 차체 클릭 오프셋을 못 흡수해 정상 케이스를 죽인다 |
| `ladderMaxRungs` | platePtz | **8** | 1.5^8 ≈ 25.6배 → zoom 1 출발에서도 상한(36)을 사실상 소진. 실질 종료는 `clampZoom` 포화가 담당하고 이 값은 무한 루프 방지 바운드. `acquireLadderMaxSteps`(배치 **줌아웃** 사다리, 5)와 **별개** |
| `nativeAimSettleMs` | platePtz | **1000** | `RealPtzSource.centerOnPoint`(:237)는 `move`(:187)와 달리 `waitUntilSettled` 를 호출하지 않는다 → 직후 PTZ 조회가 슬루 중 값일 수 있고 그 값을 다음 rung 명령으로 쓰면 카메라가 날아간다. speed=50 큰 pan 슬루를 보수적으로 잡은 값. **★라이브 미측정 — 튜닝 대상** |
| `ZOOM_EPS` | platePtz | **1e-6** | zoom 은 1~36 배율이라 유효자릿수 훨씬 아래 = "clampZoom 이 더 못 올린다"만 잡고 정상 스텝(최소 ×1.5)은 오판 불가 |
| `LADDER_AIM_MAX_STEP` | platePtz | **90** | ★설계와 다름 — 아래 §5-1 참조 |
| `cfg.calibrate.pointZoomLadder` | toolsConfig | **'auto'** | 'auto'=네이티브 소스만 사다리 → 시뮬은 신규 코드 0줄 실행(회귀를 확률이 아니라 **구조**로 차단). 'always'=시뮬 통합 실험, 'off'=배포 없는 롤백 안전핀 |

재사용(신규 상수 없음): `maxZoomStepRatio=1.5` · `targetPlateWidth=0.20` · `widthTol=0.02` · `centerTol` · `settleMs=300` · `matchRadiusNorm=0.08`.

---

## 4. 핵심 구현 노트 (검증자·문서화 인계)

### 4.1 반경 게이트 (Requirement 1)
- `centerOnPlate` 의 **최초 선정만** `captureDetectPick(..., o.initialRadiusNorm ?? null)`.
  `zoomToPlateWidth:297` 은 설계대로 **건드리지 않았다**(체이닝 시 이미 판 박스가 prior).
- 기각 시 `reason: 'no_plate_near_click'` + **`logger.info({cat:'centering', phase:'gate', ...})`**.
  로그 필드: `click{x,y}` · `plates`(검출 판 개수) · `nearestDist`(최근접 판까지 거리) · `radius`.
  → 리더 지시(거짓 성공 제거를 마스터가 로그로 알 수 있어야 함) 충족.

### 4.2 줌 사다리 (Requirement 2)
- 순서: ①`recenterTo(point)` 1회 → ② rung 루프 `captureDetectPick(prior=화면중앙, gate)` →
  ③ 검출 시 `!isCentered` 일 때만 `recenterTo(판중심)` → ④ `isWidthConverged` 가 **유일한 성공 출구**.
- 다음 칸 zoom = `clampZoom(min(zoomForWidth(직행목표), zoom×1.5))` — 게인 무의존.
- 미검출 rung 은 눈먼 `zoom×1.5`(zoom-in 광학중심 보존 가정).
- 게이트: latch 전 `initialRadiusNorm`(0.10) / latch 후 `matchRadiusNorm`(0.08). rung 기각도
  `phase:'ladder'` 로그에 클릭점·판 개수·최근접 거리를 남긴다.
- **`move()` 직접 호출은 기하 폴백의 `recenterTo` 한 곳뿐**. 이동+캡처는 전부 `requestImage(ptz override)`
  원자 호출(기존 PlatePtz 불변식 유지). 카메라 접촉은 전부 `this.camera`(=`makePlatePtz` 2번째 인자로
  주입된 `CameraSourceClient`) — **`PtzCalibrator.this.camera` 로 새는 지점 0**(R5 검증 포인트, grep 확인 완료).

### 4.3 회귀 보호 (Requirement 4)
- `pointZoomLadder='auto'` 기본 → 시뮬(네이티브 미지원)은 `ladderEnabled()===false` → 기존 경로 그대로.
- `initialRadiusNorm` 기본 undefined → 배치 경로 완전 무영향.
- `PlatePtzApi` 는 `Partial` 결합 + 호출측 `if (ladder.centerAndZoomByLadder)` 존재 확인 →
  기존 makePlatePtz 스텁 테스트 전건 무수정 통과(확인됨).
- `mode:'point'`(`aimPointToCenter`) 및 `RealPtzSource` 는 **완전 무변경**.

---

## 5. 설계와 달라진 점 (전부 의도적 · 사유 명시)

### 5-1. 기하 폴백 조준 상한을 `o.maxStepDeg` → 신규 `LADDER_AIM_MAX_STEP=90` 으로 변경 ★설계 결함 보고
설계 §2.3 의사코드는 `aimPtzForPoint(p, ptz, gainRefAtZoom, o.maxStepDeg)` 였다. **그대로 두면 기하 폴백
경로(`pointZoomLadder:'always'`, 설계 T5)가 성립하지 않는다**: `maxStepDeg=5` 는 폐루프 미세보정용 클램프인데,
게인 −62@zoom1 에서 클릭 오차 0.3 은 **18.6°** 를 요구하므로 5° 로 잘려 조준이 6분의 1만 이뤄진다.
사다리의 재중심은 P 제어 반복이 아니라 **개방루프 1샷**이라 진동 방지 클램프가 필요 없고,
같은 성격의 `PtzCalibrator.PREAIM_MAX_STEP` 이 이미 90 을 쓴다 → 같은 값 채택(이상 게인 방어 상한).
네이티브 경로에는 영향 없음(장비 펌웨어가 변환).

### 5-2. 네이티브 재중심 후 zoom 은 조회값이 아니라 **명령값**을 유지
설계는 `ptz: await this.camera.getPtz(cam)` 를 그대로 쓰라고 했으나,
`setcenter` 는 zoom 을 건드리지 않으므로 조회 zoom 을 채택하면 장비 raw↔뷰어 좌표 왕복 반올림이
사다리의 zoom 상태에 누적된다. `{pan: cur.pan, tilt: cur.tilt, zoom: ptz.zoom}` 로 고정 —
이 파일의 명시 불변식("명령 PTZ 추적 · 응답 echo 불신")과 정합한다.

### 5-3. 미검출 최대줌 도달 시 `got.rejected` 면 `no_plate_near_click`
설계는 이 지점에서 `plate_not_found_at_max_zoom` 만 반환했다. 그러나 최대 줌까지 갔는데
**계속 반경 밖 판만 검출된 경우**는 LPD 한계가 아니라 클릭 위치 문제이므로 사유를 갈랐다.
마스터의 다음 행동이 정반대("클릭 다시" vs "LPD 확인")라 구분이 필요하다.

### 5-4. `everDetected` 변수 제거(설계 의사코드의 중복)
설계 의사코드의 `everDetected` 는 `latched` 와 항상 동일하게 갱신되고(`latched=true` 인 순간만 true),
`latched` 분기가 먼저 return 하므로 `everDetected ? ... : ...` 의 한쪽이 도달 불가 데드 브랜치가 된다.
`latched` 하나로 통합(사유 결정 결과는 동일).

---

## 6. 구현 중 발견한 사항 (리더 보고)

1. **설계 §9-4 해소**: `src/viewer` 전체에 reason 한글 매핑 테이블이 **없다**(`zoom_saturated` grep 0건).
   뷰어는 서버 reason 문자열을 그대로 노출하므로 신규 3건에 대한 뷰어 변경은 불필요.
2. **미확정 그대로 남은 항목**(은닉 금지):
   - `nativeAimSettleMs=1000` 은 **라이브 미측정**. 라이브 1회차에서 `phase:'ladder'` 로그의
     `errX/errY` 가 rung 마다 0.08 이내로 줄지 않으면(→`plate_lost` 빈발) 상향하거나
     `RealPtzSource.centerOnPoint` 에 `waitUntilSettled` 를 넣는 소스 수정을 이터레이션 2에 제안해야 한다.
     이번 이터레이션에서는 지시대로 **소스 무수정 + sleep 우회**로 처리했다.
   - 사다리는 **실카 통합 미검증**(기본 'auto' 라 시뮬 라이브에서 실행되지 않는다). 마스터 클릭에 100% 의존.
3. **시뮬 개별 클릭 성공률의 미세 변화 가능**: 리더 확정대로 반경 게이트가 시뮬 클릭 경로에도 적용된다.
   부정확한 클릭이 조용한 오채택 → `no_plate_near_click` 실패로 바뀐다(거짓 성공 제거, 회귀 아님).
   기각은 전부 `logger.info` 로 관측 가능하다.

---

## 7. 검증자(qa-tester) 인계 — 테스트 대상

설계 §8 의 T1~T6 을 그대로 권고하며, 아래를 추가 확인할 것.

| ID | 확인 사항 |
|---|---|
| T1 | `initialRadiusNorm=0.10`, 클릭점 0.30 거리 판 1개 → `ok:false`·`reason:'no_plate_near_click'`·`plate===null` |
| T1b | `initialRadiusNorm` **미주입** 시 기존 무게이트 동작(먼 판도 채택) — 배치 회귀 방지의 핵심 |
| T2 | 네이티브 스텁 카메라 → `centerOnPoint` 호출 ≥1, `requestImage` zoom 이 ×1.5 씩 증가, `ok:true`·`plateWidth∈[0.18,0.22]` |
| T3 | LPD 빈 배열 전 구간 → `reason:'plate_not_found_at_max_zoom'`, zoom 이 `zoomMax` 에서 정지 |
| T4 | 네이티브 없는 카메라 + `pointZoomLadder` 미설정 → `centerOnPlate`→`zoomToPlateWidth` 순 호출, `centerAndZoomByLadder` **미호출** |
| T5 | `pointZoomLadder:'always'` + 네이티브 없는 카메라 → 사다리를 타되 재중심이 `move`(기하)로 나감 |
| T6 | `source` 지정 시 주입 카메라만 접촉, 파이프라인 카메라 호출 0 (`calibratePointSource.test.ts` 확장) |
| T7 | `pointZoomLadder:'off'` → 네이티브 카메라여도 기존 경로(롤백 안전핀 동작) |

기존 회귀 기준: `centeringSlot`·`centeringOwnership`·`centeringPreAim`·`centeringBoundary`·
`calibrateRoutes.point`·`controlMath` **무수정 통과** — 현재 전건 통과 확인됨.

---

# [추가] QA 결함 회신 수정 — 03_qa_report.md §5-①②③④⑤ 대응

수정: 2026-07-21 · 구현자 (QA 회신 1차)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **187 파일 / 2187 테스트 전건 통과**
QA 지적 3건 모두 **타당하다고 판단해 전부 수용**했다(반박 없음). 이 3건 외 코드는 손대지 않았다.

## A. [높음] rung 상한이 표적을 잘라먹던 문제 (QA §5-①)

**진단 수용**: 내 근거 "1.5^8≈25.6"은 **실사용 값이 아니었다**. `config/tools.config.json:71` 의
`maxZoomStepRatio` 는 **1.3** 이고 `baseOpts()` 가 이 값을 사다리에 그대로 전달한다 → 사다리는
1.3^9 ≈ **zoom 10.60** 에서 포기하면서 "최대 줌에서 못 찾음"이라고 **오보**했다. 카메라는 36 까지 남아 있었고,
이번 작업의 표적인 **먼 차량이 정확히 그 지점에서 잘렸다**. 설계 §4("최대 zoom 은 clampZoom 에 전적 위임")를
고정 상수 8 이 배신하고 있었다.

**수정 방향**: 리더 지시대로 **큰 상수로 바꾸지 않고**, 실질 종료 조건을 `clampZoom` 포화에 두고
rung 수는 안전판으로만 쓴다.

| 항목 | 변경 |
|---|---|
| `PlatePtzOpts.ladderMaxRungs` | 기본 8 → **기본 undefined = 자동 산출**(ResolvedOpts 에서도 기본값 부여 금지) |
| `PlatePtz.ladderRungBudget(startZoom)` | **신규 private**. `ceil(log(zoomMax/startZoom)/log(ratio)) + LADDER_RUNG_SLACK`, `LADDER_RUNG_HARD_CAP` 로 바운드. 명시 주입 시 그 값 우선 |
| `zoomMax` 취득 | `this.camera.clampZoom(Number.MAX_SAFE_INTEGER)` — **clampZoom 위임 유지**(사다리가 독자 상한을 두면 이중 진실이 된다) |
| `LADDER_RUNG_SLACK = 4` | latch 이후 rung 이 항상 ×ratio 로 오르지는 않는다(직행 목표 zWant 가 더 낮으면 스텝이 작아지고, 재중심만 하는 칸도 있다). 목표 폭 부근 미세수렴 칸을 덮는 여유 |
| `LADDER_RUNG_HARD_CAP = 64` | `ratio` 를 1.05 같은 극단값으로 두면 예산이 수백 칸으로 폭주 → 런타임 하드 바운드. 실사용 최소 비율 **1.3 에서 필요한 14 칸의 4배 이상**이라 정상 설정을 절대 자르지 않는다 |
| `cfg.calibrate.ladderMaxRungs` | 주석 갱신 — **미지정 권장**(지정하면 중도 포기·오보 위험) |

`ratio ≤ 1` 방어: 확대 불가 설정이면 첫 rung 포화 판정이 즉시 종료시키므로 예산을 최소로 둔다(로그 폭주 방지).

**결과 확인**: ratio 1.3 → zoom **36 도달 후** `plate_not_found_at_max_zoom`. ratio 1.1 에서도 36 도달.

## B. [중간] 사다리가 줌아웃을 못 하던 회귀 (QA §5-②)

**진단 수용**: 상승 전용(`min(zWant, zoom×r)`)이라 목표보다 큰 판(=근거리 클릭)에 하강 경로가 없었다.
실카는 이제 `mode:'plate-zoom'` 이 사다리 전용이므로 **기존에 성공하던 근거리 클릭이 새로 실패**한다 —
마스터가 "가까운 건 되던데 이제 안 된다"고 할 회귀가 맞다.

- 다음 칸 zoom 을 **대칭 클램프**로 교체: `clampZoom(min(zoom×r, max(zoom/r, zWant)))`
  — 기존 `zoomToPlateWidth:333` 과 **동일 관용구**(선례 준수).
- 포화 판정을 `zNext <= zoom + EPS` → `|zNext - zoom| <= EPS` 로 교체(양방향 모두 막힌 경우만).
  폭 수렴은 그 위에서 이미 반환하므로 이 지점은 항상 미수렴 = 판정 의미 불변.

**결과 확인**: zoom 4·폭 0.30 → 줌아웃해 `ok:true`, `plateWidth ∈ [0.18,0.22]`, 기존 `zoomToPlateWidth` 와 동일 수렴.

## C. [낮음] 로그·사유 정합 (QA §5-③④⑤)

| 지적 | 수정 |
|---|---|
| ③ 포화 로그가 "폭 목표 미달" 고정 → 폭 **초과** 케이스에서 거짓말 | 문구를 `'사다리 zoom 포화(목표 폭 도달 불가)'` 로 중립화하고 `targetPlateWidth` + `shortfall:'under'|'over'` 필드로 **방향을 사실대로** 남김 |
| ④ rung 기각 로그의 `click` 필드가 오해를 부름(거리는 화면중앙 기준) | 기준점 `prior:{0.5,0.5}` 를 함께 남기고 필드명을 `nearestDist` → **`nearestDistFromPrior`** 로 변경. `click` 은 문맥용으로 유지 → 조준이 빗나가도(기하 폴백 게인 오차) 로그가 거짓이 되지 않는다 |
| ⑤ 사유가 **마지막 rung** 상태로만 갈림 | `rejectedEver` **기각 이력 누적** 도입. 최대줌 도달·rung 소진 두 출구 모두 `latched → 'max_iterations'` / `rejectedEver → 'no_plate_near_click'` / 그 외 `'plate_not_found_at_max_zoom'` 로 판정. 최대줌 로그도 `rejected`(마지막 rung) → `rejectedEver`(이력)로 교체 |

「중간에 latch 했다가 놓친 경우」는 이미 `latched && 미검출 → 'plate_lost'` 로 즉시 분기되어 있어
「처음부터 못 찾은 경우」와 이전부터 구분되고 있었다(추가 변경 불요) — ⑤ 의 실제 쟁점인
"기각 이력 vs 검출 0" 구분만 위와 같이 해소했다.

## D. 테스트 갱신 (QA 산출물 2건)

QA 가 **결함을 고정해 둔 특성화 테스트**라 수정 후 정당하게 실패했다. 결함이 사라졌으므로
"현행(결함) 동작 고정"에서 **"수정된 동작 보장"**으로 목적을 바꿔 갱신했다.

| 파일·블록 | 변경 |
|---|---|
| `test/platePtzLadder.test.ts` L0 | 「상한 8 이 10.6 에서 포기」 → 「ratio 1.3/1.1 모두 zoomMax 36 도달」 + 「`ladderMaxRungs` 명시 주입 시 그 값 우선(하위호환)」 3케이스 |
| `test/platePtzLadder.test.ts` L1 | 「줌아웃 불가 = zoom_saturated 고정」 → 「줌아웃해 목표 폭 수렴(`ok:true`)」 + 기존 `zoomToPlateWidth` 와 동일 수렴 대조 |

그 외 QA 신규 테스트 36 케이스 및 기존 회귀 전건은 **무수정 통과**.

## E. 여전히 남은 미검증 (은닉 금지 — 변동 없음)

QA §7 의 라이브 미검증 항목은 그대로다. 특히 **rung 수가 늘어난 만큼 최악 소요 시간도 늘어난다** —
ratio 1.3·zoom 1 출발이면 최대 18 rung, rung 당 `nativeAimSettleMs(1000) + settleMs(300) + 장비 슬루` 라
**최악 30초 이상**이 될 수 있다. 라이브 1회차에서 체감 시간을 반드시 채록해야 하며, 과도하면
`nativeAimSettleMs` 하향(실측 슬루 시간 기반) 또는 `maxZoomStepRatio` 상향으로 대응할 사안이다.
성공률(표적 = 먼 차량)을 얻기 위해 시간을 지불하는 트레이드오프이며, 잘라서 얻는 속도는 **오보를 동반한
거짓 실패**였다는 것이 이번 수정의 근거다.

---

# [추가] 수정 4 — latch 인지형 사다리 배율 (이터레이션 1 구현 마감)

수정: 2026-07-21 · 구현자 (리더 지시 회신 2차)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **187 파일 / 2192 테스트 전건 통과**

## A. 리더 근거의 코드 검증 (반박 없음 — 단 유보 1건)

지시받은 대로 반례를 찾으며 검토했다. **근거 1·2 는 코드로 확인되며 반박할 지점이 없다.**

**근거 ① "누적 드리프트는 칸수가 아니라 총 배율이 결정한다" → 참.**
`controlMath.predictCenterAfterZoom` 은 `c' = 0.5 + (c−0.5)·zTo/zFrom` 이다. rung 을 거듭한 합성은
`∏(z_{i+1}/z_i) = z_final/z_0` 로 **망원(telescoping) 소거**되어 경로에 무관하다 → `e_final = e_0 × z_final/z_0`.
게다가 **latch 이전에는 rung 간 재중심이 아예 없으므로**(재중심은 `got.plate` 분기에만 있다) 이 등식은
근사가 아니라 정확하다. 1.3 으로 14칸이든 2.0 으로 6칸이든 zoom 36 에서의 잔차는 **같다**.

**근거 ② "큰 스텝의 대가는 과확대뿐이고 대칭 클램프가 되돌린다" → 참.** 수정 2(대칭 클램프)가 들어간
뒤에는 latch 후 `max(zoom/r, zWant)` 로 줌아웃 복귀가 가능하다. 수정 2 가 이 수정을 안전하게 만든 것이 맞다.

### 유보 1건 (반박은 아니나 은닉 금지 — 실제 대가가 하나 더 있다)
"과확대의 대가는 없다"는 **반경 게이트를 고려하면 완전히 참은 아니다.** latch 조건은 "검출"만이 아니라
**"화면중앙에서 `initialRadiusNorm`(0.10) 이내"** 다. 잔차는 `e_0×k` 로 자라므로 latch 가능한 창은
`k ∈ [k_검출, 0.10/e_0]` 인 **유한 구간**이고, 성긴 스텝은 이 창을 **건너뛸** 수 있다.
(예: `e_0=0.03`, 검출 시작 k=3 → 창은 k∈[3, 3.33]. ×2.0 스텝이면 k=2→4 로 창을 통과해 버린다.)

**구조적 완화(추가 2줄)**: 성긴 배율을 **"LPD 검출이 0 건인 구간"에서만** 쓴다. LPD 가 후보를 내기
시작하면(반경 기각이더라도) `sawAnyPlate=true` 로 즉시 `maxZoomStepRatio` 로 되돌린다 —
후보가 보인다는 것은 이미 창 근처라는 신호이기 때문이다. 속도 이득은 **광각 완전 무검출 구간**(이번 작업의
표적인 먼 차량이 정확히 여기 있다)에 몰려 있으므로 이 보수화로 잃는 이득은 사실상 없다.

## B. 변경 내용

| 파일 | 변경 |
|---|---|
| `platePtz.ts` | 상수 `LADDER_PRELATCH_RATIO = 2.0`(근거 주석 — 특히 "칸수가 아니라 총 배율이 잔차를 결정한다"를 **되돌리려는 사람을 위해** 명시) |
| | `PlatePtzOpts.preLatchZoomStepRatio?` + `ResolvedOpts`(기본 2.0) — **파라미터화하되 기본값으로 동작**(config 필수 항목 추가 없음) |
| | 사다리 루프에 `sawAnyPlate` 도입. 미검출 줌인 스텝이 `sawAnyPlate ? maxZoomStepRatio : preLatchZoomStepRatio` |
| | `ladderRungBudget` 를 **`Math.min(maxZoomStepRatio, preLatchZoomStepRatio)`** 기준으로 산출 |
| `toolsConfig.ts` | `CalibrateSchema.preLatchZoomStepRatio` optional(min 1 max 4) |
| `PtzCalibrator.ts` | `ladderOpts()` 가 cfg 지정 시에만 전달(기존 필드들과 동일 패턴) |

**예산 정합(리더 지시 확인)**: 두 배율 중 **작은 쪽**으로 예산을 잡는다. 성긴 배율로 예산을 잡으면
정밀 배율이 지배하는 latch 후 구간에서 칸이 모자라 **목표 폭 직전에 잘린다**. 실사용에서는
preLatch(2.0) > max(1.3) 이라 사실상 max 기준 예산이며, 성긴 구간은 예산을 덜 쓸 뿐이라 낭비가 없다.
검증: ratio 1.3 config 에서 여전히 zoom 36 도달(L2 두 번째 케이스).

## C. 실측 효과 (테스트 로그 채록)

표적 재현 시나리오(광각 미검출 → 줌인해야 잡히는 먼 판, 목표 폭 0.20 = zoom 20):

| 설정 | latch 지점 | 총 캡처(=rung) | 결과 |
|---|---|---|---|
| latch 전 **2.0** / 후 1.3 (기본) | rung 3 (zoom 1→2→4→8) | **8** | ok, 폭 0.20 |
| latch 전 1.3 / 후 1.3 (구 동작) | rung 7 (zoom 1→…→6.28) | **13** | ok, 폭 0.20 |

rung 당 `nativeAimSettleMs(1000) + settleMs(300) + 장비 슬루` 이므로 **체감 소요가 약 40% 감소**한다.
`ratio 1.3 · zoom 1 출발 · 전 구간 미검출`의 최악 케이스는 구 14칸 → **6칸**(2^6=64 ≥ 36)으로 줄어
§E 에서 올린 "최악 30초+" 리스크가 구조적으로 완화됐다. 정밀도가 실제로 필요한 latch 이후 구간은
1.3 이 그대로 지배한다(L2 네 번째 케이스가 인접비 ≤1.3 을 고정).

## D. 테스트 추가 (`test/platePtzLadder.test.ts` L2, 5케이스)

| 케이스 | 확인 |
|---|---|
| 검출 0 구간은 2.0 으로 오른다 | 인접 zoom 비가 전부 2.0(마지막 clampZoom 칸 제외) |
| ratio 1.3 config 에서도 zoomMax 도달 | zoom 36 + `plate_not_found_at_max_zoom` |
| latch 까지 칸수 감소 | 동일 시나리오 대조로 캡처 수 8 < 13, **양쪽 다 `ok:true`**(결과 동등) |
| latch 이후 1.3 보존 | 첫 정밀 스텝 이후 인접비가 전부 `[1/1.3, 1.3]` 안 |
| 후보가 보이면 즉시 정밀 배율 | 반경 기각만 반복되는 프레임에서 인접비가 전부 ≤1.3 |

L0 세 번째 케이스(명시 주입 우선)는 두 배율을 모두 1.3 으로 고정하도록 갱신했다 — 그러지 않으면
latch 전 기본 2.0 이 섞여 **예산 상한만 관측**한다는 테스트 의도가 흐려진다.

구현 중 발견: 스텁 LPD 에는 "작으면 미검출" 모델이 없어(크기 무관 전건 반환) 처음 작성한 대조 테스트가
latch 전 구간을 만들지 못했다. `override` 훅으로 최소 검출폭(0.06)을 걸어 표적 상황을 정확히 재현했다.

## E. 이터레이션 1 구현 마감 상태

- 라이브 미검증 항목(설계 §9-1 setcenter 잔차 수렴 · `nativeAimSettleMs` 실측 · LPD 검출 시작 zoom)은
  **여전히 가정 그대로**다. 이번 수정은 그 가정을 바꾸지 않고 **소요 시간만** 줄인다.
- 다만 §A 유보에 따라 라이브에서 새로 볼 것이 하나 늘었다: `phase:'ladder'` 로그에서 **latch 직전 rung 의
  `plates` 가 0 이었는지**. 0 이 아닌데도 latch 를 못 하고 지나쳤다면 게이트 창을 건너뛴 것이므로
  `preLatchZoomStepRatio` 를 1.6 정도로 낮추는 것이 대응이다(config 한 줄, 코드 수정 불요).

---

# [추가] 수정 5·6 — 양방향 rung 예산 + 게이트 반경 zoom 스케일링

수정: 2026-07-21 · 구현자 (QA 재검증 R6-①/R6-②/R7 회신)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **187 파일 / 2197 테스트 전건 통과**
QA 실측 반례 2건 모두 타당. **반박 없음**(수정 6 의 기하 모델은 코드로 재확인 — §B).

## A. 수정 5 [중간] — `ladderRungBudget` 이 하강 칸수를 세지 않던 문제 (R6-①)

**진단 수용**: 수정 2(대칭 클램프)가 연 줌아웃 경로를 수정 1(자동 예산)이 잘랐다. `climbs = ceil(log(zoomMax/startZoom)/log(ratio))`
는 **등반만** 센다 → `startZoom` 이 상한 근처면 예산이 `LADDER_RUNG_SLACK(4)` 뿐인데 정작 필요한 건 하강 칸수다.

QA 가 지적한 **도달 경로가 실재한다는 점**이 결정적이다: 사다리는 실패해도 PTZ 를 복원하지 않으므로
카메라가 zoom 36 에 주차되고 **마스터의 다음 클릭이 정확히 이 조건**이 된다 = 연쇄 실패.

```ts
// 변경 전: const span = Math.max(zoomMax / z0, 1);
const span = Math.max(zoomMax / z0, z0 / zoomMin, 1);   // ★ 양방향
```
`zoomMin` 은 `camera.clampZoom(0)` 으로 카메라에게 묻는다(zoomMax 를 `clampZoom(MAX_SAFE_INTEGER)` 로 묻는 것과 동일 패턴 —
clampZoom 위임 유지). 근거는 주석에 남겼다.

**확인**: start zoom 36 · 큰 판 → 자동 예산으로 zoom 10.75 · 폭 0.215 · `ok:true`(L3-③).

## B. 수정 6 [근본] — latch 전 게이트를 누적배율로 스케일 (R6-② 의 원인 · R7 해소)

### B-1. 기하 모델 검증 (지시대로 먼저 확인 — 반박할 지점 없음)

`controlMath.predictCenterAfterZoom` 은 `c' = 0.5 + (c−0.5)·zTo/zFrom` 이고, rung 합성은
`∏(z_{i+1}/z_i) = z_final/z_aim` 로 망원 소거된다. latch 전에는 **rung 간 재중심이 아예 없으므로**
(재중심은 `got.plate` 분기 안에만 있다) 화면 전체가 `k = z_cur/z_aim` 로 **정확히 등방 확대**된다.
→ 표적 오프셋도 `e1·k`, 이웃 오프셋도 `d·k`. 관측 거리를 **고정 0.10** 과 비교하는 것은 축척이 다른 두 양의
비교였고, k 가 커질수록 게이트가 부당하게 엄격해져 latch 창이 `[k_검출, 0.10/e1]` 로 **닫혔다**. 리더 분석대로다.

### B-2. 변경

```ts
const k = ptz.zoom / aimZoom;   // aimZoom = 조준 완료 시점 zoom(조준은 zoom 불변 = startPtz.zoom)
const gate = latched ? o.matchRadiusNorm
           : o.initialRadiusNorm === undefined ? null : o.initialRadiusNorm * k;
```
- latch **후**는 지시대로 `matchRadiusNorm` **무변경**(매 rung 재중심이 있어 누적이 끊긴다 — 스케일 대상 아님).
- `centerOnPlate`(비사다리 경로)도 무변경. 확대 없이 1회 선정이라 k=1 = 기존 값 그대로다.
- rung 0 은 `k=1` 이라 정확히 기존 0.10 → **회귀 0**.
- 기각 로그에 `k` 와 `distAtAim`(= 관측거리/k, **원본 프레임 환산**)을 추가했다. 실제 판정이 이 값 대
  `initialRadiusNorm` 이므로 마스터가 로그만 보고 "클릭이 얼마나 빗나갔나"를 원본 축척으로 읽을 수 있다.

### B-3. 상한을 두지 않기로 한 판단(근거 주석 포함 — 지시 사항)

`k≥5` 면 반경이 0.5 를 넘어 사실상 무효로 보이지만, **그 zoom 에서는 원본기준 0.1 이상 떨어진 후보가
이미 프레임 밖이다**(0.1×5 = 0.5 = 화면 반폭). 즉 그 구간에서는 **프레임 자체가 게이트 역할**을 하므로
반경 상한은 판별력을 더해 주지 않고, 오히려 이번에 고치는 "창이 닫히는" 버그를 그대로 되살린다. → **상한 없음.**

### B-4. 판별력 보존 (1순위 목적 — 테스트로 고정)

원본에서 0.15 떨어진 이웃은 어느 zoom 에서든 관측 `0.15k` → 원본환산 0.15 > 0.10 → **기각**.
거짓 latch 방지력은 전혀 약해지지 않는다. 시작 zoom 1/2/5/12/30 전 지점에서
`ok:false · plate===null · no_plate_near_click` 을 고정했다(L3-②).

### B-5. `preLatchZoomStepRatio` 는 **2.0 유지**(지시 확인)

수정 6 이 원인(창이 닫힘)을 없애 창이 `[k_검출, ∞)` 가 되므로 배율을 낮출 이유가 사라졌다.
QA 스윕 반례(창 [3,4.65], 시작 zoom 21점)가 **2.0 에서 0/21 실패**로 바뀌는 것을 확인했고,
QA 가 지목한 대표 실패점(z0=1.2)에서 2.0 과 1.3 이 **동일하게 성공**한다 → 수정 4 의 속도 이득이 그대로 보존된다.
**낮춰야 한다는 근거를 찾지 못했다.**

## C. 테스트 (`test/platePtzLadder.test.ts` L3, 5케이스 · 실사용 config 값)

| 케이스 | 확인 |
|---|---|
| ① QA 스윕 반례 재현(창 [3,4.65], 시작 zoom 1.00~2.00 21점) | preLatch 2.0 에서 **실패 0/21**(고정 게이트 시절 6/21) |
| ①-b 대표 실패점 z0=1.2 | 2.0·1.3 **둘 다 ok** = 속도 이득 유지 |
| ② 이웃 거짓 latch 차단(시작 zoom 1/2/5/12/30) | 전 지점 `plate===null` · `no_plate_near_click` |
| ②-b 정상 대상(원본기준 0.05) | `ok:true` — 정상 케이스 미살상 |
| ③ 줌아웃 예산(start zoom 36 큰 판) | 자동 예산으로 `ok:true`, 폭 0.215±0.015 |

## D. QA 테스트 1건 픽스처 수정 — **비물리적 프레임이었다** (보고)

`T3 ★§5-3 분기` 케이스가 실패로 바뀌어 판정했고, **결함이 아니라 픽스처 결함**으로 결론냈다.

- 원 픽스처: `override: () => [stuck]` — 판을 **zoom 과 무관하게 화면 (0.85,0.5) 에 고정**한다.
  이는 사다리의 줌 모델(오프셋 ∝ k) 자체를 위반한다. 물리적으로 "관측 0.35 @ k=3.5" 는
  **원본 0.10 = 정당한 클릭 대상**과 수학적으로 구별 불가능하므로, 스케일된 게이트가 이를 채택하는 것은 옳다.
- 수정: 판을 월드에 두어 오프셋이 `0.35·k` 로 자라게 하고 클릭을 화면중앙으로(조준 no-op → "조준 프레임 = 시작 프레임"이 명확).
  **단언은 한 줄도 바꾸지 않았다** — `ok:false` · `reason:'no_plate_near_click'` · `plate===null` · `zoom 36` 그대로 통과한다.
  (QA 가 R4 에서 실효를 확인한 "저배율 기각 → 고배율 프레임 이탈 → `rejectedEver` 로 사유 보존" 경로와 동일한 물리다.)

## E. QA R7(설계 긴장) 해소

QA 격자표의 한계 — "먼 차량은 클릭이 판 중심에서 화면폭 1~2% 안이어야 한다" — 는 게이트가 고정이라서 생긴
것이었다. 스케일링 후 latch 조건은 `k_검출` 에 무관한 **`e1 ≤ initialRadiusNorm`(원본 프레임)** 이 된다.
내 §3 의 반경 근거("차체↔판 오프셋 ≤0.08 흡수")가 zoom 1 기준이라 사다리에서 성립하지 않는다는 QA 지적이 정확했고,
스케일링이 그 근거를 **모든 zoom 에서 복원**한다.

## F. 남은 미검증 (변동 없음)

실카 라이브(setcenter 잔차 · `nativeAimSettleMs` 실측 · LPD 검출 시작 zoom · 체감 소요)는 여전히 가정이다.
라이브에서 볼 항목이 하나 정리됐다: 기각 로그의 **`distAtAim`** 이 rung 마다 **거의 일정**해야 정상이다
(스케일링이 맞다면 원본 환산 거리는 rung 에 무관하다). 이 값이 rung 마다 커지면 조준 잔차가 아니라
**setcenter 잔차 또는 등방 확대 가정 위반**(펌웨어 광각 왜곡 보정)이 원인이라는 뜻이며, 그때는 게이트가 아니라
설계 §9-1 의 최대 위험이 실현된 것이다.

---

# [추가] 수정 7·8·9 — 라이브 실패 대응 (UI PTZ 재동기화 · 조준 정착 · rung 진단 계측)

수정: 2026-07-21 · 구현자 (마스터 실카 라이브 회신)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **189 파일 / 2213 테스트 전건 통과**

## ★ 최우선 보고 — 지시받은 (a) 검산 결과: **rounding 은 무죄, 원인은 config `zoomRange` 오설정**

### 1. 산술 검산 (rounding 가설 → **기각**)
실카 소스(`config/tools.config.json` 의 `real-camera-1`)에는 `ptz` 키가 없어 `zoomRange` 는 기본
`[0, 65535]` 다. `toNativePtz` 는 `mapRange(zoom, [1,36], [0,65535])` 후 `Math.round`:

| 뷰어 zoom | 계산 | 네이티브 raw |
|---|---|---|
| 14.310 | (13.310/35)×65535 | **24921** |
| 18.212 | (17.212/35)×65535 | **32229** |
| 23.183 | (22.183/35)×65535 | **41537** |

**셋 다 서로 다른 정수다.** 반올림으로 뭉개지지 않는다. 어떤 합리적 range 를 넣어도 마찬가지다
(예 [1,36] → 14/18/23). → **(a)-by-rounding 은 코드로 확정 기각.**

### 2. 그런데 로그가 진짜 원인을 확정해 준다 — 마스터 로그를 직접 열어 확인했다
`logs/setting_20260721_164233.log` 에 **정착 상한 초과 warn 이 5건** 있고 그 내용이 결정적이다:

```
target {pan:7829, tilt:1280, zoom:19127}  → last {pan:7829, tilt:1280, zoom:16384}  elapsed 5022ms
target {              ..., zoom:24922}    → last {              ..., zoom:16384}    elapsed 5084ms
target {              ..., zoom:32227}    → last {              ..., zoom:16384}    elapsed 5074ms
target {              ..., zoom:41536}    → last {              ..., zoom:16384}    elapsed 5140ms
target {              ..., zoom:65535}    → last {              ..., zoom: 6350}    elapsed 5137ms
```

- **pan/tilt 는 목표에 정확히 도달**(7829→7829, 1280→1280)했는데 **zoom 만 raw 16384 에서 멈춘다.**
- 16384 = **2^14**. 즉 이 장비의 실제 zoom raw 상한은 **16384 이지 65535 가 아니다.**
- 뷰어 zoom 으로 환산하면 상한은 `1 + (16384/65535)×35 ≈ **9.75x**`. 그 위 명령은 전부 물리적으로 불가능하고,
  매번 `waitUntilSettled` 5초 타임아웃을 태운다(로그의 rung 간 6.2초 = 5s 타임아웃 + 캡처 + LPD).

### 3. 이것이 로그의 모든 이상을 설명한다 — (b)도 기각
| 관찰 | 설명 |
|---|---|
| rung 5·6·7 의 errX/errY/plateWidth 가 소수 3자리까지 동일 | **카메라가 실제로 줌하지 않았다**(zoom raw 16384 고정) → 광학 상태 동일 → 동일 이미지 → LPD 결정적이므로 동일 출력. **낡은 프레임(b) 가설 불필요** |
| 명령 zoom 14→18→23 인데 plateWidth 0.169 고정 | 위와 동일 |
| rung 간 6.2초 | `waitUntilSettled` 5초 타임아웃 |
| rung 9 에서 plates 1→8, plateWidth 0.015 | target 65535 에서 last **6350** — 상한 초과 명령에 장비가 오히려 광각으로 되돌아갔다(줌 범위 밖 동작) |

**결론: (a) 확정 — 단 rounding 이 아니라 `zoomRange` 오설정. (b) 기각.**
따라서 지시대로 추측성 수정은 하지 않았고, 아래 조치만 취했다.

### 4. 필요한 조치 (코드 아님 — **리더/마스터 확인 후 config 1줄**)
```jsonc
// config/tools.config.json  sources[] 의 real-camera-1
"ptz": { "zoomRange": [0, 16384] }
```
근거: 위 5건의 실측이 전부 정확히 16384 에 고정. 다만 이것이 **광학 상한인지 특정 조건의 제한인지**는
장비 문서로 확인이 필요해 **내가 임의로 바꾸지 않았다**(설정을 잘못 좁히면 실제 도달 가능한 배율을 잃는다).
확정되면 `zoom 9.75x` 가 이 장비의 실제 최대이며, **사다리의 목표 폭 0.215 는 먼 차량에서 도달 불가**일 수 있다 —
그 경우 정직한 사유는 `zoom_saturated` 이고, `clampZoom`(뷰어 1~36)이 장비 상한을 모른다는 점이 남은 구조적 결함이다.

**권고(이번 범위 밖 — 리더 판단 요청)**: `move` 가 `waitUntilSettled` 타임아웃에도 `true` 를 반환해
사다리는 줌 명령이 성공한 줄 안다. 그래서 도달 불가 구간에서 5 rung × 5초 = 25초를 낭비했다.
`zoomAct` 가 오르지 않으면 사다리가 즉시 `zoom_saturated` 로 끝내는 것이 옳지만, 이는 요청 범위 밖이라 하지 않았다.

---

## A. 수정 7 — `web/app.js` `state.ptz` 부패 (마스터 지시)

방향 버튼(`stepPtz`)·절대이동(`resolveAbsPtz`)이 **`state.ptz` 기준으로 절대 목표를 계산**하는데, 서버 잡이
카메라를 움직여도 갱신되지 않아 **다음 조작이 낡은 위치로 되돌아갔다가 한 스텝 움직였다**(마스터 증상 그대로).

신규 헬퍼 `syncPtzAfterJob(responsePtz)`(`app.js` — `refreshCurrentPtz` 바로 뒤):
- **실카**: 응답 명령값을 믿지 않고 `refreshCurrentPtz({quiet:true})` 로 **장비 실측**을 읽는다
  (명령값은 슬루 중간에 잘리거나 광학 한계에서 클램프될 수 있다 — 위 §최우선보고가 그 실례다).
- **시뮬**: 응답 `ptz` 로 즉시 반영, 없으면 서버 조회 폴백.
- 양쪽 모두 `updatePtzDisplay()` 로 표시 동기화(마스터가 화면에서 현재 위치를 확인할 수 있게).

배선한 **카메라를 움직이는 잡 4곳(빠짐없이)**:

| 호출부 | 경로 |
|---|---|
| `calPointCenter` | 개별 센터라이징 **point/plate/plate-zoom 전부**(응답 `data.ptz` 전달) |
| `calPoll` 완료 전이 | 배치 센터라이징 |
| `discPoll` 완료 전이 | discovery(`/discover/*`) |
| 수집 폴 `wasActive` 전이 | 캡처(프리셋 순회 이동) |

**★ `web/` 은 nodemon 감시 밖이다 — 마스터가 브라우저를 새로고침(Ctrl+F5)해야 반영된다.**

## B. 수정 8 — 네이티브 조준 정착 대기 (가설 8 = **지지**, 다만 단독 원인은 아니다)

### B-1. 가설 판정
가설 8 자체는 **코드 경로로 확증**된다: `centerOnPoint` → `currentPtz()`(슬루 중 값) → 사다리가 그 값을
다음 rung 의 `requestImage` 로 명령 → `move`→`waitUntilSettled` 가 **카메라를 그 중간 지점까지 실제로 되돌린다**.
마스터 로그의 rung0(`k=1`, 조준 직후) `distAtAim` 이 **0.205 / 0.382 / 0.214** 로 게이트 0.10 의 2~4배인 것이
그 직접 증거다(정상 조준이면 0.1 이하여야 한다).

**다만 마스터가 본 "옆차 확대"의 주된 원인은 §최우선보고의 zoom 미작동이다** — 조준이 완벽했어도
zoom 이 9.75x 에서 멈췄으므로 먼 차량은 목표 폭에 도달할 수 없었다. 두 결함은 **독립**이며 둘 다 고쳐야 한다.
(가설 8 이 "단독 원인"이라는 전제만 부분 반박한다. 수정 자체는 옳다.)

### B-2. 변경
| 파일 | 변경 |
|---|---|
| `RealPtzSource.ts` | **`waitUntilStopped()` 신규** — 목표를 모르는 이동의 "정지까지" 대기. `waitUntilSettled` 와 달리 목표 근접을 요구할 수 없으므로 **움직임을 한 번 본 뒤의 정지**만 정착으로 인정(명령 직후 미출발 구간이 "연속 동일"로 보이는 함정 회피). 폴링 간격·타임아웃은 기존 `settlePollMs`/`settleTimeoutMs` 재사용 |
| | `SETTLE_START_GRACE_POLLS = 7` — 전혀 안 움직이면 no-op 판정. 근거: 150ms×7≈1050ms = 사다리가 지금까지 무조건 물던 고정 대기(1000ms)와 같은 크기. **ms 가 아니라 폴 횟수**로 표현해 폴링 주기를 주입해도 정합(테스트 결정성). 틀렸을 때 대가가 비대칭이라(길면 no-op 이 1초 대기, 짧으면 오조준) 짧게 잡지 않았다 |
| | `centerOnPoint` 가 `Ptz & {settled}` 반환. 타임아웃은 **warn 로그 + `settled:false`** — 삼키지 않는다 |
| `CameraClient.ts` | `NativeCenterResult extends Ptz { settled?: boolean }` 신규. **Ptz 확장이라 기존 구현·호출부 전부 호환**(옵셔널) |
| `CameraSource.ts` · `CameraSourceClient.ts` | 반환형 통과(pass-through)만 |
| `platePtz.ts` `recenterTo` | `settled === false` → warn + **`ok:false` → 사다리가 `aim_failed`**. 미정착 PTZ 로 다음 rung 을 명령하지 않는다 |
| | `settled === true` 면 **고정 sleep 생략**(소스가 이미 정착을 확인했으므로 순수 지연). `undefined`(정착 판정 미제공 소스)는 기존 `nativeAimSettleMs` 폴백 유지 → **제거하지 않고 폴백으로 남긴 이유** |

### B-3. `mode:'point'`(개별 center — 마스터가 "잘 된다"고 확인한 기능) 영향 평가
- **동작 개선, 퇴행 없음**: `aimPointToCenter` 는 `centerOnPoint` 결과를 그대로 응답에 싣는다.
  이제 그 PTZ 가 **슬루 중 값이 아니라 정지 위치**라 응답이 더 정확해진다(수정 7 의 `state.ptz` 동기화도 정확해짐).
- **체감 지연 증가**: 응답이 슬루 완료까지 기다린다(최대 `settleTimeoutMs` 5초). 기존에는 즉시 반환했다.
  마스터 체감상 "버튼 눌러도 응답이 늦다"로 보일 수 있으나, 그 대기는 **원래 카메라가 움직이는 시간**이고
  기존에는 그 사실을 숨기고 있었을 뿐이다. 라이브에서 과하면 `settleTimeoutMs` 하향이 대응(config 아님 — 생성자 주입).

## C. 수정 9 — rung 진단 계측 (**진단 목적 · 이번 로그로 원인은 이미 확정됐으나 재발 감시용으로 유지**)

지시대로 **기존 `phase:'ladder'` 구조·필드명 유지 + 가산만** 했다.

| 필드 | 의미 |
|---|---|
| `zoomCmd` | 명령 zoom(기존 `zoom` 과 동일 값 — grep 편의를 위해 짝으로 병기) |
| `zoomAct` / `panAct` / `tiltAct` | **장비 실측 PTZ**(`requestImage` 가 돌려주는 `cap.pan/tilt/zoom`). `zoomCmd` 는 오르는데 `zoomAct` 가 안 오르면 (a) 확정 |
| `bytes` / `sha` | 프레임 지문(`node:crypto` sha1 앞 8자). 인접 rung 의 지문이 같으면 (b) 확정 |

`captureDetectPick` 이 `act/bytes/sha` 를 함께 반환하도록 확장했다(기존 반환 필드 무변경).
sha1 은 프레임당 1회로 무시할 만한 비용이다.
계측은 검출 rung 로그·기각 로그·최대줌 warn·포화 warn **4곳 전부**에 실었다.

**★ 이 계측만 있었다면 이번 원인을 첫 클릭에 알 수 있었다** — rung 5·6·7 의 `zoomAct` 가 전부 같은 값으로,
`sha` 도 동일하게 찍혔을 것이다. 앞으로 같은 유형의 "명령은 나갔는데 장비가 안 따라옴"을 즉시 판별한다.

## D. 테스트

| 파일 | 내용 |
|---|---|
| `test/realPtzSourceCenterSettle.test.ts`(신규 5케이스) | 슬루 중→정지 시퀀스 스텁으로 ① 정지 확인 후 `settled:true` + **정지 위치** 반환 ② **★회귀 가드: 슬루 중 값(첫 폴링)을 반환하지 않는다** ③ 영원히 이동 중 → `settled:false` ④ 전혀 안 움직임 → 유예 폴 후 `settled:true`(무한 대기 없음) ⑤ 조회 미지원 소스 → 대기 없이 진행 |
| `test/platePtzLadder.test.ts` L4(신규 3케이스) | `settled:false` → `aim_failed` **이고 캡처 0회**(미정착 상태로 이동 명령을 내보내지 않음) / `settled:true` → 정상 진행 / `settled` 미제공 → 기존 폴백 |

기존 테스트 1건 갱신(`realPtzSourceCenterOnPoint.test.ts`): `expect(spy.ptzCalls()).toBe(1)` 이
정착 폴링 추가로 성립하지 않는다. 그 케이스의 계약은 "echo 가 없으니 **장비 조회로 확정**한다"이지
"정확히 1회"가 아니므로 `toBeGreaterThanOrEqual(1)` 로 완화했다(주석에 사유 기재).
같은 파일의 `new RealPtzSource(stubCfg)` 6곳에 폴링 주기 주입(`fastSettle`)을 추가 — 정착 대기가 생겨
케이스마다 1초씩 실시간 대기가 붙는 것을 막기 위함이다(검증 대상은 인자 계약이라 타이밍은 무관).

## E. 사다리 알고리즘 무변경 확인

지시대로 게이트 스케일링·배율(2.0/1.3)·rung 예산은 **한 줄도 건드리지 않았다**.
이번 변경은 (7) 뷰어 상태 동기화 · (8) 조준 정착 · (9) 로그 가산에 한정된다.

---

# [추가] 수정 10·11·12·13 — zoomRange 정정 · 포화 조기판정 · 정착 타임아웃 · 상한 도달 정책

수정: 2026-07-21 · 구현자 (마스터 OSD 확인 회신)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **189 파일 / 2220 테스트 전건 통과**

## 0. 검산 보고 (지시 사항) — 뷰어 36 → raw 16384 **정확히 일치**

`mapRange(zoom, [1,36], [0,16384])` 후 `Math.round`:

| 뷰어 zoom | raw | 비고 |
|---|---|---|
| 1 | 0 | 하한 |
| 9.75 | 4096 | (구 설정에서 이 지점이 이미 x36 이었다) |
| 35.9 | 16337 | |
| **36** | **16384** | ★ 장비 최대와 정확히 일치 — 검산 통과 |
| (구 설정 [0,65535]) 36 | 65535 | 범위 밖 → 장비가 6350 으로 튐 |

## 1. 실패 인과 사슬 (마스터 OSD `78/12/x36` 확인으로 완성 — 문서화 지시 사항)

```
config zoomRange [0,65535]  (사양서 최대 폭, 이 장비의 실제 상한 아님)
  └─ 뷰어 9.75 → raw 16384 = 이미 장비 x36 최대
      └─ 뷰어 12.5 / 18.2 / 23.2 → raw 21567 / 31435 / 41537 = 전부 범위 밖
          ├─ 장비는 16384 에 머무름 → **같은 물리 위치 = 같은 프레임**
          │    └─ 사다리 rung 5·6·7 의 errX/errY/plateWidth 가 소수 3자리까지 동일(로그 확인)
          │    └─ rung 마다 waitUntilSettled 5초 타임아웃 소진(rung 간 6.2초)
          └─ 뷰어 36 → raw 65535 = **범위 한참 밖**
               └─ 장비가 zoom 6350 으로 튐(로그 `last zoom 6350`)
                    └─ ★ 카메라가 엉뚱한 화각으로 이동 → **그 화면 중앙의 옆차가 latch**
                         = 마스터가 본 "옆차가 확대됨"의 **직접 원인**
```

즉 "옆차 확대"는 사다리 알고리즘의 결함이 아니라 **범위 밖 zoom 명령이 카메라를 날린 결과**다.
게이트·배율·예산은 정상 동작했고(빈 바닥에서 `no_plate_near_click` 정직 실패가 그 증거),
조준 정착 미보장(수정 8)은 이를 악화시킨 **독립적 2차 요인**이다.

## 2. 수정 10 — zoomRange 정정

| 위치 | 변경 |
|---|---|
| `config/tools.config.json` · `tools.config.example.json` | `cameraSources[]` 의 `real-camera-1`·`real-camera-2` 에 `"ptz": { "zoomRange": [0, 16384] }` 추가(외과적 텍스트 삽입 — 나머지 포맷 보존) |
| `RealPtzSource.ts` `HUCOMS_DEFAULT_ZOOM_RANGE` | **값 유지 [0,65535]** + 실측 근거 주석. 여기서 낮추면 실제로 65535 를 쓰는 다른 모델이 가용 배율의 3/4 을 조용히 잃는다. 신규 장비는 config 로 실측 상한 지정 |

### ★ 의미 변화 (은닉 금지 — 지시 사항)
- 뷰어 `zoom 36` 이 이제 raw 16384 = **장비 최대**에 대응한다.
- **지금까지 뷰어 zoom 은 명령 범위의 25%만 실제로 썼다** — 뷰어 9.75 이상은 전부 같은 물리 위치였다.
- 이 천장은 사다리만의 문제가 아니었다: **배치 센터라이징의 폭 수렴(`zoomToPlateWidth`)·UI 수동 줌·
  acquire 사다리** 등 zoom 을 쓰는 **모든 경로**에 동일하게 걸려 있었다. 배치 센터라이징이 일부 슬롯에서
  폭 수렴에 실패하던 과거 증상 중 일부는 이 천장이 원인일 수 있다(재측정 필요 — 미검증).
- **"36 = 광학 36배"라는 보장은 없다.** `VIEWER_ZOOM_RANGE [1,36]` 은 뷰어 공통 좌표계의 **스케일 라벨**일 뿐이고,
  장비의 실제 광학 배율과 선형 대응한다는 근거는 코드·문서 어디에도 없다. 마스터 OSD 가 `x36` 을 보고한 것은
  **장비 자신의 표기**이며 우연히 일치한 것일 수 있다. 폭 기반 목표(`targetPlateWidth`)를 쓰는 한 실무상 문제는 없다.

## 3. 수정 11 — zoom 실측 정체 판정 (포화를 성공으로 믿지 않는다)

`move` 는 `waitUntilSettled` 타임아웃에도 `true` 를 반환하므로 사다리는 줌 명령이 성공한 줄 안다.
`clampZoom` 은 **뷰어 범위**만 알아 장비 물리 상한을 모른다 → **실측(`zoomAct`)으로 판정**한다.

```ts
if (actLive && dCmd > EPS && dAct <= EPS) stall += 1; else stall = 0;
if (stall >= LADDER_ZOOM_STALL_LIMIT) → zoom_saturated
```

| 상수 | 값 | 근거 |
|---|---|---|
| `LADDER_ZOOM_STALL_EPS` | 0.05 (뷰어 배율) | 지시대로 **한 rung 미상승으로 단정하지 않는다**. 모터가 느려 5초 안에 목표에 못 닿는 정상 케이스가 로그에 실재하지만(목표 raw 8894 명령에 5초 후 9968 — 이동 중 미도달) **그 경우 실측은 분명히 변한다**. 진짜 포화는 실측이 **완전히 고정**된다. 그래서 "조금이라도 움직였으면 정상"으로 보고 ≈raw 50(@[0,16384])만 못 움직인 rung 만 센다 |
| `LADDER_ZOOM_STALL_LIMIT` | 2 | 1회 미상승은 폴링 타이밍·인코더 양자화로도 생긴다. 2회 연속이면 "명령은 올렸는데 두 칸 내내 제자리"라 물리 상한으로 단정할 근거가 된다 |
| `actLive` 가드 | — | ★ **실측이 명령을 따라 움직이는 것을 한 번이라도 확인하기 전에는 판정하지 않는다.** 응답 echo 를 신뢰할 수 없는 소스(Unity 시뮬은 0/0/1 고정)에서 "항상 정체"로 오판해 시뮬 전체를 죽이는 것을 **구조적으로** 막는다 |

효과: 상한 도달 후 **2 rung 만에 종료**(테스트: 캡처 ≤13, 자동 예산 19칸을 태우지 않음).

## 4. 수정 12 — 정착 타임아웃 5000 → 15000ms

근거(실측): `logs/setting_20260721_163311.log` 최악 관측 — 줌아웃 raw 16384 → 목표 2478(Δ13906) 명령에서
**5.03초 경과 시점 실측이 10095**, 즉 Δ6289 밖에 못 갔다(≈1250 raw/s). 같은 로그의 줌아웃 6건이 동일 양상.
이 속도면 전 구간(16384) 이동에 **약 13초** → **15초는 약 15% 여유**. pan/tilt 는 관측 전 사례에서 5초 내
목표 도달했으므로 지배 요인은 줌이다.

**트레이드오프(문서화 지시)**: 장비가 실제로 응답 불능이거나 도달 불가 목표를 받으면 이동 1회가
**최대 15초 UI 를 멈춘다**(기존 5초). 미정착 반환이 곧 오조준(센터링 부분 취소)이므로
"빨리 틀리는 것"보다 "늦게 맞는 것"을 택했다. 도달 불가 구간을 조기에 끊는 장치는 수정 11 이 담당한다
(둘은 짝으로 설계됐다 — 타임아웃을 늘리면서 낭비를 막는 장치가 없으면 체감이 크게 나빠진다).

## 5. 수정 13 — 장비 상한 도달 시 성공/실패 경계 (**동의 · 반박 없음**)

### 5-1. 자기 점검: 위장 성공 금지 원칙과 충돌하는가 → **충돌하지 않는다**

위장 성공의 정의는 이 작업 내내 일관되게 **"클릭한 대상이 아닌 것을 잡고 완료라 하는 것"**이었다
(Goal §1: "클릭 대상 ≠ 조준 대상인 거짓 성공이 0"). 수정 13 이 성공으로 바꾸는 상태는
**대상 신원(latch)과 정렬(중앙)이 모두 검증된** 상태이고, 미달한 것은 **장비의 물리 한계**뿐이다.
게다가 그 사실을 `widthShortfall`/`reason` 으로 **결과에 남긴다** — 정보를 지우지 않으므로 은닉이 아니다.

반대로 이것을 실패로 두는 쪽이 오히려 정직하지 않다: 마스터는 **화면상 성공인 결과를 보면서 실패 메시지를
읽고**, 취할 수 있는 다음 행동이 없다("더 확대하라"는 물리적으로 불가능). 실패 사유는 행동 가능해야 한다.

### 5-2. 금지선을 코드로 고정 (`saturatedOutcome`)
```ts
if (!latched || !plate || !err) return false;  // 대상 미확보 → 실패 유지
return isCentered(err, centerTol);             // 중앙 tol 밖 → 실패 유지
```
- **"상한 도달"은 사실 확인된 자리에서만** 이 함수를 부른다: ① `clampZoom` 포화 ② `zoomAct` 연속 정체(수정 11). 추정 판정 없음.
- 정렬 판정은 **그 rung 의 실측 err** 로만 한다. 재중심 명령만 내리고 측정하지 못한 상태는 성공으로 치지 않는다
  (그 경우는 여전히 `ok:false`). 보수적이지만 "검증되지 않은 것을 성공이라 하지 않는다"는 원칙에 맞다.
- `widthShortfall` 은 **성공·실패 무관하게** 세팅된다(실패 케이스에서도 정보 보존).

### 5-3. UI
`ok:true` + `reason` 조합이 라우트를 그대로 통과하므로, `web/app.js` 완료 메시지만 보완했다:
`개별 센터라이징 완료 — 장비 최대 배율(zoom_saturated)`. 마스터가 **더 확대되지 않는 이유**를 알 수 있어야 한다.

## 6. 테스트

| 블록 | 내용 |
|---|---|
| **L5**(3) | 상한 포화 → 2 rung 만에 종료 / **★오탐 가드: 모터가 느려 미도달이어도 움직이면 정체 아님** / **★회귀 가드: echo 고정 소스(시뮬)에서 판정 미발동 → 정상 수렴** |
| **L6**(4) | latch+중앙정렬+상한 → `ok:true` + `widthShortfall` + `plateWidth` 보존 / **★금지선 1: latch 실패 → 실패 유지** / **★금지선 2: 반경 밖 판만 → `no_plate_near_click` 유지(대체 금지)** / **★금지선 3: 게이트 안이나 중앙 tol 밖 → 실패 유지(단 정보는 보존)** |

기존 테스트 1건 정책 갱신(`T3 성공 출구는 폭 수렴 단 하나`): 수정 13 이 **의도적으로 바꾼** 경계라
`ok:false` → `ok:true` + `reason`/`widthShortfall` 보존으로 단언을 갱신하고, 변경 사유를 테스트 주석에 남겼다.
금지선은 L6 이 별도로 고정하므로 "성공 출구가 넓어졌다"는 위험은 테스트로 봉인돼 있다.

또한 L5 mock 의 물리 일관성을 바로잡았다: 보고 zoom 만 캡하고 이미지는 명령대로 확대되는 mock 은
실카에서 불가능한 상태라, 장비 실측 zoom 이 **LPD 가 읽는 캡처 기록에도 반영**되도록 고쳤다.

## 7. 남은 사항

1. **재측정 권고**: zoomRange 정정으로 zoom 천장이 3.7배 넓어졌다. **배치 센터라이징 폭 수렴률**과
   **시뮬 대비 실카 성공률**을 다시 재봐야 한다 — 과거 미수렴 슬롯 일부가 이 천장 탓이었을 수 있다.
2. `real-camera-2`(192.168.0.154)는 **실측하지 않았다.** 같은 기종이라 같은 값을 넣었으나 확인되지 않았다 —
   그 장비를 쓸 때 `zoomAct` 정체 로그로 검증할 것.
3. 사다리 알고리즘(게이트 스케일링·배율·예산)은 이번에도 **건드리지 않았다**.

---

# [추가] 수정 14·15·16 — 동기화 누락 전수 봉인 · 정지 조기반환 · 영속 zoom 출처 조사

수정: 2026-07-21 · 구현자 (QA 이터레이션 2 회신)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **191 파일 / 2246 테스트 전건 통과**
(QA 기준 190/2231 → 신규 2파일 15케이스 추가)

## A. 수정 14 — 카메라 이동 경로 **전수 조사**와 봉인

지시대로 열거를 그만두고 `move(` · `requestImage(ptz)` · `centerOnPoint` 를 소스 전수 grep 한 뒤
**app.js 가 부르는 모든 라우트를 서버 코드까지 따라가** 분류했다.

### A-1. 전수 분류표 (판정 근거 포함)

실카 기준 이동 조건: `snapshot(mode:'manual')`(=`requestImage` 에 **ptz 인자가 있을 때만**) 또는 `move()` 도달.

| 라우트 | 이동? | 근거 | 동기화 책임 |
|---|---|---|---|
| `/calibrate/point` | **O** | PtzCalibrator → 사다리/`centerOnPlate`/`aimPointToCenter` → `centerOnPoint`·`requestImage(ptz)` | `calPointCenter` (수정 7) |
| `/calibrate/ptz` | **O** | 배치 `calibrateSlot` → `requestImage(ptz)` | `calPoll` (수정 7) |
| `/discover/ptz` | **O** | `plateDiscovery:144` → `requestImage(presetPtz)` | `discPoll` (수정 7) |
| `/capture/start` | **O** | `CaptureJob:363 move()` + `:368 requestImage(t.ptz)` | `capPoll` (수정 7) |
| **`/capture/detect`** | **O** | `detectPipeline:332` 미귀속 차량마다 `requestImage(확대 ptz)` — **복귀 없음** | **`runLiveDetect` ← 신규 배선** |
| **`/capture/pipeline`** | **O** | 자동체인 discovering(앵커 loop LPD) / calibrating | **`pollPipeline` ← 신규 배선** |
| `/move` | O | 수동 이동 | 불요 — `move()` 가 `state.ptz` 를 **직접** 갱신(+실카는 실측 재조회) |
| `/capture/refframe`·`/capture/autocorrect`·`/capture/vehicle-cuboids` | **X** | `requestImage(cam, preset)` — **ptz 인자 없음** → `mode:'preset'` → 실카 `move()` 미도달 | — |
| `/snapshot` | X | `state.ptz` override 렌더 — UI 가 이미 아는 위치 | — |
| `/ptz` | X | 읽기 전용(동기화 자체가 쓰는 경로) | — |
| 나머지 27개(조회·DB·파일 IO·계산·LLM·RPC) | X | 카메라 미접촉 | — |

### A-2. 신규 배선 2건
- **S6-① `/capture/detect`**: `runLiveDetect` 에 `syncPtzAfterJob(null)` 추가.
  ★ **실패 경로(`!res.ok`)에도 넣었다** — 서버가 이미 몇 대를 확대·이동한 뒤 실패했을 수 있어
  성공 분기에만 걸면 같은 버그가 남는다(QA 가 지적한 "형태가 동일한 재발 경로").
- **S6-② 자동체인 `discovering`**: `pollPipeline` 에서 `discovering` 진입 시 `discPoll()` 재기동(기존 `calibrating` 대칭).
  추가로 **체인 종단(`done`/`failed`)에서 한 번 더 동기화** — 탐색 실패·LPD 타깃 0 종결은 `calibrating` 을
  거치지 않으므로 폴 전이만으로는 보장되지 않는다(QA 가 짚은 두 종결 경로).

### A-3. 봉인 (회귀 테스트 — 지시 사항)
`test/viewerPtzSyncCoverage.test.ts` (신규 11케이스, app.js **소스 정적 검사**):

| 케이스 | 봉인 내용 |
|---|---|
| **미분류 라우트 0** | app.js 의 모든 fetch 라우트가 `MOVES_CAMERA`/`NO_MOVE` 중 하나에 분류돼야 한다. **새 라우트가 추가되면 테스트가 실패하며 "이 라우트가 카메라를 움직이는지 판정하라"고 요구**한다 → 세 번째 누락이 구조적으로 불가능해진다 |
| 이동 라우트 6종 × 책임 함수 | 각 책임 함수 본문에 `syncPtzAfterJob` 존재 |
| `runLiveDetect` 실패 경로 | `if (!res.ok)` 블록 안에 동기화 존재 |
| `/move` 불요 근거 | `move()` 가 `state.ptz` 직접 갱신 + `refreshCurrentPtz` |
| 실카 분기 | `syncPtzAfterJob` 이 `selectedSourceIsReal()`/`refreshCurrentPtz`/`updatePtzDisplay` 유지 |

**한계(은닉 금지)**: 이 테스트는 app.js 를 **실행하지 않는다**(브라우저 전역 의존). 정적 검사이므로
"호출이 존재한다"는 보장하지만 "런타임에 실제로 발화한다"는 보장하지 않는다. S6-①/②의 실제 동작은
마스터 브라우저에서만 확인 가능하다(QA S8-3 과 동일 한계).

**S6-③(배치 잡이 `source` 미동봉 vs 동기화는 `state.source` 조회)은 손대지 않았다** — 지시 범위 밖이고,
단일 소스 운용에서는 드러나지 않는 구조적 불일치다. 리더 판단이 필요한 별건으로 남긴다.

## B. 수정 15 — 정지·목표미달 조기 반환

### B-1. `isNearTarget` 허용오차 검토 (지시 사항) → **원인 아님. EPS 무변경**
라이브 타임아웃 **41건 전수 분석**:

| 축 | target↔last 차이 |
|---|---|
| pan | 40건이 **0**, 1건만 1710 |
| tilt | 40건이 **0**, 1건만 526 |
| zoom | min 127 / **중앙값 4865** / max 59185 |

→ **40/41 에서 pan·tilt 는 이미 EPS(10) 이내로 도달**했고 zoom 만 미달이었다. 즉 "허용오차가 빡빡해서"가
아니라 **"장비가 도달할 수 없는 목표를 받아서"** 다. EPS 를 늘리면 진짜 미도달을 도달로 위장하게 되므로 건드리지 않았다.

### B-2. 구현
`waitUntilSettled` 가 수정 8 의 `waitUntilStopped` 관용구를 재사용해 두 조기 종료를 추가한다:
- **`stopped_short`**: 움직였다가 `SETTLE_STALL_SAMPLES(3)` 연속 동일 → 목표 미달이어도 반환
- **`no_motion`**: `SETTLE_START_GRACE_POLLS(7)` 동안 전혀 안 움직임 → 도달 불가 목표로 판단해 반환

`SETTLE_STALL_SAMPLES = 3` 근거: 150ms×3 = 450ms 무변화. 실측 줌 속도 ≈1250 raw/s 면 폴링당 ~187 raw 가
변하므로 **실제 이동 중에는 연속 3회 동일이 불가능**하다(인코더 양자화는 훨씬 작다). 2회면 폴링 지터 한 번에
정상 이동이 잘릴 수 있다. `no_motion` 에 유예를 둔 이유는 명령 직후 미출발 구간을 정지로 오판하지 않기 위함
(수정 8 과 동일한 함정 회피).

### B-3. ★수정 11 과의 충돌 검토 (지시 사항) → **충돌 없음, 같은 방향**
- 수정 15(전송 계층)는 **"더 기다릴지"만** 결정하고 **보고하는 PTZ 를 바꾸지 않는다** → 상위가 읽는 `zoomAct` 는 동일.
- 수정 11(제어 계층)은 그 `zoomAct` 가 2 rung 연속 정체면 `zoom_saturated` 로 종료.
- 둘은 같은 사실("장비가 안 움직인다")에 대해 **대기 단축 / 제어 종료**라는 같은 방향의 결론을 낸다.
  오히려 짝일 때 효과가 커진다: 정체 rung 이 15초 → **약 1초**가 되어 마스터 실패 케이스가 30초 → **2~3초**.

### B-4. 반환 계약을 바꾸지 않은 이유
`move()` 는 계속 `true` 를 반환한다. `stopped_short` 는 **통신 실패가 아니라 장비의 물리 한계**이고,
false 를 돌리면 ① 수동 이동 UI 가 "PTZ 이동 실패"로 보이고 ② 기하 폴백 경로가 `aim_failed` 로 죽는다.
제어 판정은 상위가 실측으로 하므로(수정 11), 이 계층의 책임은 **사실을 warn 으로 남기고 더 기다리지 않는 것**까지다.
warn 에 `target`/`last`/축별 차이(`d`)를 실어 호출측·마스터가 원인을 볼 수 있게 했다.

### B-5. 남는 한계
QA S4 의 "**느리지만 계속 움직이는** 장비" 최악 케이스는 **그대로 남는다** — 실제로 이동 중이므로 기다리는 것이
옳고, 조기 종료하면 미정착 오조준이 재발한다. 이 경우만은 rung 당 최대 15초가 정당한 비용이다.

## C. 수정 16 — 영속 zoom 17건 출처 조사 (**데이터 미변경**)

### 결론: **17건 전부 시뮬레이터 출처 → `zoomRange` 정정과 무관, 영향 없음.** 조치 불요.

### 근거 (추정 아님 — 로그로 확정)
1. `data/slot_ptz.json` 의 `createdAt = 2026-07-20T13:43:36.781Z` 를 **시간 범위로 포함하는 로그**를 특정:
   `logs/setting_20260720_222249.log` (13:22:49 ~ 14:15:18 UTC).
2. 그 세션의 소스 지표:
   - **hucoms/ptzfpos/ptz_centering 언급 = 0건**
   - unity/rpc/req_img 언급 = **722건**
   - 정착 대기 warn = **0건** (실카 세션은 예외 없이 발생)
3. **동일성 확증**: 그 로그의 `"zoom":9.897577185761017` 이 저장된 slot 16 의 `9.89758` 과 **소수점까지 일치**.
   → 이 로그가 그 데이터를 만든 바로 그 세션이다.
4. 교차 확인: 실카 세션 전체(0721_14*·16*)에서 **배치 센터라이징 지표 0건** — 실카로는 영속화를 한 번도 하지 않았다.
5. DB `slot_setup` 의 zoom 보유 17행(5.81159~19.7325)이 JSON 과 동일 집합 — 별도 출처 없음.

### 부수 확인 (자기 정합성)
시뮬은 `zoomRange` 를 쓰지 않고 뷰어 zoom 을 그대로 사용하므로 **의미 변화 자체가 없다**.
또한 이 17건은 zoom 5.8~19.7 전 구간에서 `plateWidth ≈ 0.20` 으로 매끄럽게 수렴해 있는데, 구 매핑 실카였다면
zoom 9.75 초과 14건이 **전부 같은 물리 배율**이라 이런 분포가 나올 수 없다 — 로그 증거와 독립적으로 일치한다.

### 마스터 선택지
**조치 불요.** 실카로 채운 셋업이 없으므로 재수집·환산 모두 불필요하다.
단, **앞으로 실카로 배치 센터라이징을 돌리면** 그때 기록되는 zoom 은 새 매핑 기준이며,
구 매핑 시절 실카 기록과 섞이지 않는다(현재 그런 기록이 0건이므로 혼재 위험 자체가 없다).
향후 혼동을 막으려면 레코드에 소스 id 를 남기는 것이 근본 대책이나, 스키마 변경이라 **이번 범위 밖**으로 남긴다.

## D. 테스트 추가

| 파일 | 케이스 |
|---|---|
| `test/viewerPtzSyncCoverage.test.ts`(신규 11) | A-3 표 |
| `test/realPtzSourceCenterSettle.test.ts`(+4) | ★정지·목표미달 조기 반환(타임아웃 미소진) / 무이동 조기 반환 / **★오탐 가드: 느리지만 계속 움직이면 목표까지 대기** / 정상 도달은 종전대로 |

## E. 사다리 알고리즘

이번에도 **건드리지 않았다**(게이트 스케일링·배율·예산·수정 13 판정 전부 무변경).

---

# [추가] 수정 17·18·19 — 상한 지점 최종 확정 · 최선 상태 복귀 · UI 이동 기준 실측화

수정: 2026-07-21 · 구현자 (마스터 2차 실카 검증 회신)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **191 파일 / 2251 테스트 전건 통과**

## 0. ★수정 18 원인 조사 결과 (보고 필수 항목) — **진동(limit cycle)이며, 원인은 선형 줌 모델의 붕괴**

`logs/setting_20260721_183256.log` rung 4~9 는 1회성 사고가 아니라 **3회 반복되는 진동**이다:

| rung | zoom | plateWidth | sha |
|---|---|---|---|
| 4 | 36 | 0.238 | 290f2462 |
| 5 | 32.481 | **0.102** | b28a3d4f |
| 6 | 36 | 0.240 | 0a90429f |
| 7 | 32.202 | **0.100** | 0ab64c77 |
| 8 | 36 | 0.238 | 6bacdcd2 |
| 9 | 32.503 | **0.102** | bd757505 |

`sha` 가 매번 달라 "낡은 프레임"이 아니고, `zoomAct` 가 명령을 정확히 따라가 "장비 미작동"도 아니다.
**같은 판(plates:1, errX≈0)이 실제로 그만큼 작아진 것**이다.

### 근본 원인: `width ∝ viewer zoom` 선형 가정이 상단에서 깨진다
같은 로그의 실측으로 `w/z` 를 계산하면:

| viewer zoom | 16.0 | 20.8 | 27.0 | 35.2 | **36** |
|---|---|---|---|---|---|
| w/z | 0.00131 | 0.00139 | 0.00207 | 0.00447 | **0.00661** |

**5배 변화**한다. 특히 zoom 35.153 → 36 (배율 ×1.024)에서 폭이 0.157 → 0.238 (**×1.52**) 로 뛴다.
이유: 뷰어 zoom [1,36] 은 **raw 엔코더 단위의 선형 사상**이지 **광학 배율의 선형 사상이 아니다**.
실제 렌즈는 raw 상단 구간에서 배율이 급격히 증가한다.

### 그래서 진동이 성립한다
```
zoom 36,   w 0.238 → zWant = 36 × (0.215/0.238)   = 32.5   (선형 예측 w=0.215)
zoom 32.5, w 0.102 (실측)                                    ← 예측 절반 이하
        → zWant = 32.5 × (0.215/0.102) = 68.5 → clampZoom 36 → w 0.238 → 반복
```
완전한 극한 순환이다. 로그의 3주기와 정확히 일치한다.

### 이번 조치와 남은 권고
- **이번 수정 18 은 "끝나는 지점"을 고친다**(최선 폭 지점 복귀). 진동 자체는 남는다.
- **근본 해결은 `zoomForWidth` 의 선형 목표를 상단에서 쓰지 않는 것**이다(측정 2점 기반 할선/이분 탐색).
  이는 사다리 제어 수식 변경이라 "알고리즘을 건드리지 마라" 지시 범위 밖이므로 **하지 않았다.**
  → **다음 이터레이션 권고**: 목표를 지나친 rung 이 나오면 그 rung 과 직전 rung 사이를 **이분 탐색**하도록
  전환(선형 외삽 금지). 진동이 사라지고 rung 수도 줄어든다.

## 1. 수정 17 — 장비 줌 상한 지점을 최종 위치로 (마스터 직접 요청)

마스터 원문: *"36배줌 해도 번호판이 20% 안되면 거기서 그부분이 최종위치가 되도록."*
로그 실패: `rung 3 zoom 36 errX 0.053 plateWidth 0.185 → ok:false` — 수정 13 의 `saturatedOutcome` 이
**정렬을 전제로 요구**해서 `errX 0.053 > centerTol 0.03` 에 걸렸다.

**변경: 정렬을 전제로 요구하지 않고 만든다.** 신규 `finalizeAtDeviceLimit()` 가 상한 도달 두 지점
(`clampZoom` 포화 · `zoomAct` 정체) **모두**에서 다음을 수행한다:

1. latch 실패 → **카메라를 건드리지 않고 실패**(금지선 — 정렬을 만들 대상 자체가 없다).
2. **현재 위치에서 먼저 실측**. 이미 tol 안이면 그 자리가 최종(`attempts:0`).
3. tol 밖이면 **방금 잰 판 중심**으로 마지막 재중심 1회(줌 상한에서도 setcenter 는 동작).
4. **재확인 캡처**로 실측 → tol 안이면 성공, 아니면 **실패 유지**("했으니 됐다" 금지).

결과·로그에 `recenterAttempts` 와 최종 `errX/errY` 를 남긴다. `widthShortfall` 은 성공해도 보존한다.

### ★구현 중 발견한 결함 (자체 발견·수정)
첫 구현은 호출 시점의 `plate`/`err` 로 재중심했는데, **그 값은 rung 내 재중심이 이미 나간 뒤라면 낡은 값**이다.
낡은 중심으로 다시 밀면 같은 오프셋을 **두 번** 적용해 반대편으로 넘어간다(실측: err 0.06 → 재중심 → **−0.06**).
→ 위 2단계(**먼저 실측**)를 넣어 해결했다. "최종 위치"라고 말하려면 그 자리를 직접 재야 한다는 원칙과도 맞다.

## 2. 수정 18 — 최선 상태 복귀

- rung 마다 `|plateWidth − targetPlateWidth|` 최소 지점을 `best` 로 기억한다.
- 종료 시 현재가 최선보다 **`widthTol` 보다 더 나쁘면** 최선 지점으로 복귀한다(새 임계 없이 기존 `widthTol` 재사용 —
  "우리가 신경 쓰는 허용오차보다 더 나쁠 때만" 되돌린다).
- 복귀도 **실측으로 확인**한다. 재검출 실패 시 위치만 복귀하고 **실측을 위장하지 않는다**(warn + `plateWidth:null`).
- 적용 지점: **예산 소진(`max_iterations`)** 과 **`plate_lost`**. 결과에 `restoredToBest` 를 남긴다.
- **포화 경로에는 적용하지 않았다** — 포화는 `zWant ≥ zoomMax`(즉 폭이 목표 미달)일 때만 성립하므로
  그 지점이 곧 도달 가능한 최선이다. 적용해도 아무것도 바꾸지 않으므로 넣지 않았다(근거 있는 생략).

관측 케이스 검산: best = rung 4/6/8 (0.238, Δ0.023), 마지막 = rung 9 (0.102, Δ0.113) → 차이 0.090 > widthTol 0.015 → **복귀**.

## 3. ★거짓 성공 금지선 재점검 (지시 사항) — **7건 전부 여전히 차단됨**

성공 판정을 넓히는 변경이므로 QA 반례를 코드 경로로 다시 대조했다.

| 금지선 | 차단 지점 | 상태 |
|---|---|---|
| latch 실패(검출 0) | `finalizeAtDeviceLimit` 1단계에서 즉시 실패, 카메라 미접촉 | **차단** (L6·L7 테스트) |
| 반경 밖 판만 검출 | 게이트가 `plate=null` → latch 안 됨 → 위와 동일 | **차단** (L3·L6) |
| 재중심 후에도 tol 밖 | 4단계에서 `isCentered` 실패 → `ok:false` | **차단** (L7) |
| 재확인에서 대상 소실 | `again.plate` 없음 → `ok:false` | **차단** (코드 경로) |
| 재중심 명령 거절 | `re.ok` false → `ok:false` | **차단** (코드 경로) |
| 이웃 갈아타기 | 재확인 캡처가 `matchRadiusNorm` 게이트 사용 → 이웃은 기각 | **차단** |
| 폭 미달 은닉 | `widthShortfall`·`reason` 이 성공에도 보존 | **차단** |

**넓어진 것은 "정렬을 만들 기회 1회"뿐이고, 성공 조건 자체(latch + 실측 정렬)는 그대로다.**
수정 18 의 복귀도 성공 판정을 만들지 않는다(`ok` 를 바꾸지 않고 종료 **위치·보고 값**만 최선으로 되돌린다).

## 4. 수정 19 — UI 이동 기준을 장비 실측으로

로그 확증: `pan=3512/tilt=1184`(센터링 완료) 직후 UI 줌아웃이 `pan=4721/tilt=1116`(센터링 **이전** 값)을 보냈다.

신규 `moveBasePtz()`:
- **실카**: 이동 직전 `refreshCurrentPtz({quiet:true})` 로 장비 실측을 읽어 그것을 기준으로 삼는다.
  → 캐시가 낡을 **구조적 경로 자체가 사라진다**(다른 클라이언트·장비 컨트롤러·동기화 실패·캐시된 옛 스크립트 전부 무관).
- **조회 실패 시 이동하지 않는다** — `null` 반환 + 상태 문구 표시. 낡은 값으로 조용히 점프하는 것이 이번 증상이다.
- **시뮬은 기존 경로 유지**(근거): 명령이 곧 상태이고(응답 즉시 반영) 라이브뷰도 `state.ptz` override 로 렌더돼
  캐시가 낡을 경로가 없다. 왕복 1회를 추가할 근거가 없다.
- 적용: 방향 버튼(`stepPtz`) · 절대 이동(`resolveAbsPtz` 의 "빈 칸은 현재 값 유지").

**지연 평가(문서화 지시)**: 실카 버튼 1회당 `GET /viewer/api/ptz` 왕복이 **1회 추가**된다. 이 호출은
장비 `getptzfpos` 1회로 이동·정착이 없어 실측 수십~수백 ms 수준이며, 뒤이어 나가는 `goptzfpos` +
정착 대기(수 초)에 비하면 무시할 수준이다. 다만 **버튼 반응이 즉시가 아니게** 되므로 마스터가 체감할 수 있다.
그 대가로 "가끔 엉뚱한 곳으로 점프"가 사라진다 — 정확성을 택했다.

## 5. 테스트

`test/platePtzLadder.test.ts` **L7 신규 5케이스**:
- ★마스터 요구 재현: 상한 + 폭 미달 + 정렬 어긋남 → 마지막 재중심으로 `ok:true`(`recenterAttempts:1`,
  `widthShortfall:true`, **실측 errX ≤ centerTol**)
- ★금지선: 마지막 재중심 후에도 tol 밖 → 실패(시도 횟수는 보존)
- ★금지선: latch 실패 → 재중심 시도조차 없이 실패
- ★수정 18: 비선형 광학 진동 재현 → `restoredToBest:true`, 최선 폭(0.238)으로 종료
- 회귀 가드: 정상 수렴 케이스에 복귀 로직 미개입(`restoredToBest` 없음, `reason` 없음)

## 6. 남은 사항

1. **`web/` 은 nodemon 감시 밖** — 수정 19 반영에 브라우저 **강력 새로고침** 필요(수정 7 때와 동일).
2. **선형 줌 모델의 근본 수정**(§0 권고)은 하지 않았다. 진동은 남으며 최선 복귀로 결과만 보호된다.
3. 수정 17·18·19 는 **실카 미검증**이다(장비 접속 불가). 마스터 3차 검증에서
   `recenterAttempts`·`restoredToBest`·최종 `errX/errY` 로그를 채록해야 한다.

---

# [추가] 수정 20 — 선형 외삽 → 괄호 이분 탐색 (구현 마감)

수정: 2026-07-21 · 구현자 (최종 지시)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **191 파일 / 2255 테스트 전건 통과**

## 1. 변경 요지

latch 이후 폭 수렴 구간에서만, 실측쌍으로 **괄호(bracket)** 를 유지하고 그 안에서 이분한다.

```ts
// 매 검출 rung 에서 갱신 — 검출된 rung 에서만 채워지므로 latch 전 탐색에는 구조적으로 무영향
if (plateWidth < target) zLo = max(zLo, ptz.zoom);   // 목표를 아래에서 스침
else                     zHi = min(zHi, ptz.zoom);   // 목표를 위에서 스침

if (zLo && zHi && zHi - zLo > EPS) zNext = clampZoom((zLo + zHi) / 2);   // 괄호 안 이분
else                               zNext = /* 기존 외삽 + 대칭 클램프 그대로 */;
```

- **괄호 미형성(전부 목표 미달)** → 기존 상승 탐색 **그대로**. 실카에서 성공한 경로를 건드리지 않았다.
- **괄호 형성** → 이분. 외삽으로 괄호 밖을 벗어나지 않으므로 진동이 **원리적으로 불가능**하다.
- 종료: `widthTol` 수렴(기존 성공 출구) 또는 **괄호 폭이 장비 해상도까지 좁혀짐** → 수정 18 의 `best` 로 복귀 후
  수정 17 의 최종 확정(실측 → 필요 시 재중심 1회 → 재확인) → `reason:'zoom_resolution_limit'`.

## 2. 왜 이분이 옳은가 (모델 가정 제거)

선형 외삽은 `width ∝ zoom` 을 가정하는데 그 가정이 장비 상단에서 깨진다(실측 `w/z` 가 5배 변화).
이분이 요구하는 것은 **"zoom↑ ⇒ width↑" 단조성 하나뿐**이고 이는 물리적으로 보장된다 →
광학 곡선이 어떤 모양이든(볼록·오목·3차·구간별 꺾임) 수렴한다. 테스트로 그 성질을 고정했다(§5).

## 3. `maxZoomStepRatio` 클램프 — **괄호 안에서는 면제** (판단 근거)

| | 판단 |
|---|---|
| 클램프의 존재 이유 | "**측정하지 않은** zoom 으로 크게 튀어 중심오차를 배율만큼 확대해 대상을 날리는 것" 방지(platePtz.ts:85) |
| 괄호 안에서는? | 괄호의 두 끝은 **이미 측정했고 그 자리에서 대상을 검출한** zoom 이다. 중점은 그 사이이므로 **클램프가 막으려는 위험이 존재하지 않는다** |
| 걸었을 때의 해악 | 넓은 괄호(예 16↔36)의 중점 26 은 `1/1.3` 밖이라 **막힌다** → 수렴이 지연되거나 괄호가 좁혀지지 않아 정체 |
| 결론 | **면제**. 단 장비 범위 클램프(`clampZoom`)는 그대로 적용 |

괄호 미형성 구간(외삽)에는 클램프를 **그대로 유지**했다 — 그쪽은 정확히 "측정하지 않은 zoom 으로 가는" 경우다.

## 4. 신규 상수·사유

| 심볼 | 값 | 근거 |
|---|---|---|
| `LADDER_BRACKET_MIN_SPAN` | **0.01**(뷰어 배율) | 뷰어 [1,36] ↔ raw [0,16384] 이므로 **1 raw ≈ 0.0021 뷰어 단위**. 0.01 ≈ 5 raw = 양자화보다 확실히 크고(노이즈 미추종), 실측 최급구간(35.153→36 에서 폭 0.157→0.238)에서도 0.01 구간의 폭 변화는 ≈0.001 = `widthTol`(0.015)의 **1/15** → 더 좁혀도 판정이 바뀌지 않는다 |
| `PlatePtzFailReason` +`'zoom_resolution_limit'` | — | `zoom_saturated`(장비 **배율 상한**)와 원인이 다르다: 목표를 **사이에 두고** 괄호가 해상도까지 좁혀졌으나 tol 안에 못 들어온 경우. 사유를 뭉개면 마스터가 "더 못 확대함"과 "해상도 한계"를 구분할 수 없다 |

`web/app.js` 완료 문구는 원인을 단정하지 않도록 일반화했다: `개별 센터라이징 완료 — 목표 폭 미달(${reason})`.

## 5. 테스트 (L8 신규 4케이스)

`opticalMock(curve)` — **광학 곡선을 임의 함수로 주입**하는 스텁을 만들었다(폭 = `curve(zoom)`).
선형 스텁만 쓰면 이 버그를 다시 못 잡는다는 지시에 따른 것이다.

| 케이스 | 확인 |
|---|---|
| **★라이브 진동 프레임 재현** — 로그 실측점 `(16,0.021)(20.8,0.029)(27,0.056)(32.4,0.102)(35.15,0.157)(36,0.238)` 구간보간 | `ok:true` · 폭 0.215±0.015 수렴. **진동 부재의 직접 증거**: 목표를 처음 넘어선 뒤 zoom 변동폭 < 1.5(구 동작은 3.8을 **3회 왕복**), 같은 zoom 재방문 < 3회 |
| **비선형 곡선 3종**(제곱·포화형·3차) | 전부 `ok:true` + tol 내 수렴 = 모델 무가정 성질 고정 |
| 괄호 미형성(전 구간 목표 미달) | 기존 상승 탐색 그대로 → `zoom_saturated`(해상도 한계가 **아님**) · zoom 36 · `ok:true`(수정 17) |
| ★금지선 | 반경 밖 판만 있는 프레임 → `ok:false` · `plate===null` · `no_plate_near_click` |

기존 L7 진동 케이스는 **이분 탐색이 진동 자체를 없애 픽스처가 무효**가 되어, `restoreBest` 를 겨냥하도록
`plate_lost` 경로로 재작성했다(최선 rung 위치로 복귀 + 그 지점에서 잰 폭을 보고).

## 6. ★거짓 성공 금지선 재점검 — **성공 조건 무변경**

이번 변경은 **다음 zoom 을 고르는 방법**만 바꾼다. 성공 출구(`isWidthConverged`)·게이트·latch 판정·
수정 17 의 최종 확정 정책에 **손대지 않았다**. 새 종료 경로(`zoom_resolution_limit`)도
수정 17 과 **동일한** `finalizeAtDeviceLimit` 을 거치므로 latch 실패·정렬 미성립은 그대로 실패다.

### 다만 — 구현 중 발견한 기존 계약의 틈 (보고, 미수정)
사다리의 성공 출구는 **폭 수렴 단독**이며 그 순간 **중심 오차를 재검증하지 않는다**.
per-rung 재중심이 있어 실무상 err 는 작지만, 이론적으로는 `err > centerTol` 인 채 `ok:true` 가 가능하다
(테스트 작성 중 센터링을 무효화한 스텁에서 `errX 0.054` 로 성공하는 것을 관측).

- **이번에 고치지 않았다**: 이 경로는 **마스터 2차 실카 검증에서 실제로 성공한 주 경로**이고,
  성공 조건 변경은 이번 지시 범위("사다리 제어 수식 외 무접촉") 밖이다. 최종 이터레이션에서 주 성공 경로를
  건드리는 것은 위험 대비 이득이 없다.
- **정직성 관점**: 대상 **신원**은 게이트로 보장되므로 "다른 차를 잡는" 위장 성공은 아니다.
  다만 수정 17 이 세운 "성공 = latch + 실측 정렬" 원칙과 **주 경로가 완전히 일치하지는 않는다**.
- **권고(차기)**: `isWidthConverged` 성공 출구에도 `isCentered` 를 함께 요구하거나,
  그 자리에서 `finalizeAtDeviceLimit` 과 동일한 최종 확정을 한 번 태우면 원칙이 일원화된다.

## 7. 남은 사항 (마스터 3차 검증 인계)

1. **`web/` 은 nodemon 감시 밖** — 강력 새로고침 필요(수정 19 문구 포함).
2. 수정 17·18·19·20 은 **실카 미검증**. 채록 대상: `phase:'ladder'` 의 `zLo`/`zHi`/`span`,
   `recenterAttempts`, `restoredToBest`, 최종 `errX/errY`, 그리고 **클릭→완료 체감 시간**.
3. 이분 전환으로 **rung 수가 줄어들 것으로 예상**되나(진동 3주기 제거) 실측 확인 필요.
4. §6 의 계약 틈은 차기 판단 사안으로 남긴다.

---

# [추가] 수정 21 — 폭 수렴 출구의 정렬 확인 (계약의 틈 해소 · 구현 완전 마감)

수정: 2026-07-21 · 구현자 (최종 지시)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **191 파일 / 2260 테스트 전건 통과**

## 1. 해소한 문제

수정 20 보고에서 **미수정으로 남겼던 계약의 틈**: 사다리의 주 성공 출구는 `isWidthConverged` **단독**이라
그 순간 중심 오차를 재검증하지 않아, 이론적으로 `err > centerTol` 인 채 `ok:true` 가 가능했다
(테스트 관측: `errX 0.054`). 수정 17 이 세운 "성공 = latch + 실측 정렬" 원칙과 **주 경로만 예외**인 상태였다.

## 2. 무회귀 설계 (이번 지시의 핵심 제약)

신규 `finalizeConverged()` — **성공을 취소하지 않는 best-effort 정렬 확인**.

| 상황 | 동작 | 결과 |
|---|---|---|
| 이미 tol 안(**대부분**) | **추가 카메라 왕복 0회**로 즉시 반환 | `ok:true`, 필드 추가 없음 = 기존과 완전히 동일 |
| tol 밖 → 재중심 성공 | 재중심 1회 + **재확인 캡처로 실측** | `ok:true`, `recenterAttempts:1` |
| tol 밖 → 재중심 거절 | warn | **`ok:true` 유지**, `centerShortfall:true`, 잔차는 `err` 에 |
| tl 밖 → 재확인에서 대상 소실 | warn | **`ok:true` 유지**, `centerShortfall:true`, **마지막 실측값 유지**(지어내지 않음) |

**이 변경으로 실패로 바뀌는 케이스는 하나도 없다.** `ok` 는 이 경로에서 항상 `true` 다 —
분기는 오직 "정보를 더 싣느냐"뿐이다. 반환 `aligned` 는 "실측으로 정렬이 확인됐는가"이며 성공 여부가 아니다.

## 3. 정직성 관용구 (수정 13 `widthShortfall` 과 동형)

신규 결과 필드 **`centerShortfall?: boolean`** — "`ok:true` 인데 정렬이 `centerTol` 밖으로 남았다".
최종 `errX/errY` 는 `err` 에 실리고, 로그에는 `errBefore`(보정 전) 까지 함께 남겨 **개선 여부**가 보인다:
`'사다리 폭 수렴 — 완료'` / `'사다리 폭 수렴 — 완료(정렬 잔차 남음)'`.

## 4. 수정 18(best 복귀)과의 충돌 검토 → **충돌 없음**

- `restoreBest` 는 **`max_iterations` · `plate_lost` 경로 전용**이고, 이번 정렬 확인은 **폭 수렴 성공 출구**다.
  두 코드 경로는 **상호 배타**라 동시에 실행될 수 없다.
- 재중심은 `setcenter`(pan/tilt only) 라 폭을 바꾸지 않는 것이 원칙이지만, 재확인 실측에서 폭이
  목표 아래로 벗어나면 `widthShortfall` 을 세워 **그 사실도 남긴다**(값을 되돌리지 않고 실제 상태를 보고).

## 5. 금지선 재점검 — **넓히지도 좁히지도 않았다**

| 항목 | 결과 |
|---|---|
| 성공 조건 | **무변경**. 진입 조건은 여전히 `latch(게이트 통과) + isWidthConverged` |
| 실패 → 성공 전환 | **없음**(이 출구는 원래 성공만 반환했다) |
| 성공 → 실패 전환 | **없음**(테스트로 명시 고정 — §6 무회귀 2건) |
| 대상 신원 | 재확인 캡처가 `matchRadiusNorm` 게이트를 쓰므로 이웃으로 갈아탈 수 없다 |
| 추가된 것 | **정보뿐**(`centerShortfall`·`recenterAttempts`·최종 `err`·로그) |

## 6. 테스트 (L9 신규 5케이스)

| 케이스 | 고정 내용 |
|---|---|
| 정렬 tol 안 | `recenterAttempts` **undefined** + rung 캡처 증가분 **정확히 1** = **추가 왕복 0회** |
| 정렬 tol 밖 + 재중심 성공 | `ok:true`, `recenterAttempts:1`, `centerShortfall` 없음, **실측 errX ≤ centerTol** |
| **★무회귀 1** | 재중심이 듣지 않는 소스 → **`ok:true` 유지** + `centerShortfall:true` + 잔차 > tol 이 결과에 실림 |
| **★무회귀 2** | 재확인에서 대상 소실 → **`ok:true` 유지** + 마지막 실측 보고(`plate` 보존) |
| ★금지선 | 반경 밖 판만 → 여전히 `ok:false` · `plate===null` · `no_plate_near_click` |

## 7. 차기 권고 항목 갱신

- 수정 20 §6 에서 남긴 **"성공 출구 원칙 일원화"** 권고는 **본 수정으로 해소**되었다(차기 사안에서 제외).
- 남는 차기 권고는 다음 1건뿐이다: `centerOnPlate`/`zoomToPlateWidth`(배치 경로)는 실카 미검증 —
  실카 배치 센터라이징을 돌리기 전에 별도 검증이 필요하다(이번 작업의 사정권 밖이었다).

## 8. 최종 상태 (마스터 3차 검증 인계)

- 이번 이터레이션 구현은 **수정 1~21 로 마감**한다.
- **`web/` 은 nodemon 감시 밖** — 마스터 강력 새로고침 필요.
- 실카 채록 대상: `phase:'ladder'` 의 `zLo/zHi/span`(이분), `recenterAttempts`, `centerShortfall`,
  `restoredToBest`, 최종 `errX/errY`, **클릭→완료 체감 시간**.

---

# [추가] 수정 22 — 직전 실행 프레임이 새 실행 화면에 뜨는 표시 버그

수정: 2026-07-21 · 구현자 (마스터 3차 검증 회신)
검증: `npx tsc --noEmit` 클린 · `npx vitest run` **192 파일 / 2266 테스트 전건 통과**

## 1. 문제와 성격

마스터 신고: *"36배줌 상태에서 카메라 컨트롤 UI로 줌값을 줄여서 다른 곳을 클릭하면 원래 36배줌이 다시 보인다."*

**제어 결함이 아니라 표시 결함이다.** 잡의 `lastFrame` 버퍼가 **한 번도 무효화되지 않아**, 새 실행이 첫 캡처를
넣기 전까지 `/…/frame` 이 **직전 실행의 마지막 프레임**(36배 확대 화면)을 계속 서빙했다. 뷰어는 `plate-zoom`
클릭 시 `startCalFramePolling()` 으로 **라이브를 끊고**(`stopLive()`) 이 라우트를 폴링하므로,
**카메라는 새 위치·줄인 줌으로 갔는데 화면만 과거를 보여준다.**

→ 수정 19(이동 기준 실측화)는 실제로 동작하고 있었고, **화면이 그 성과를 가리고 있었다.**

## 2. 전수 확인 — 같은 병이 **세 잡 모두**에 있었다

| 잡 | 기존 상태 | 조치 |
|---|---|---|
| `PtzCalibrator.lastFrame` | **초기화 없음** (신고된 그 경로) | 신규 `clearLastFrame()` 을 **개별 `centerOnPoint` · 개별 `aimPointToCenter` · 배치 `start()`** 3곳에서 호출 |
| `PlateDiscoveryJob.lastFrame` | **초기화 없음** | `start()` 에서 무효화 |
| `CaptureJob.lastFrame` | **`lastFrameByPreset.clear()` 만 있고 `lastFrame` 은 남았다** | 같은 자리에서 함께 무효화 |

`aimPointToCenter`(mode `'point'`)는 캡처를 하지 않지만 **카메라는 움직인다** → 직전 프레임은 그 시점부터
과거이므로 동일하게 무효화했다(뷰어는 이 모드에서 라이브를 끊지 않아 화면 영향은 없지만, 버퍼 계약은 일관돼야 한다).

## 3. 첫 프레임 도착 전 화면 거동 — 확인 결과 **추가 조치 불요**

지시대로 실제 동작을 코드로 확인했다:
- 라우트 3곳 전부 버퍼가 없으면 **404 + `{error:'no frame'}`** (기존 "버퍼 없음" 계약, 변경 없음).
- `calFrameTick`(`app.js:2358`)은 `if (!res.ok) return;` 로 **갱신을 스킵**한다 → `frame.src` 가 바뀌지 않는다.
- `startCalFramePolling` 이 `stopLive()` 를 부르므로 화면은 **클릭 시점의 마지막 라이브 프레임에 정지**한다.
  즉 "지금 그 자리의 실제 화면"에 머문다 — **과거 실행 이미지를 현재인 양 보여주는 것보다 정직하다.**
- 진행 표시는 이미 있다: `calPointCenter` 가 폴링 시작 **전에** `cal-msg` 를 `'번호판 센터+줌 중…'` 으로 설정한다.

→ 별도 스피너·플레이스홀더를 추가하지 않았다. 정지된 실제 프레임 + 진행 문구로 상태가 충분히 전달되고,
   요청받지 않은 UI 요소를 늘리는 것은 이 작업의 원칙(외과적 변경)에 어긋난다.

## 4. 회귀 테스트

`test/jobFrameReset.test.ts` (신규 5케이스) + `test/captureJob.test.ts` (+1케이스):

| 케이스 | 고정 내용 |
|---|---|
| ★개별 center+zoom 시작 | 직전 프레임을 심어두고 실행 → `getLastFrame()` **undefined**(라우트 404) |
| ★개별 point 조준 시작 | 캡처가 없어도 무효화된다 |
| ★배치 `start()` | **백그라운드 실행 전에** 즉시 무효화 |
| ★discovery `start()` | 직전 탐색 프레임을 서빙하지 않는다 |
| 무효화 범위 | 시작 시점에만 — 새 프레임이 들어오면 보존되고 **조회가 버퍼를 지우지 않는다**(폴링 계약) |
| ★`CaptureJob.start()` | 직전 run 의 `lastFrame` 을 서빙하지 않는다 |

## 5. 범위 준수

사다리 제어 로직·성공 조건·게이트는 **건드리지 않았다**. 이번 변경은 프레임 버퍼 수명뿐이다.
사다리가 다시 36배까지 올라가는 것은 설계대로이므로 그대로 두었다(리더 확인 사항).

## 6. 남은 사항

- **`web/` 은 nodemon 감시 밖**이지만 이번 수정은 **전부 서버 측**이라 마스터 새로고침 없이 서버 재기동만으로 반영된다
  (수정 19·21 의 `web/app.js` 변경은 여전히 새로고침 필요).
- 차기 권고는 그대로 1건: `centerOnPlate`/`zoomToPlateWidth`(배치 경로) 실카 미검증.
