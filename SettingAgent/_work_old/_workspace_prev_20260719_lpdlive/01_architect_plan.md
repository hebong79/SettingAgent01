# 01_설계서 — LPD 검지 "현재화면 그대로 순수 LPD"(lpd-live) 타입 추가

## 목표
LPD 검지 콤보(`web/index.html #lpd-mode`)에 4번째 타입 **"현재화면 순수 LPD"(`lpd-live`)** 를 추가한다.
기존 순수 `lpd`는 서버 `runDetect`가 `resolvePresetPtz`로 **저장된 프리셋 PTZ**를 base 프레임으로 재렌더 → 사용자의 수동 PTZ가 프리셋으로 스냅된다.
신규 타입은 **현재 뷰어 PTZ(`state.ptz` = 수동 팬/틸트/줌 포함)** 로 base 프레임을 재렌더한 뒤 LPD-only 검출한다.
(마스터 확정: "현재 PTZ로 재렌더 후 LPD" — 화면 픽셀 그대로 업로드 방식 아님.)

## MCP 도구 vs LLM 두뇌 경계
- 순수 결정형 경로. LLM 두뇌 무관. VPD·자동검출 미접촉(VPD 자동검출 금지 정책 준수, `vpdEnabled=false` 유지).
- 신규 라우트 없음 — 기존 `POST /capture/detect` 를 **옵셔널 필드**로 확장(과설계 금지).

## 구현 단계 (검증 기준 포함)

### 백엔드
1. **`DetectBodySchema` 확장** (`src/api/captureRoutes.ts:70`)
   옵셔널 `ptz: z.object({ pan: z.number().optional(), tilt: z.number().optional(), zoom: z.number().optional() }).optional()` 추가.
   → 검증: `ptz` 미지정 body가 그대로 파싱 통과(하위호환), 부분 필드({pan}만)도 통과.

2. **라우트 핸들러가 ptz 전달** (`src/api/captureRoutes.ts:608~636`)
   `runDetect(...)` 호출의 args 객체에 `ptz: parsed.data.ptz` 추가. 나머지 인자 불변.
   → 검증: parsed.data.ptz 가 runDetect args로 그대로 전달됨.

3. **`runDetect` base 프레임 PTZ 오버라이드** (`src/capture/detectPipeline.ts:237~250`)
   - 시그니처 args에 `ptz?: { pan?: number; tilt?: number; zoom?: number }` 추가.
   - base 프레임 PTZ 결정 로직 변경(현재 248~250줄):
     ```
     const overridePtz = args.ptz;                       // 신규
     const presetPtz = overridePtz ?? await resolvePresetPtz(deps.camera, cam, preset);
     const base = await deps.camera.requestImage(cam, preset, presetPtz ?? undefined);
     const basePtz = presetPtz ?? { pan: base.pan, tilt: base.tilt, zoom: base.zoom };
     ```
     핵심: `ptz` 제공 시 `resolvePresetPtz` **호출 자체를 건너뛰고** 오버라이드값을 `presetPtz`에 대입 → `requestImage(cam, preset, override)` 로 렌더되고, **동일 값이 `basePtz`가 되어** 이후 `inverseProjectQuad`(역투영)·zoom 재시도(328줄 `requestImage(cam,preset,{pan,tilt,zoom})`)의 기준으로 정확히 전파된다.
   - ⚠️ 주의: 오버라이드 객체가 부분 필드일 수 있으므로(pan/tilt/zoom 옵셔널) `requestImage`/`basePtz`가 온전한 `{pan,tilt,zoom}`을 기대한다면 **프론트에서 항상 3필드 완전체를 보내는 것**을 계약으로 삼는다(아래 프론트 5번). 서버는 받은 값을 그대로 신뢰.
   - `vpdEnabled`·onPlace·cuboid 등 나머지 로직 완전 불변.
   → 검증(vitest):
     - (a) `ptz` 오버라이드 전달 시 `deps.camera.requestImage`가 그 ptz로 호출되고 `resolvePresetPtz`(listCameras) **미호출**, 결과 basePtz가 오버라이드값(역투영 기준 스텁으로 확인).
     - (b) `ptz` 미제공 시 기존 `resolvePresetPtz`(listCameras) 경로로 회귀 — base가 프리셋 PTZ로 렌더.

### 프론트엔드
4. **콤보 옵션 추가** (`web/index.html:229` 뒤)
   `vpd` 옵션 다음에 `<option value="lpd-live">현재화면 순수 LPD</option>` 추가.
   (순서: 순수 LPD → 앞면중심 LOOP → VPD→LPD → 현재화면 순수 LPD. 순수 LPD와 짝이므로 맨 끝 배치로 기존 순서 무변.)

5. **`runLiveDetect` 시그니처 확장 + 디스패처 + 신규 핸들러** (`web/app.js`)
   - `runLiveDetect(vpdEnabled = false, ptz)` (986줄): `ptz` 제공 시 POST body에 `ptz` 포함, 미제공 시 body 무변경.
     ```
     const body = { cam, preset, vpdOnParkingOnly: $('cap-vpd-onplace').checked, vpdEnabled };
     if (ptz) body.ptz = { pan: Number(ptz.pan), tilt: Number(ptz.tilt), zoom: Number(ptz.zoom) };
     ```
     `state.ptz` 값은 프리셋/시뮬 경로에선 number지만 실카메라(`/ptz` 응답, 306줄) 경로에선 문자열일 수 있어 **`Number()` 변환 필수**(서버 zod `z.number()` 통과 보장).
   - `runModeLpdLive()` 신규(runModeLpd 옆, 2490줄 뒤): runModeLpd와 **동일 오버레이 설정**(roi-vehicle/occupancy/vcuboid/mask off, roi-plate on) + `runLiveDetect(false, state.ptz)`.
   - 디스패처(3457~3461줄)에 `else if (mode === 'lpd-live') runModeLpdLive();` 추가.
   → 검증: 기존 호출부 `runLiveDetect()`(1972줄)·`runModeLpd`(false)·`runModeVpd`(true) 는 ptz 미전달 → body에 ptz 없음 → 기존 동작 완전 불변. 리더 라이브로 DOM/실동작 확인.

## 변경 파일 목록
| 파일 | 변경 |
|------|------|
| `src/api/captureRoutes.ts` | DetectBodySchema에 옵셔널 ptz(70), 핸들러가 runDetect args에 ptz 전달(627) |
| `src/capture/detectPipeline.ts` | runDetect args에 `ptz?` 추가, base PTZ 오버라이드 분기(237~250) |
| `web/index.html` | #lpd-mode에 `lpd-live` 옵션 추가(229 뒤) |
| `web/app.js` | runLiveDetect ptz 파라미터(986), runModeLpdLive 신규, 디스패처 분기(3457) |
| `test/detectPipeline.test.ts`(기존) | ptz 오버라이드/회귀 테스트 추가 |

## 시그니처 변경 요약
- `runDetect(deps, args, cfg, onPlace?, cuboidCtx?)` — `args` 타입에 `ptz?: { pan?: number; tilt?: number; zoom?: number }` 가산(옵셔널 → 기존 호출부·테스트 무영향).
- `runLiveDetect(vpdEnabled = false, ptz?)` — `ptz` 가산(옵셔널 → 기존 4개 호출부 무영향).
- `DetectBodySchema` — `ptz` 옵셔널 필드 가산(하위호환).

## 영향도 초안 (문서화·구현자 전달)
- **하위호환**: 3개 변경 모두 옵셔널 확장. 기존 3모드(lpd/discover/vpd)·자동검출(1972)·프리셋 스냅 경로·`resolvePresetPtz`·VPD 정책 전부 불변.
- **회귀 위험 지점**: detectPipeline 248~250 base PTZ 결정 로직 — ptz 미제공 시 `resolvePresetPtz` 경로가 **정확히 이전과 동일**해야 함(vitest (b)로 가드). zoom 재시도 루프(328)·역투영은 basePtz만 참조하므로 오버라이드가 basePtz에 반영되면 자동 정합.
- **미접촉**: CaptureJob·CameraClient·MCP server·다른 라우트(480/559/587 requestImage) 무변경.

## 미해결/가정
- **가정 A**: 프론트는 항상 완전한 `{pan,tilt,zoom}` 3필드를 전송(부분 전송 시 서버 basePtz가 불완전해질 수 있음). state.ptz는 항상 3필드를 가지므로(83줄 기본 + 프리셋/명령 동기화) 충족.
- **가정 B**: 실카메라 경로 `state.ptz`가 문자열일 가능성 → `Number()` 변환으로 방어. 프리셋/시뮬 경로는 이미 number.
- **가정 C**: 신규 타입도 주차면 필터(`cap-vpd-onplace` 체크박스)·onPlace 로직을 기존과 동일하게 적용(runModeLpd와 동일 정책). 별도 요구 없으면 이대로.
- 검증: vitest는 detectPipeline 백엔드 오버라이드/회귀 담당, 프론트 DOM·실PTZ 렌더는 **리더 라이브 검증**(뷰어 수동 PTZ → lpd-live 실행 → 서버 로그 req_img ptz가 프리셋 아닌 수동값, LPD 검출·프리셋 스냅 없음 확인).
