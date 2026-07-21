# 구현 변경 요약 — "개별 center"(mode:'point') 개루프 → 클릭 패치 NCC 폐루프 재구현

설계 근거: `_workspace/01_architect_plan_patch_aim.md`. 계약(라우트/프론트/타입) 무변경, 신규 npm 의존성 0(sharp 기존).

## 변경/신규 파일
| 종류 | 파일 | 내용 |
|------|------|------|
| 신규 | `src/calibrate/patchTrack.ts` | 순수 패치 NCC 추적 함수(sharp) — `toGray`/`patchTexture`/`extractTemplate`/`nccSearch` |
| 신규 | `src/calibrate/PointAimer.ts` | 클릭 패치 폐루프 조준기 `aim()` — 캡처·추적·수렴 소유. **저장 호출 0** |
| 수정 | `src/calibrate/PtzCalibrator.ts` | `aimPointToCenter` **본문만** 폐루프 위임으로 교체 + `pointAimer` 인스턴스 1회 생성 + import 1줄 |

배치 센터라이징·저장·`preAimPtz`(배치용)·라우트·프론트·`mode:'plate'`/`'plate-zoom'`·`controlMath`·`platePtz` 전부 무접촉.

## patchTrack.ts 구조
- `toGray(jpeg, workW)`: `sharp(jpeg).grayscale().resize({width:workW}).raw().toBuffer({resolveWithObject})` → 단일채널 래스터 `{data,w,h}`. 정규화좌표는 해상도 무관이라 다운스케일로 속도만 얻음.
- `patchTexture(g, cxN, cyN, halfPx)`: 패치 로컬 표준편차(모집단 std, `sqrt(ΣΣ/N − mean²)`). TEX_MIN 게이팅용.
- `extractTemplate(g, cxN, cyN, halfPx)`: `{tpl(원시 그레이·행우선), half, mean, std}`. `std`=평균차 L2 노름 `sqrt(Σ(tpl-mean)²)` = NCC 분모의 템플릿 항(정규화상관 → score∈[-1,1]).
- `nccSearch(g, tpl, predCxN, predCyN, radiusPx, step=1)`: 예측점 ±radius 를 step 간격으로 훑어 `score = Σ(tpl-tmean)(win-wmean)/(tstd·sqrt(Σ(win-wmean)²))` 최대점. full 패치가 경계(half) 밖인 후보는 스킵. 반환 좌표 정규화, 유효 후보 0 → score 0.
- 좌표 클램프: `clampCenter` 로 중심을 `[half, dim-1-half]` 로 정렬(모서리 클릭도 full 패치 확보).

## PointAimer 폐루프 흐름(설계 §2.2 그대로)
1. `startPtz = resolvePresetPtz(...) ?? {0,0,1}`(폴백 시 warn).
2. cap0 캡처 → `onFrame`(lastFrame 갱신) → `toGray` → `patchTexture < TEX_MIN` 이면 `{ok:false, reason:'low_texture'}` (정직 중단).
3. `extractTemplate`(클릭 패치). 게인 = `scaleGainForZoom({fallbackGainPanDeg,fallbackGainTiltDeg,zoomRef:1}, startPtz.zoom)` **고정**.
4. 반복(maxIter): `err=pNow-0.5` → `isCentered(err, centerTol)` 성공. `panTiltCorrection(err,gain,pan,tilt,maxStepDeg)`로 `cmd`(zoom 불변) → 캡처 → 예측점 `pPred = predictPlateCenter(pNow, cmd-ptz delta, gain)`(명령 변위를 게인으로 화면변위 역산) 근처 `nccSearch`. `score<minScore` 면 광역 재탐색(radius×2.5) 1회, 그래도 낮으면 `reason:'patch_lost'`. 성공 시 `pNow=측정점, ptz=cmd`.
5. 반복 소진 → `reason:'max_iterations'`.

부호 규약: 실측 pan+ → dx−, tilt+ → dy−. `panTiltCorrection`(Δ=−gain·err, 게인이 부호 흡수)·`predictPlateCenter`(역산)가 이미 소유 → PointAimer 는 그대로 재사용(부호 코드 추가 없음).

## 실측 게인 사용 근거
config `fallbackGainPanDeg:-62 / fallbackGainTiltDeg:-35.5`(@zoomRef=1)를 `scaleGainForZoom(startPtz.zoom)` 한 값이 실측(pan+1°→dx−0.0266, tilt+1°→dy−0.0472 @z1.69341)과 일치 → **초기 고정 게인으로 그대로 사용**. 기존 실패는 게인 크기가 아니라 1스텝 개루프(잔차 미보정·원근 비균일 ~30%)였으므로 폐루프 재측정만으로 해결.

## refineGain 포함 여부 — **미포함**(고정 게인 채택)
온라인 게인보정은 넣지 않았다. 실측상 고정 게인이 참값과 일치하고 매 스텝 재측정이 원근 비균일을 흡수하므로 불필요하며(설계 §0·§2.2), 저텍스처/오매칭 프레임 잡음이 게인에 되먹임되면 과보정 발산 위험이 있다(설계·CLAUDE.md 단순함 지침 정합). PointAimer 상단 주석에 EMA·발산가드 TODO 로 명시.

## 파라미터(PointAimer 상단 명명 상수 + opts override, cfg 확장 없음)
`WORK_W=960, PATCH_HALF_PX=32, SEARCH_RADIUS_PX=28, MIN_SCORE=0.5, TEX_MIN=8, MAX_STEP_DEG=2.5, MAX_ITER=20, WIDE_SEARCH_MULT=2.5`. `centerTol/settleMs` 는 `cfg` 에서(기본 0.03/300). goal/loop 튜닝 대상.

## aimPointToCenter 배선
- 시그니처 `(camIdx,presetIdx,point)` 유지. 반환은 `{ok,ptz}` 보존 + `finalErr/iterations/reason` 가산(라우트는 `{ok,ptz}`만 사용 → 계약 무변경).
- 상호배타 가드(`state==='running'`/`pointBusy`)·`try/finally` 유지.
- `PointAimer` 는 생성자에서 1회 생성(`camera`/`cfg`/`sleep`/`onFrame` 주입). `onFrame` 은 기존 `lastFrame` 갱신 콜백 공유(PlatePtz onFrame 패턴 — `/calibrate/frame` 폴링 자동).
- 개루프 인라인(preAim 공식·직접 `requestImage`·`lastFrame` 수동 갱신) 제거. `PREAIM_MAX_STEP`·`scaleGainForZoom`·`panTiltCorrection` 은 배치 `preAimPtz` 가 계속 사용하므로 import 유지(고아 없음).

## 저장 0 보장
PointAimer 는 writer/DB/스냅샷/upsert 를 import 하지도 호출하지도 않는다. `aimPointToCenter` 도 위임만 하고 저장 경로 미진입. (기존 `centerOnPoint` §5-A 저장-0 회귀 테스트 전부 통과 유지.)

## 검증 결과
- `npx tsc -p tsconfig.json --noEmit` → **에러 0**.
- `npx vitest run`(전체) → **180 파일 중 179 통과 / 2104 테스트 중 2099 통과**.
- 실패 5건은 전부 `test/ptzCalibrator.point.test.ts` 의 `§A aimPointToCenter` 블록 — **교체된 개루프 계약**(가짜 비-JPEG 버퍼 `Buffer.from('AIM_JPEG_BYTES')` + "requestImage 정확히 1회" 단정)을 고정한 **폐기 대상 테스트**. 설계 §4 대로 qa 가 합성 평행이동 이미지 + 카메라/트래커 목킹으로 재작성해야 함(개루프 → 폐루프 전환의 필연적 결과). `centerOnPoint`·라우트·platePtz·controlMath·배치 센터라이징 회귀 0.

## 한계(정직)
- 저텍스처/야간/반복무늬 클릭 → `low_texture`/`patch_lost` 정직 반환.
- 실카메라 PTZ 지연은 `settleMs`(cfg 300ms)로 흡수. 경험적 수렴 확증(실카메라 before/after 육안)은 리더 goal/loop 담당.
- 게인 `fallbackGain*` 는 cam1 시뮬 실측 유래 — 타 카메라는 편차 가능(폐루프 재측정이 잔차를 흡수하나 초기 예측창이 커질 수 있음, `WIDE_SEARCH_MULT` 로 완화).

---

# 추가 개선(라이브 실카메라 검증 반영) — 저텍스처 확대 재시도 + 실패 사유 UX 노출

라이브 결과(실카메라): 텍스처 지점 4개는 중앙거리 0.002 로 정확 수렴(성공), 민무늬 2개(클릭 (0.4,0.45)·(0.72,0.4))는 `low_texture` 로 cap0 에서 즉시 중단(카메라 미이동). 계약·기존 동작 보존하며 2가지 외과적 개선.

## 변경 파일
| 종류 | 파일 | 내용 |
|------|------|------|
| 수정 | `src/calibrate/PointAimer.ts` | 저텍스처 게이트를 **패치 반경 단계 확대 재시도**로 전환 + 상수 `TEXTURE_RETRY_HALVES` + opt `textureRetryHalves` |
| 수정 | `src/api/calibrateRoutes.ts` | point 분기 응답에 `reason`·`iterations` 조건부 가산(plate 분기 무변경) |
| 수정 | `web/app.js` | `calPointCenter` 실패 메시지에서 `mode:'point'` 한정 `reason` 한글 매핑(plate 경로 메시지 무변경) |

배치 센터라이징·저장 경로·`mode:'plate'`/`'plate-zoom'`·라우트 plate 분기·`patchTrack.ts`·`controlMath`·`platePtz` 무접촉. **저장 호출 0 유지.**

## 개선 1: 저텍스처 시 패치 확대 재시도(중단 감소)
- **동작**: cap0 그레이 프레임에서 설정 half(기본 32)로 `patchTexture < TEX_MIN(8)` 이면 즉시 `low_texture` 반환하던 것을, **반경 후보 `[half, 64, 96]`(설정 half 이후 `TEXTURE_RETRY_HALVES` 중 더 큰 값)로 단계 확대**해 각 단계 텍스처를 재평가한다. 어느 단계가 `TEX_MIN` 이상이면 그 확대 half(`effHalf`)로 `extractTemplate` → 폐루프 진행. 확대 패치의 중심은 여전히 클릭점이므로 클릭 지점이 그대로 중앙으로 온다. 모든 확대에도 미달이면 그때 `low_texture` 반환(정직).
- **경계 클램프**: `maxHalf = floor((min(w,h)-1)/2)` 로 각 후보를 클램프(가장자리 클릭이면 가능한 최대 half). `Set` 으로 중복 제거(클램프 후 동일값 재평가 방지).
- **일관 사용**: `extractTemplate(g0, click, effHalf)` 로 뽑은 `tpl.half=effHalf` 가 `nccSearch` 에 그대로 전달되어 폐루프 내내 확대 half 를 일관 사용. 루프 본문·게인·예측·수렴 판정 무변경.
- **상수(튜닝용, PointAimer 상단)**: `TEXTURE_RETRY_HALVES = [32, 64, 96]`. 상한 96 — 과대 패치는 원근 왜곡·다른 깊이 혼입으로 NCC 저하 가능(goal/loop 튜닝 대상). `PointAimerOpts.textureRetryHalves?` 로 오버라이드 가능(기존 opt 패턴 일관).
- **근거**: 라이브 민무늬 2건이 32px 패치 std<8 로 즉시 중단됐다. 반경 확대는 더 넓은 주변 무늬(차량 모서리/도로 마킹 등)를 패치에 포함시켜 std 를 끌어올려 폐루프를 살릴 여지를 준다.

## 개선 2: 실패 사유를 라우트·프론트에 노출(정직 UX)
- **라우트**(`calibrateRoutes.ts` point 분기): `return { ok: r.ok, ptz: r.ptz, ...(r.reason ? { reason: r.reason } : {}), ...(r.iterations != null ? { iterations: r.iterations } : {}) }`. 성공(reason 없음) 시 기존과 동일한 `{ok,ptz}` 유지 → 조건부 스프레드로 회귀 0. `aimPointToCenter` 는 이미 `reason`·`iterations` 를 반환하므로 라우트 echo 만 추가.
- **프론트**(`app.js` `calPointCenter`): 실패(`!data.ok`)이고 `mode==='point'` 이며 `data.reason` 이 있으면 한글 매핑 안내 — `low_texture`→"클릭 지점 텍스처가 부족합니다 — 차량 모서리/번호판 등 무늬가 뚜렷한 곳을 클릭하세요", `patch_lost`→"추적 실패 — 다시 시도하세요", `max_iterations`→"수렴 실패(반복상한) — 다시 시도". 성공 메시지·plate 경로 메시지·409 처리 무변경.

## 검증
- `npx tsc -p tsconfig.json --noEmit` → **에러 0**.
- `npx vitest run`(전체) → **182 파일 / 2121 테스트 전부 통과**. 기존 point 라우트 테스트(`calibrateRoutes.point.test.ts`)의 `toEqual({ok,ptz})` 단정은 그 테스트의 aim 스텁이 `{ok,ptz}`만 반환(reason/iterations 없음)하므로 조건부 스프레드가 아무것도 추가하지 않아 **깨지지 않음**. qa 가 조정할 깨진 기존 단정 **없음**(reason 케이스를 새로 추가한다면 그때 확장).
- **저장 호출 0 유지**(PointAimer/라우트/프론트 어느 경로도 writer·DB 미접촉).

## 미결(라이브 확증 이월)
- 확대 재시도가 실제 민무늬 2건을 살리는지(effHalf=64/96 에서 std≥8 도달·폐루프 수렴)는 실카메라 goal/loop 확증 필요 — 결정형 vitest 로는 확정 불가(위장 성공 금지).
- 96px 상한·재시도 후보 배열은 튜닝 대상(원근 왜곡 상한 관측 시 조정).
