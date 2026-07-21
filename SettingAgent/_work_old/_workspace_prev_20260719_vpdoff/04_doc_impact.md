# 04 문서화·영향도 요약 — VPD 자동검출 정지 + VPD 테스트 버튼 분리

작성: documenter · 2026-07-19 · 대상: SettingAgent
최종 문서: `SettingAgent/docs/20260719_172421_VPD자동검출정지_테스트버튼분리.md`

---

## 1. 변경 파일·라인 (근거)

| 파일 | 주요 라인 | 요지 |
|------|----------|------|
| `src/capture/CaptureJob.ts` | :86,134,203,237,380-381,429 | `vpdEnabled` 필드/파라미터, 라운드 게이트, cuboid 게이트, status 노출 |
| `src/capture/types.ts` | :187 | `CaptureStatus.vpdEnabled?` |
| `src/capture/detectPipeline.ts` | :239,246,254,279,370 | runDetect VPD 게이트, seg 게이트, summary 필드 |
| `src/api/captureRoutes.ts` | :51,76,189,193,629 | Start/Detect 스키마 + 라우트 기본 false 배선 |
| `src/pipeline/SetupPipeline.ts` | :63,65 (F10 가드부) | F10 가드 VPD 인지 재정의(결정 E) |
| `web/index.html` | `#cap-detect-run` title, `#cap-vpd-test` 신설 | 버튼 분리 |
| `web/app.js` | `runLiveDetect`, capStart 바디, 버튼 바인딩 ~:3215-3216, 배지 ~:1804, 폴링 ~:1876 | UI 배선 |
| `test/captureJobVpdOff.test.ts` | 신규 | 라운드 게이트 스파이 0/1 |
| `test/detectPipeline.test.ts` | +2 케이스, qa 보강 1(seg 게이트), toEqual 2건 갱신 | runDetect 게이트 |
| `test/captureRoutes.test.ts` | +4 케이스, 기존 4건 `vpdEnabled:true` 주입 | 라우트 게이트 |
| `test/setupPipeline.test.ts` | +2 케이스 | F10 우회/유지 |

무접촉(회귀 0): `onPlaceFilter.ts`, `Aggregator.ts`, `Finalizer.ts`, `PlateDiscoveryJob.ts`·`plateDiscovery.ts`·`plateDiscoveryWriter.ts`, `PtzCalibrator.ts`·`platePtz.ts`·`slotPtzWriter.ts`.

---

## 2. 소비처 교차확인 — setup_artifact.json 빈 slots (설계서 §7-3 이관 항목, 직접 확인 완료)

**결론: 크래시 없음. 단 UX 상 "슬롯 0" 노출 갭 존재(정직 명시).**

- `Finalizer.finalize()`(`Finalizer.ts:186-215`)는 **VPD 종속 `accepted` 클러스터로만** `SetupArtifact.slots/globalIndex`를 조립해 `repo.saveArtifact()`(:215)로 `setup_artifact.json`에 저장 — `slot_setup`(DB, geometry) 블록(:222-280)과 **별개 소스**.
- `GET /mapping`(`server.ts:232-239`)은 `repo.loadArtifact()`를 그대로 반환 — VPD off finalize 후엔 `slots:[]`, `globalIndex:[]` 가능.
- 소비 측: `web/app.js loadMapping()`(:170-177), `web/core.js`의 모든 소비 함수(`Array.isArray(...) ? ... : []`, `?? []` 패턴, 10곳 이상)가 **전부 방어적** — 빈 배열에 크래시 없음.
- `capFinalize()`(`app.js:2116-2133`)는 finalize 후 `"최종화 완료: 슬롯 ${data.slots}, 전역 ${data.globalCount}"` 메시지 표시 + `loadMapping()`으로 검수 탭 갱신 — VPD off로 slots=0이면 **"슬롯 0"으로 표시되어 실패처럼 오인될 수 있는 UX 갭**이 실재. 크래시/데이터 파괴는 없음(DB `slot_setup`은 geometry로 계속 채워짐). 코드 수정은 이번 스코프(VPD 게이트) 밖이라 변경하지 않았고, 문서(§6.2)로 리더에게 명시 전달함.

---

## 3. 회귀 방지 근거 (실측 인용)

- `npx tsc --noEmit` → 에러 0.
- `npx vitest run` → **170 files, 1902 tests, 0 failed**(구현자 1901 + qa 보강 1).
- 기존 6건 테스트 갱신은 qa 감사로 "정당"(의도 변경 반영, 거동 회귀 은닉 아님) 판정 — summary 필드 추가로 인한 toEqual 3건 + 라우트 기본 OFF로 인한 VPD 거동 테스트 3건(`vpdEnabled:true` 명시 주입, 원 필터 단언 불변).
- 자동 경로 잔존 VPD 호출 0 — qa가 `SetupOrchestrator`(레거시 `/setup/run`)·MCP `vpd_detect` 도구·`GET /capture/vehicle-cuboids` 3면을 코드로 추적해 전부 수동 트리거 한정임을 확정.
- LPD 보존(vehicles=[] 폴리곤 직접 필터) — `onPlaceFilter.ts` 무접촉 로직 분석 + 스파이 테스트로 확인.

---

## 4. 메모리 정합 확인

- [[vpd-auto-detect-forbidden]]: "VPD는 자동 경로에서 돌리지 않는다, 별도 테스트 버튼" — **본 변경과 완전 정합**. 배경 인용문·방해 기전(vehicles 결박)도 동일 근거로 문서에 인용함.
- [[finalize-slotsetup-wipe-fragility]]: F10 가드(`dets===0` → finalize 미실행)와의 상호작용 — 본 변경은 이 가드를 "VPD 인지"로 재정의(VPD off일 때만 우회)했으며, 우회 시에도 `prev` 보존 가드(해당 메모리에 기록된 방어 로직)가 그대로 유지되어 검출 컬럼 파괴가 없음을 코드로 재확인(`Finalizer.ts:263-265`). 정합.

---

## 5. 남은 한계 (완료로 위장하지 않음)

- 실 VPD/LPD·카메라 라이브 미관찰(qa 리포트 §6 그대로) — "검출 실행"/"VPD 검출(테스트)" 버튼의 실제 화면 거동, status 배지 렌더는 리더의 라이브 확인 필요.
- F10 부트스트랩의 실제 DB 기록(slot_setup 행 + slot3d_front_center)은 스텁 경계까지만 검증됨 — end-to-end는 리더 몫.
- web/app.js·index.html은 코드 정독으로만 확인, 브라우저 실행 미관찰.
- §2의 "검수 탭 슬롯 0" UX 갭은 정적 추적(크래시 없음)으로 확정했으나, 실제 화면에서의 사용자 인지 확인은 라이브 대상.

---

## 6. 리더 전달

- 최종 문서: `SettingAgent/docs/20260719_172421_VPD자동검출정지_테스트버튼분리.md`
- 소스 결함 없음(qa 판정 그대로). 회귀 0, 성공 기준 전부 봉인.
- 설계서 §7-3 미해결 항목(setup_artifact 빈 slots 소비처)은 이 문서 §2에서 직접 확인 완료 — 크래시 없음, 다만 검수 탭 UX 상 "슬롯 0" 오인 가능성은 리더가 인지할 필요.
