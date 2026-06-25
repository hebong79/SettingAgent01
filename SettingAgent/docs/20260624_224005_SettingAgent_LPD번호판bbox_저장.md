# SettingAgent — VPD 차량 bbox + LPD 번호판 bbox 함께 저장

- 작성일: 2026-06-24
- 요구: VPD 차량 검지 후 LPD 로 번호판 위치를 검출·저장하여 **차량 bbox + 번호판 bbox 둘 다** 보관.
  ActionAgent 센터라이징의 prior(초기 조준점)로 활용.
- 전제: 현재 실행은 이 PC(localhost). 추후 다른 PC 가능 → 호스트는 config 로만 변경.

---

## 1. 데이터 모델 (공유 계약 `@parkagent/types`)

`ParkingSlot` 에 번호판 ROI 맵을 추가(차량 ROI 와 병렬, 선택 필드 → 하위호환).

```ts
interface ParkingSlot {
  slotId: string;
  zone: string;
  roiByPreset: Record<string, NormalizedRect>;        // VPD 차량 ROI
  plateRoiByPreset?: Record<string, NormalizedRect>;  // LPD 번호판 ROI (신규)
}
```
- key = `${camIdx}:${presetIdx}` 로 두 맵이 동일 프리셋을 가리킴 → 같은 좌표계에서 차량/번호판 bbox 모두 사용 가능.
- 선택 필드라 Action/DM 등 기존 소비자 영향 없음.

## 2. LPD 클라이언트 + 매칭

- `src/clients/LpdClient.ts` — `da_lpd_api POST /lpd/api/v1/imgupload`(multipart `file`) 호출,
  픽셀 bbox → 캡처 해상도로 정규화. 응답 `confidences`(혹은 단수 `confidence`) 방어적 처리. (VpdClient 와 동형)
- `src/setup/plateMatch.ts` — `matchPlatesToSlots(slots, plates)`:
  번호판 중심이 차량 ROI 안에 있으면 후보, **겹침(교집합) 최대** 차량에 귀속(차량 1대 = 번호판 1개).
  → `positionIdx → 번호판 ROI` 맵 반환.

## 3. 셋업 흐름 통합 (`SetupOrchestrator`)

```
프리셋 캡처 → VPD 차량검지(built) → [게이트1] →
  └ (cfg.lpdEnabled) LPD 검출 → matchPlatesToSlots → slot.plateRoiByPreset[key] 저장
  → 슬롯/전역인덱스 구성
```
- `detectPlates()` 헬퍼: `lpdEnabled=false` 또는 `lpd` 미주입 시 건너뜀. **실패해도 셋업 비중단**(경고만).
- 매칭 누락(번호판 < 차량)도 경고로 기록(예: 가림/저각도).
- LPD 입력 이미지는 해당 프리셋의 캡처 프레임(`captured.jpg`).

## 4. 설정

- `tools.config.json`
  - `lpd` 섹션: `endpoint`(기본 `http://127.0.0.1:9082`), `detPath`(`/lpd/api/v1/imgupload`), `apiKeyEnv`, `timeoutMs`, `maxRetries`.
  - `setup.lpdEnabled`(기본 `false`): 셋업 시 번호판 검출/저장 on/off.
- 호스트는 현재 localhost. 다른 PC 로 옮기면 `lpd.endpoint`/`vpd.endpoint`/`camera.baseUrl` 호스트만 변경.

## 5. ActionAgent 센터라이징 활용(설계 의도)

저장된 `plateRoiByPreset` 는 ActionAgent 가 센터라이징을 시작할 때 **번호판 초기 위치 prior** 로 사용:
- VLA `/centering` 의 첫 조준을 번호판 ROI 중심으로 시작 → PTZ 이동·줌 반복(폐루프) **수렴 가속**.
- 번호판이 화면에서 차지할 대략 크기를 미리 알아 줌 목표(화면 20%) 도달을 빠르게 추정.
- prior 일 뿐이며 ActionAgent 는 실측(폐루프)으로 보정(좌표 환각 없음).

## 6. 동작 확인 (실측)

- `npm run typecheck` → **에러 0**
- `npm test` → **61/61 통과** (기존 55 + 신규 6: plateMatch 4, 오케스트레이터 plateRoi 2)
  - `plateMatch.test.ts`: 중심 포함 귀속/2슬롯 매칭/비매칭/겹침 우선.
  - `setupOrchestrator.test.ts`: `lpdEnabled=true` → `plateRoiByPreset` 저장, `false` → 미저장.
- 실 LPD 서버(`Sub/da_lpd_api`, :9082) 연동 확인은 서버 기동 후 `lpdEnabled=true` 로 셋업 시 수행.

## 7. 영향도

- `@parkagent/types.ParkingSlot.plateRoiByPreset?` 선택 필드 추가 → 하위호환.
- `tools.config.setup.lpdEnabled` 기본 `false` → 옵트인. 기존 셋업 동작 불변.
- LpdClient/plateMatch 신규. 오케스트레이터는 LPD 미사용 시 기존 경로 그대로(테스트로 보증).
- 실패 격리: LPD 오류는 경고만 남기고 셋업 계속(번호판 prior 는 선택적 향상).
