# 03. 검증 리포트 — 로컬 Qwen2.5-VL 국소화 정확도 개선(해상도↑ + 네이티브 픽셀 그라운딩 + 좌표변환)

검증자(qa-tester) · 대상 SettingAgent · 근거 `01_architect_plan.md`(§8 테스트) · `02_developer_changes.md`(§QA 인계: 깨진 18건)
방법: vitest 유닛(외부 LLM/서버 모킹 — fake OpenAI 호환 HTTP 서버 · openai SDK/이미지 모듈 partial mock). 실호출 없음.

---

## 0. 최종 결과(요약)

| 항목 | 결과 |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | **에러 0** |
| `npx vitest run` (전체) | **85 파일 / 831 테스트 전건 PASS**, 0 실패 |
| 착수 시점 스냅샷 | 82 파일 / 805 테스트 (20 실패 / 785 통과) |
| 마이그레이션·신규 후 | +3 파일(신규), +26 테스트, **실패 0** |

착수 시 실패 20건은 전부 **픽스처 shape 마이그레이션**(정규화 polygon→절대픽셀 points_2d, 비-JPEG→실제 JPEG, 다운스케일 치수 갱신, config/prompt 기대값 갱신)이었고 신규 로직 결함은 없었다. 근본 원인을 픽스처에 정확히 반영해 그린화했으며, 테스트를 느슨하게 고친 곳은 없다(수치·경계 단언 강화).

---

## 1. tsc

`npx tsc -p tsconfig.json --noEmit` → **0 에러**(src·test 전부). 신규 테스트 3종 포함 타입 정합.

---

## 2. 전체 스위트(passed/failed 그대로)

```
Test Files  85 passed (85)
     Tests  831 passed (831)
```

- 다운스트림 회귀 0: floorRoi / floorRoiNormalizeEdge / floorRoiReviewer / finalizerFloor / floorRoiStore / occupancyReviewer / occupancyStore / sqliteStore 전부 통과 → **FloorRoiResult(정규화 4점)·OccupancyJudgment(정규화 폴리곤/집계) 반환 계약 불변 재확인**(성공기준 3).

---

## 3. 갱신·신규 테스트

### 갱신(픽스처 마이그레이션 — 깨진 18+2건 그린화)
| 파일 | 조치 |
|---|---|
| `test/agentRuntimeFloor.test.ts` | 전면 재작성. 실제 1288×728 JPEG + `imageMaxEdge=1288`(smartResize 항등 → W=1288,H=728). fake 응답을 픽셀 `points_2d`/`bbox_2d` 로. 정규화 정합·중심 수치·bbox 폴백·둘다부재 null·enabled=false/llm=false null. |
| `test/agentRuntimeOccupancy.test.ts` | 실제 952×532 JPEG(edge960 항등 → W=952,H=532). fake spaces 를 픽셀 `points_2d` 로. 정규화 정합·폴리곤 미보유 graceful. T-2(guided off·extractJson)·T1~T4(타임아웃 격리) 픽셀 응답으로 갱신. **T2 재정의**(아래 §리스크). |
| `test/agentRuntimeNative.test.ts` | `FLOOR_JSON` 을 픽셀 `points_2d` 로. (d)/(c) 다운스케일 단언 **960×540 → 952×532**(smartResize prepared 경로) + 28배수 단언 추가. |
| `test/promptsYaml.test.ts` | floor_roi 단언 `[앞왼`·`{{vehicle}}` → `points_2d`·`front-left`·`{{imgW}}`·`{{vehiclePx}}`·`{{imgH}}`. 치환 검증도 신 키로. |
| `test/llmThinkConfig.test.ts` | 실제 config imageMaxEdge 기대 **960 → 1288**(default 계약은 960 유지 확인). |
| `test/config.test.ts` | 신규 케이스: 실제 config `imageMaxEdge=1288`·`floorRoi.timeoutMs=300000`, default 960·120000 하위호환. |

### 신규(설계 §8)
| 파일 | 커버 |
|---|---|
| `test/imageSmartResize.test.ts` (7) | (a)28배수·≤MAX_PIXELS (b)종횡비 근사<1.5% (c)소형 28스냅 (d)4:3 대형 상한 엄수 (e)유효 JPEG (f)비이미지 throw + **파이프라인 수치**(1920×1080→1288×728, [644,364]→{0.5,0.5}). |
| `test/rawGroundingSchema.test.ts` (12) | FloorRoiRawSchema/OccupancyRawSchema 픽셀 파싱·4점아님 거부·둘다부재 refine 거부·tuple 길이·graceful·필수필드(성공기준 4). |
| `test/preparedNoRedownscale.test.ts` (2) | image 모듈 partial mock 로 `downscaleJpegBase64` 호출 관찰 → floor(prepared) 미호출·centering(비prepared) 호출(성공기준 5). |

---

## 4. 성공 기준 1~6 충족(파일:라인)

| 기준 | 충족 근거 |
|---|---|
| **1. 좌표변환 정확(핵심)** | `imageSmartResize.test.ts`(1920×1080→**1288×728** 전송, [644,364]→{0.5,0.5}); `agentRuntimeFloor.test.ts`(points_2d/W,H 정합·중심 수치·bbox_2d→rectToQuad(normalizeBox) 정규화 4점); `agentRuntimeOccupancy.test.ts`(면별 points_2d 정규화). **정규화 분모=전송(W,H)** 를 항등 이미지로 결정적 단언. |
| **2. smartResize** | `imageSmartResize.test.ts` 전 7케이스(28배수·≤1.0M·종횡비·반환(W,H) 실측·비이미지 throw). |
| **3. 반환 타입 불변·회귀 0** | 다운스트림 스위트 전건 PASS(floorRoi/reviewer/finalizer/store); `agentRuntimeOccupancy.test.ts`(집계 total/occupiedCount/rate 결정형 불변)·`#1 OccupancySpaceSchema`(정규화 계약 불변). |
| **4. RAW 스키마 파싱** | `rawGroundingSchema.test.ts`(12): points_2d/bbox_2d 파싱, 3·5점 거부, 둘다부재 refine 거부, occupancy graceful(미보유 통과). |
| **5. 재다운스케일 방지** | `preparedNoRedownscale.test.ts`(floor prepared → downscale 미호출 / centering → 호출); `agentRuntimeNative.test.ts`(전송 이미지=952×532 smartResize 결과). |
| **6. 회귀 0** | 전체 831/831 PASS. |

---

## 5. 좌표변환 수치검증 결과(결정적)

- **전송 크기 확보**: smartResizeJpegBase64 실측 — 1920×1080@1288 → **1288×728**(28배수, 937,664px ≤ 1,003,520), 1920×1080@960 → **952×532**, 952×532@960 → 항등, 300×200@1288 → 308×196.
- **points_2d 정규화**: `[644,364] / (1288,728)` → `{x:0.5, y:0.5}`(≤1e-6). 4코너 각 `px/W, py/H` 정합(≤1e-5), 전부 0~1 범위.
- **bbox_2d 경로**: `bbox_2d=[0,0,644,364]` → `rectToQuad(normalizeBox(_,1288,728))` → `[{0,0},{0.5,0},{0.5,0.5},{0,0.5}]` 정확.
- **정규화 기준=전송크기 입증**: 원본(1920×1080)이 아니라 전송(1288×728)이 분모임을 항등-리사이즈 이미지로 결정적으로 단언(전송≠원본 케이스는 native 952×532 로도 교차 확인).

## 5-1. 경계면 교차 비교(shape)

- **모델 출력(RAW 픽셀) ↔ 소비측(AgentRuntime 정규화 경계)**: fake 서버가 낸 `points_2d`(픽셀) → `recognizeFloorRoi`/`judgeOccupancy` 가 `normalizeQuad`/`rectToQuad(normalizeBox)` 로 0~1 변환 → 다운스트림은 정규화 폴리곤만 소비. shape 불일치 없음.
- **per-request 타임아웃 경계(SDK create 2번째 인자)**: occupancy=`{timeout: occupancy.timeoutMs}`, floor=`{timeout: floorRoi.timeoutMs}`(신규) 를 create 인자에서 직접 캡처해 검증. floor 가 자기 값으로 격리됨을 T2 로 실증.
- **프롬프트 치환 키 ↔ 렌더러**: floor_roi/occupancy yaml 의 `{{imgW}}/{{imgH}}/{{vehiclePx}}` 신 키가 renderTemplate 로 전부 치환됨(`{{` 잔존 0).

---

## 6. 미검증(명시)

- **실 Qwen2.5-VL 국소화 품질(육안)**: 자동 미검증. 리더 라이브 스모크 필요 — floorRoi.enabled=true 실제 프레임 1~3장 → 오버레이 폴리곤이 차량 접지면과 정합하는지, occupancy 면별 폴리곤 육안, 좌표 sanity(0~1·4점·앞=y큰쪽). (설계 §7-7 계승)
- **서버 vLLM min/max_pixels**: 전송(≈0.94M) 재축소 여부는 서버 구성 의존 — 유닛 범위 밖(가정: max_pixels ≥ 1.0M). 어긋나면 좌표 불일치 → imageMaxEdge 하향 필요.

---

## 7. 리스크 / 판단 기록

1. **T2 테스트 의미 변경(재정의, 느슨화 아님)**: 구현이 floor 에 `floorRoi.timeoutMs` per-call 을 신설·전달하므로, 구(舊) T2("floor 는 per-call 미전달 → create 2번째 인자 undefined")는 더 이상 참이 아니다. 새 계약(floor=자기 `floorRoi.timeoutMs` 사용, 전역과 격리)에 맞춰 `floorTimeoutMs=50 / 전역=5000 / 지연=300` 으로 **floor 가 자기 값으로 타임아웃 + create 2번째 인자 `{timeout:50}`** 을 단언하도록 재정의. 격리 실증이라는 원 취지는 보존.
2. **OBB(4점) points_2d 신뢰도**: Qwen 네이티브는 축정렬 bbox/point 가 더 안정적 — 임의 사변형 4코너는 상대 OOD. RAW 파서가 bbox_2d 도 수용(폴백)하고 다운스트림 결정형 폴백이 있어 유닛은 강건하나, **실측 품질은 스모크 전까지 미검증**. 부정확 시 설계 §10-2 대안(bbox 우선+번호판 회전).
3. **28 스냅 종횡비 변형 ≤1.5%**: 정규화가 전송 기준이라 무해(테스트 (b) 로 상한 확인).

---

## 결론

CLAUDE.md 규칙 2·3 충족: 유닛테스트 작성·실행으로 좌표변환/smartResize/RAW파싱/재다운스케일방지/반환계약불변을 **결정적으로 검증**, tsc 0 · 831/831 PASS. 실 Qwen 국소화 품질만 리더 라이브 스모크로 이관(자동 미검증 명시).
