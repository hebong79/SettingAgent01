# QA 검증 리포트 — 클릭 패치 NCC 추적 폐루프 조준 (mode:'point')

대상 설계: `_workspace/01_architect_plan_patch_aim.md` · 구현: `_workspace/02_developer_changes.md`
검증 코드: `src/calibrate/patchTrack.ts`, `src/calibrate/PointAimer.ts`, `src/calibrate/PtzCalibrator.ts`(aimPointToCenter 위임 배선)

## 판정: PASS (구현 결함 없음)

- `npx tsc -p tsconfig.json --noEmit` → **에러 0**.
- `npx vitest run`(전체) → **182 파일 / 2121 테스트 전부 green, 회귀 0**.
  - 착수 시 베이스라인은 180파일/2104(§A 개루프 5건 실패). 신규 2파일 + §A 재작성으로 전량 green 전환.

## 신규/변경 테스트

### A. `test/patchTrack.test.ts` (신규, 11건) — 합성 평행이동 이미지 정밀 검증
sharp `create`(raw 단일채널) + 결정형 pseudo-random 해시 노이즈(재현성 확보)로 합성.
1. **nccSearch 평행이동 복원**: 주입 (dx,dy) ∈ {(5,0),(0,7),(-6,4),(8,-9),(11,11),(3,-2)} 를 **±1px 이내** 정확 복원, 정합점 score>0.9. shift 0 은 제자리·score>0.99(정합 상한). content=+shift → 특징이 pixel+shift 에서 재검출(부호·좌표 정합 확인).
2. **patchTexture 게이팅**: 노이즈부 std > TEX_MIN(8), 민무늬 블록 < TEX_MIN, 분리비 5배 이상.
3. **저텍스처/불일치 score 저하**: 민무늬 이미지·seed 무관 노이즈 필드에서 검색 → score < MIN_SCORE(0.5)(분모≈0/무상관).
4. **toGray 리사이즈 불변**: 입력 JPEG → grayscale, workW=512(무리사이즈) vs 256(2× 다운스케일) 두 해상도가 **동일 정규화좌표**에서 블록 텍스처 검출, 블록 밖은 양쪽 모두 민무늬(정규화좌표 불변).

### B. `test/pointAimer.test.ts` (신규, 6건) — 진짜 폐루프 수렴 시연
목킹 카메라가 "명령 pan/tilt 에 따라 클릭 패치가 실측 게인(fallback −62/−35.5 @z1)만큼 평행이동한 합성 프레임"을 렌더 → **실제 patchTrack + 실제 controlMath** 로 폐루프 구동.
1. **수렴**: aim() 이 centerTol(0.03) 이내 `{ok:true}` 수렴, iterations=3(유한, <MAX_ITER), zoom 불변(결과·전 명령 zoom===start), 명령 3회 이상(개루프 1스텝 아님). 로그상 최종 errX=errY=0.
2. **onFrame**: 매 캡처마다 호출(호출수===requestImage 수), lastFrame 갱신 경로 확인.
3. **low_texture**: 첫 프레임 민무늬 → `{ok:false, reason:'low_texture'}`, requestImage 정확히 1회(초기)만, iterations=0.
4. **patch_lost**: 첫 프레임 이후 패치 소실 → 광역 재탐색(×2.5)도 미달 → `reason:'patch_lost'`, requestImage 2회, iterations=1.
5. **저장 0**: deps 는 camera/cfg/sleep/onFrame 뿐(저장 주입 통로 없음) + 소스 정적 가드(저장 모듈 import·writeSlotPtz/saveSnapshot/upsertSlot 호출 0).

### C. `test/ptzCalibrator.point.test.ts` §A 재작성 (16건 전량 green)
개루프 계약(가짜 `Buffer.from('AIM_JPEG_BYTES')` + requestImage 정확히 1회 단정) **폐기**. `aimPointToCenter` 가 `PointAimer` 위임임을 반영:
- 시임: PtzCalibrator 는 pointAimer 를 생성자에서 1회 생성(주입 심 없음) → 인스턴스 private `pointAimer` 를 스텁으로 교체하는 지점을 잡음.
- **위임 계약**: aim(cam,preset,클릭점) 호출 인자 캡처, `{ok,ptz,finalErr,iterations}` 그대로 반환(성공 시 reason 미가산). 실패 reason(low_texture) 가산 전파.
- **저장 0**·**makePlatePtz(LPD/plate) 미진입** 유지.
- **상호배타**: 배치 running 중 throw(/running/), pointBusy 재진입 2번째 throw(/busy/)·첫 호출 정상 완료(pending 스텁으로 락 보유 재현).
- §B(centerOnPoint plate 경로) 11건·라우트 테스트 **무변경 유지**.
- CLAUDE.md 규칙3: 재작성으로 고아가 된 `makeCameraSpy`/`expectedAimCmd`/`AIM_MAX_STEP` 및 `scaleGainForZoom`/`panTiltCorrection` import 제거.

## 경계면 교차 대조 (정합 확인)

`POST /calibrate/point {mode:'point'}` → `aimPointToCenter(cam,preset,point)` → `PointAimer.aim(camIdx,presetIdx,click:NormalizedPoint)` → `patchTrack`.
- **좌표**: 라우트 `point{x,y}`(z.object) = NormalizedPoint(정규화 0~1). patchTrack 은 전 구간 정규화 입출력(픽셀 인덱싱 내부 한정) → 해상도 무관 일관.
- **반환 shape**: 라우트는 `{ok: r.ok, ptz: r.ptz}` 만 소비(`calibrateRoutes.ts:58`). 구현이 가산한 `finalErr/iterations/reason` 은 라우트가 무시 → **계약 무변경**. 부호 규약(pan+ → dx−, tilt+ → dy−)은 controlMath(panTiltCorrection Δ=−gain·err / predictPlateCenter 역산)가 소유, PointAimer 는 재사용만.

## 은닉 없는 한계 (정직)

- 합성이미지·합성프레임 검증은 **알고리즘 정합(부호·좌표·정규화 불변·수렴 수학)** 만 보증한다.
- **실카메라 수렴·저텍스처 현장 강건성**(JPEG 압축 노이즈·조명/야간·반복무늬·실측 게인 부호·원근 비균일·PTZ 지연)은 **리더 경험적 검증(라이브 before/after 스냅샷)** 담당 — vitest 밖.

## 비차단 관찰(참고, 결함 아님)

- `src/api/calibrateRoutes.ts:13,56` 주석이 여전히 "개루프 1스텝"으로 남아 있음(코드 아닌 산문). 폐루프 재구현과 불일치 → 문서화 단계에서 정정 권고(동작 무영향).
