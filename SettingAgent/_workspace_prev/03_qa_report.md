# 03 · 검증 리포트 — LLM 비전 차량 바닥 ROI(floor ROI · 4점 사변형)

작성: 검증자(qa-tester) · 대상: SettingAgent · 입력: `02_developer_changes.md` + `01_architect_plan.md` + 변경 소스 + 신규/수정 테스트
판정: **PASS · 회귀 0 · 재작업 불요**

---

## 0. 결과 요약(수치 그대로)

| 항목 | 명령 | 결과 |
|------|------|------|
| SettingAgent 타입체크 | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) | **통과**(exit 0, 무에러) |
| @parkagent/types 타입체크 | `npx tsc --noEmit` (패키지 디렉터리) | **통과**(exit 0) |
| 전체 테스트 | `npm test` (`vitest run`) | **42 파일 / 278 테스트 전부 통과** |
| floor 신규+수정 테스트 | `npx vitest run floorRoi…` | **8 파일 / 58 테스트 통과** |
| 뷰어 JS 문법 | `node --check web/app.js`, `web/core.js` | **둘 다 exit 0** |

- 기준선 248 + 신규 30 = **278**(구현자 보고와 일치). **기존 회귀 0**.
- `@parkagent/types` 는 `package.json` 의 `exports`/`types` 가 `./src/index.ts` 를 직접 가리키는 **소스-소비 패키지**(build/typecheck npm 스크립트 없음). 그래서 인계의 `npm run typecheck`(types)·`npm run build`(types) 는 "Missing script" 로 실패하나, 이는 결함이 아니라 패키지 설계임 — `npx tsc --noEmit` 로 직접 검증해 통과 확인. SettingAgent typecheck 가 이 타입을 실제 해석하므로 통합 타입 인식도 입증됨.
- 라이브 서버 미기동(지침 준수). 검증은 typecheck + vitest(브레인/스토어/카메라 모킹)로만.

신규 테스트 구성(30): `floorRoi`(10) · `floorRoiStore`(3) · `agentRuntimeFloor`(3) · `floorRoiReviewer`(8) · `finalizerFloor`(2) + 수정분 `config`(+1) · `analyzeArtifact`(+2) · `viewerCore`(+1).

---

## 1. 폴백(핵심) — floor ROI 항상 존재

`capture/floorRoi.ts`(순수·외부의존 0) + `floorRoi.test.ts`(10) 교차 검토.

- **`resolveFloorQuad(llmQuad, vehicle)` = `normalizeQuad(llmQuad) ?? fallbackQuadFromRect(vehicle)`** — LLM 결과가 무효이면 무조건 폴백. floor ROI 가 비는 경로 없음.
- **무효 판정**: 점≠4(3점 테스트)·NaN 포함·undefined/null → `normalizeQuad` 가 `null` → 폴백. (확인됨)
- **클램프**: 범위 초과 입력(-0.5, 1.5 등)을 `clamp01` 로 0~1 강제. `fallbackQuadFromRect` 도 모든 점 `clamp01`(범위 초과 rect 테스트 통과).
- **순서 규약**(`[앞왼,앞오,뒤오,뒤왼]`): y 기준 하(앞=y큼)/상(뒤=y작음) 2점씩 분리 → 각 쌍 x 기준 좌/우. 뒤섞인 입력을 규약 순서로 재정렬하는 테스트로 고정. LLM 순서 오류가 뷰어 폴리곤을 꼬지 않음.
- **경계 교차**: `FloorRoiReviewer` 가 LLM throw(`floorRoiReviewer.test.ts` "LLM throw → 폴백")·LLM null("무효 quad(null) → 폴백") 모두 `fallbackQuadFromRect(vehicleRect)` 와 정확히 일치하는 quad 를 upsert 함을 검증 — 폴백 발동 지점이 reviewer 까지 일관.

판정: **폴백 보장 검증 완료.**

---

## 2. 체크포인트 통합 — FloorRoiReviewer

`FloorRoiReviewer.review()` + `CaptureJob.checkpoint()` + `floorRoiReviewer.test.ts`(8) 교차 검토.

- **cadence**: `CaptureJob.checkpoint(roundIdx)` 끝에 `floorReviewer.review(runId, slots, lastFrameByPreset)` 가산(`checkpointEvery` 재사용, 별도 주기 없음). `floorReviewer` 옵셔널 → 미주입 시 기존 동작(기존 captureJob 테스트 10건 무회귀).
- **채택 슬롯만**: `status !== 'rejected' && !== 'merged'` 필터 → rejected/merged 제외 테스트 통과.
- **프레임 보유 슬롯만**: `framesByPreset.get(presetKey)` 없으면 skip("프레임 있는 프리셋만 upsert" — 1:2 프레임 없어 skip).
- **maxPerCheckpoint 상한**: 5슬롯·상한 2 → LLM 호출 2회·upsert 2건(테스트 통과). 초과분은 다음 주기(폴백 항상 있어 누락 무해).
- **장애격리**: `recognizeFloorRoi` throw 를 try/catch 로 흡수 후 폴백 upsert(로그 `floor ROI 추론 실패(폴백)` 는 의도된 경고 — 테스트 통과 경로).
- **CaptureJob.lastFrameByPreset**: `start()` 에서 `clear()`, `captureTarget()` 에서 `${camIdx}:${presetIdx}` 키로 set(기존 `lastFrame` 1장 보존, 가산 1줄). presetKey 규약 일치.
- **plate 전달**: plate bbox 존재 시 `input.plate` 로 전달("plate 가 있으면 input.plate 로 전달" 통과).

판정: **체크포인트 통합 검증 완료.**

---

## 3. 저장 / 최종화

`SqliteStore`(floor_roi) + `Finalizer` + `floorRoiStore.test.ts`(3) + `finalizerFloor.test.ts`(2) 교차 검토.

- **별 테이블 `floor_roi`**: PK(run_id, preset_key, cluster_id), `CREATE TABLE IF NOT EXISTS`(마이그레이션 불필요). `upsertFloorRoi` = `INSERT … ON CONFLICT … DO UPDATE`(같은 키 재upsert → 갱신·중복 행 없음, 테스트 통과). 런/클러스터 격리 테스트 통과.
- **집계 멱등과 분리**: `replaceAggregatedSlots` 는 `aggregated_slot` 만 delete+insert. floor_roi 는 건드리지 않음 → 집계 재실행에도 floor quad 소실 없음(설계 §6 근거 구현 확인).
- **quad shape/순서 왕복 보존**: 8실수 → x0..y3 컬럼 → 4점 배열 복원. `floorRoiStore.test.ts` 의 `toEqual(q)` 와 `finalizerFloor` 의 `toEqual(quad)` 가 순서까지 동일 보장.
- **Finalizer 가산**: `getFloorRois(runId)` → `floorByRef: Map<`${presetKey}#${clusterId}`, quad>` → `assemble` 에서 `clusterRef(m)`(=`${presetKey}#${clusterId}`, CheckpointReviewer 와 동일 키 함수) 매칭 시 `slot.floorRoiByPreset = { [key]: quad }`. floor 없으면 키 미생성(옵셔널 보존, "필드 부재" 테스트 통과).
- **경계 교차(키 일치)**: reviewer 가 저장하는 키(`s.presetKey`, `s.clusterId`)와 Finalizer 가 조회하는 키(`f.presetKey#f.clusterId` ↔ `clusterRef(member)`)가 동일 규약 — 누락·미스매치 없음 확인.

판정: **저장/최종화 검증 완료.**

---

## 4. 계약 불변(가산)

- **ParkingSlot 계약**: `roiByPreset`/`plateRoiByPreset` 불변(`finalizerFloor` 가 `roiByPreset['1:1']` 정확값 동시 검증). `floorRoiByPreset?` 옵셔널 가산 → ActionAgent/DMAgent·기존 `/mapping`·`/setup`·`/capture` 무영향(기존 테스트 248 회귀 0).
- **SetupBrain.recognizeFloorRoi?**: 인터페이스에서 **옵셔널** → 이 메서드 없는 기존 브레인 모킹도 타입 만족(기존 brain 테스트 무회귀).
- **AgentRuntime.recognizeFloorRoi**: 기존 `chatJson` + `image_url`(data:image/jpeg;base64) 멀티모달 경로 100% 재사용. `agentRuntimeFloor.test.ts` 가 fake 서버 body 에 `image_url`·`data:image/jpeg;base64,` 포함을 검사 → 신규 HTTP 경로 0 확인. `floorRoi.enabled=false` 또는 `llm.enabled=false` → null(호출 안 함) 검증.
- **설정 하위호환**: `FloorRoiSchema.optional()` 라 floorRoi 없는 config 리터럴(기존 agentRuntime.test 등)도 파싱 성공. 단, `loadLlmConfig` 머지는 `{...DEFAULT.floorRoi, ...raw.floorRoi}` 라 **로드 결과는 항상 `cfg.floorRoi` 정의됨**(런타임 `cfg.floorRoi?.enabled` 접근 안전). 설계 §8 의 "미설정 시 undefined" 서술과 다르나(02 노트 §4-1 에 명시), 기능·계약 영향 없음 — 검증자 동의(런타임 안전성 측면에서 더 견고).

판정: **계약 불변 검증 완료.**

---

## 5. 뷰어

- **`toPixelQuad(quad, imgW, imgH)`**: 순수 변환(`quad.map(p => ({px:p.x*imgW, py:p.y*imgH}))`). viewerCore 테스트 통과.
- **`analyzeArtifact`**: slot 평탄화에 `hasFloor = !!(s.floorRoiByPreset && keys.length)`, totals 에 `withFloor` 누적. `analyzeArtifact.test.ts`(+2) 통과.
- **`drawRoiOverlay`**: `slot.floorRoiByPreset?.[key]` + `showFloor` 토글 시 `beginPath→moveTo/lineTo→closePath`(폐곡선) 폴리곤, `#39ff14`(청록/노랑과 구분). toPixelQuad 출력 순회와 일치.
- **`index.html`**: `roi-floor` 체크박스(기본 checked) 존재. `app.js` 가 `$('roi-floor').addEventListener('change', drawRoiOverlay)` 등록. 분석 카드 '바닥 ROI' = `t.withFloor`.
- **JS 문법**: `node --check` app.js·core.js 둘 다 통과.

판정: **뷰어(순수 로직·문법·요소 존재) 검증 완료.**

---

## 6. 발견 결함 / 수정

- **구현 결함: 없음.** 테스트 작성 실수로 인한 수정 없음. 통과 위장 없음.
- 인계 문서의 `npm run typecheck`(@parkagent/types)·`npm run build`(types) 명령은 해당 패키지에 스크립트가 없어 실패하나, 이는 types 가 소스-직접-소비 패키지인 설계 때문이며 결함 아님(§0 참조). `npx tsc --noEmit` 로 대체 검증 통과.

---

## 7. 미커버(명시)

- **실 gemma4:12b 좌표 정확도**: vitest 는 brain/서버 모킹. 사변형 정밀도·접지면 추정(지붕 아닌 바닥)·순서 정확도는 **실 LLM 호출로만** 검증 가능. `normalizeQuad`(순서 강제·클램프)+폴백이 안전망이나, 실측 quad 가 차체 윤곽을 찍는 경향이면 프롬프트(접지면 강조) 튜닝 필요. → 마스터 라이브 수집 후 뷰어 폴리곤(#39ff14) 육안 확인 권장.
- **라이브 서버 / Play 모드 스모크**: 미수행(지침: 라이브 기동 금지). REST `/capture` 실연동·실제 체크포인트 주기 floor 갱신은 별도 스모크로 표시.
- **브라우저 DOM 렌더링**: `drawRoiOverlay` 의 canvas 실제 픽셀 출력은 비검증(jsdom/headless 미사용). 순수 변환(`toPixelQuad`)·문법·요소 존재까지만 커버.
- **confidence 임계 폴백**: 1차 미적용(유효 quad 면 채택). 설계 §13-C 후속 — 현재 범위 외.

---

## 8. 최종 판정

**PASS.** 278/278 통과(기존 248 회귀 0, 신규 30 전부 통과), 타입체크 통과, 뷰어 JS 문법 통과. 폴백 보장·체크포인트 통합·저장/최종화·계약 불변·뷰어 모두 검증. 경계면(reviewer→store→finalizer→slot quad 키·순서, runtime image_url 경로) 불일치 없음. **재작업 불요** — 문서화 단계 진행 가능.
