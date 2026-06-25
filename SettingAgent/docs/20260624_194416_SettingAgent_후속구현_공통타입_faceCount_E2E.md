# SettingAgent 후속 구현 (3차) — 공통 타입 패키지 / faceCount 교차검증 / E2E 하니스

- 작성일: 2026-06-24
- 선행: 1차(`20260624_181703`), 2차(`20260624_183043`)
- 범위: 2차에서 남긴 후속 3종 마무리

---

## 1. `@parkagent/types` 공통 타입 패키지화 (ActionAgent/DMAgent 계약 안정화)

- 신규 워크스페이스 패키지: `packages/types` (`@parkagent/types`)
  - 공유 도메인 타입: `NormalizedRect, Camera, Preset, ParkingSlot, GlobalSlotIndex, CapturedImage, VehicleBox, ScanTarget, Occupancy, ParkingEvent`.
  - `exports`/`types` 를 `src/index.ts`(소스 .ts)로 노출 → **무빌드**(tsx/tsc NodeNext 가 직접 해석).
- 루트 워크스페이스: `ParkAgent/package.json` 에 `workspaces: ["packages/*", "SettingAgent"]` 추가.
  - `npm install`(루트) 시 `node_modules/@parkagent/types → packages/types` 심링크 생성(확인됨).
- SettingAgent 연결(외과적 변경):
  - `package.json` 에 `"@parkagent/types": "*"` 의존 추가.
  - `src/domain/types.ts` 는 공유 타입을 **재수출**(기존 `../domain/types.js` import 경로 그대로 유지) + `SetupArtifact`(Setting 고유)만 로컬 정의.
- 검증: 두 패키지 `tsc --noEmit` 0 에러, SettingAgent 테스트 그대로 통과.

> 효과: 이후 ActionAgent/DMAgent 는 `@parkagent/types` 만 의존하면 동일 계약을 공유한다. 스키마 변경이 한 곳으로 모인다.

## 2. preset faceCount 교차검증

- `mapTargets.ts` 에 `loadExpectedFaces(presetFile)` 추가 → `(camIdx:presetIdx) → 기대 슬롯 수` 맵.
- `SetupOrchestrator.run(targets, expectedFaces?)` — 프리셋별 **기대 슬롯 수 ≠ 검출 슬롯 수**면 `artifact.warnings[]` 에 경고 기록(셋업은 계속 진행, 비차단).
- `SetupArtifact.warnings?: string[]` 필드 추가(Setting 고유).
- API `/setup/run-from-map` 가 `preset.json`(있으면) 로드하여 교차검증 후 `warnings` 반환.
- 예시: `config/preset.json`. 검증: 기대≠검출 시 경고 기록 / 일치 시 경고 없음(테스트).

## 3. E2E 통합 스모크 하니스

- 신규: `src/tools/e2eSmoke.ts`, npm script `npm run e2e`.
- 절차: 헬스 점검(camera/vpd/brain) → camerapos 자동 로딩 → 셋업 실행 → 산출물 요약(+경고, +두뇌 검토).
- **실서버 필요**: Unity 카메라 + da_vpd_api 필수, 로컬 LLM 선택.
  서버 없으면 헬스에서 FAIL 표시 후 종료(코드 1) — 본 환경에서 그 동작까지 확인.

### 실행법
```bash
# 1) Unity 시뮬레이터(카메라 REST), da_vpd_api 기동
#    tools.config.json 의 camera.baseUrl / vpd.endpoint 를 실제 주소로 맞춤
# 2) (선택) 로컬 LLM(Qwen3/Gemma, OpenAI 호환) 기동 + llm.config.json enabled=true
# 3) cd SettingAgent && npm run e2e
#    → 헬스 OK 시: camerapos 로딩 → 셋업 → 슬롯/전역인덱스/경고 요약 + data/setup_artifact.json 저장
```

---

## 4. 동작 확인 (실측)

- `npm run typecheck`(SettingAgent, packages/types) → **에러 0**
- `npm test` → **48/48 통과** (2차 44 + faceCount 4)
- `npm run e2e`(서버 없음) → 헬스 FAIL 안내 후 코드 1 (의도된 동작) 확인

## 5. 영향도

- 루트 워크스페이스 도입: SettingAgent 의 `node_modules` 가 루트로 호이스트(재설치 완료). 기능 동작 불변.
- `@parkagent/types` 는 **신규 계약 패키지**. 이후 Action/DM 이 이를 의존 → 단일 진실 원본.
- `SetupArtifact` 에 `warnings?` 추가 → 선택 필드라 기존 소비자 영향 없음(하위호환).
- 기존 1·2차 코드 무수정(추가/재수출 위주).

## 6. 남은 후속

- **실서버 E2E 실행**(Unity/VPD/LLM 기동 후 `npm run e2e`).
- ActionAgent 착수 — `@parkagent/types` 의존으로 시작 권장.
- 루트에 ActionAgent/DMAgent 추가 시 `workspaces` 배열에 등록.
