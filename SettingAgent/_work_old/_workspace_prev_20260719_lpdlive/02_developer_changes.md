# 02_구현 변경 요약 — LPD "현재화면 순수 LPD"(lpd-live) 타입 추가

설계서 `01_architect_plan.md` 대로 구현. 전부 옵셔널 확장 — 하위호환 유지, 외과적 최소변경.

## 변경 파일 (4개 + 문서)

| 파일 | 변경 내용 |
|------|-----------|
| `src/capture/detectPipeline.ts` | `runDetect` args 타입에 `ptz?: { pan?; tilt?; zoom? }` 가산. base PTZ 결정부: `args.ptz` 제공 시 `resolvePresetPtz` 호출 스킵하고 `{pan:ptz.pan??0, tilt:ptz.tilt??0, zoom:ptz.zoom??1}` 를 `presetPtz` 로 사용. 미제공 시 기존 `resolvePresetPtz` 경로 그대로. |
| `src/api/captureRoutes.ts` | `DetectBodySchema` 에 옵셔널 `ptz: z.object({ pan/tilt/zoom: z.number().optional() }).optional()` 가산. `/capture/detect` 핸들러 `runDetect` args 에 `ptz: parsed.data.ptz` 전달. |
| `web/index.html` | `#lpd-mode` 콤보에 `<option value="lpd-live">현재화면 순수 LPD</option>` (VPD→LPD 뒤, 맨 끝) 추가. |
| `web/app.js` | `runLiveDetect(vpdEnabled=false, ptz)` — ptz 제공 시에만 body에 `ptz:{pan:Number,tilt:Number,zoom:Number}` 포함. `runModeLpdLive()` 신규(runModeLpd 오버레이 동일 + `runLiveDetect(false, state.ptz)`). 디스패처에 `else if (mode==='lpd-live') runModeLpdLive();` 추가. |

## 핵심 구현 노트

- **base PTZ 오버라이드 정합**: `presetPtz` 가 `requestImage(cam,preset,presetPtz)`(base 렌더)와 `basePtz`(역투영·zoom 재시도 328행 기준) 양쪽에 흐름. 오버라이드 값이 `presetPtz` 에 대입되므로 `inverseProjectQuad`·zoom 재시도가 자동으로 현재 PTZ 기준으로 정합 — 프리셋 스냅 없음.
- **부분 필드 방어**: 서버는 `?? 0/0/1` 기본값으로 방어(설계 가정 A). 실사용은 프론트가 항상 완전한 3필드(`state.ptz` 83행 기본 + 프리셋/명령 동기화) 전송하므로 온전.
- **문자열 방어**: 실카메라 경로 `state.ptz` 가 문자열일 수 있어 프론트에서 `Number()` 변환 → 서버 `z.number()` 통과 보장.
- **하위호환**: 기존 3모드(lpd/discover/vpd)·자동검출(runLiveDetect 무인자 호출)·`resolvePresetPtz` 경로·VPD 정책(기본 off) 전부 불변. ptz 미제공이면 body에 ptz 키 없음 → 서버 옵셔널 파싱 통과 → 기존 경로.

## 검증 결과
- `npx tsc --noEmit` (SettingAgent): **EXIT 0**.
- vitest 유닛테스트는 qa 담당(설계서 검증 (a) ptz 오버라이드 시 requestImage 그 값 호출 + resolvePresetPtz 미호출 / (b) 미제공 시 프리셋 경로 회귀).
- 프론트 DOM·실PTZ 렌더 정합은 리더 라이브 검증.
