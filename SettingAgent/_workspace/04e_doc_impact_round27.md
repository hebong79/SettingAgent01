# 04e. 문서화·영향도 요약 — 27회차(27-A/27-B/27-C)

- 최종 문서: `docs/20260731_140000_27회차_K1최종미달_B상신_프레임아카이브_지면모델규명.md`
- 근거: `_workspace/51_architect_plan_round27_contour_refine.md` · `_workspace/52_developer_frame_archive_round27.md`(27-B) · `_workspace/53_developer_realcam_groundmodel_round27.md`(27-C) · `_workspace/54_developer_contour_refine_round27.md`(27-A) · `docs/20260731_101840_1-25회차_결과설계_종합분석과_방향성.md` §6-4 K1

## 핵심 요약

**K1 확정 — T4(선분 모델에 방위 정보 없음) — 기하 자력 수리 노선 종료, 선택지 B 상신.** 정제 후 best-of-two `11.100430381019102` / best-of-three `11.007123357580006` 전부 판정선(`10`) 미달. F4(꺾임점 고정) 실검출 이득 `0`(26회차와 완전 동일), 음성 대조군 N1(무작위 절사)이 오히려 이겼다(`0.5983810637389073`). 부검 결과 악화 14건 중 12건이 「두 선분 다 chord보다 나쁨」 — 선택 규칙이 아니라 콘투어 분해 자체에 정보가 없다.

**27-B(프레임 아카이브)**는 서비스 경로(`roiAuto.ts`)를 접촉한 유일한 하위 회차 — 검출 코어를 `detectGridFromFrame`으로 추출해 서비스·재현기가 같은 함수를 지나게 했고, 11/11 비트 동일 재현으로 R3(과거 요구 프레임 미저장)를 해소. 성능 비용 0.13~0.21%로 기본 ON. 도입 직후 vitest가 아카이브를 오염시킨 사고를 실측으로 확인·차단.

**27-C(지면모델 규명)**는 리더의 두 가정을 모두 정정했다 — ① 「PTZ 읽기가 이동보다 291ms 빠르다」는 패킷 로그 요약 집계(`packetAggregator`, 5분 창)를 오독한 것 ② 「검출이 시뮬 기하(5m)를 쓴다」는 틀렸고, 5m은 배너·3D 육면체·Finalizer에서만 쓰인다. `/capture/ground-model`이 카메라 식별자를 받지 않는 구조적 결함(`captureRoutes.ts:951`)이 5m의 진짜 출처. 마스터 관측 6/4/2/4 요동은 프레임 종속 단독(지면모델은 무죄, 단 수준(level)엔 크게 관여).

## 영향도

- **서비스 경로 접촉은 27-B 한 건뿐**: `src/rpc/services/roiAuto.ts`(archive 배선 + 검출 코어 추출, 로직 0줄 변경). 27-A·27-C는 `src/tools/`·`test/` 신규/수정에 국한.
- 신규 서비스 인접 파일: `src/capture/frameArchive.ts`(신규, 순수 fs 모듈) · `src/tools/roiAutoReplay.ts` · `src/tools/frameArchiveBench.ts` · `vitest.config.ts`(테스트 시 아카이브 강제 OFF) · `.gitignore`.
- 27-A 신규: `src/tools/contourRefine.ts`(4함수, 그중 2개는 미배선) · `test/contourRefine.test.ts`. 수정: `groundErrProbe.ts`(계측) · `contactOrient.ts`(기본값 무변경 F4 분기) · `imageObservation.ts`(`edge='kink2'` 추가, 기본 `'chord'` 유지) · `individualEngine.ts`(CLI 1줄).
- 27-C 신규: `src/tools/realGroundSplit.ts`(진단 전용, import만).
- **`@parkagent/types`·REST 계약·ActionAgent/DMAgent 접촉 없음.**
- **정본·DB 무접촉, `roi.auto.apply` 0회.** 카메라 이동 자체 발생 0건이나, 제3자(마스터 추정)가 실카를 이동시킨 것을 27-B·27-C 양쪽이 독립적으로 로그로 확인·보고(리더 판단 대기).

## 검증(문서화 담당 재실행)

- `npx tsc --noEmit` → **exit 0**(재실행 확인)
- `npx vitest run` → **308 파일 / 3895 테스트 전부 green**(재실행 확인, 착수 시 red 1건은 27-B가 `NOT_SEALED` 등재로 이미 해소)
- 골든 rows 재실행(`roiAutoRecall.ts v1 evidence rows --raw`): recall `0.5853658536585366` · precision `0.8571428571428571` · meanIoU `0.8886003068644802` · minIoU `0.6130202566182261` · pass95/98 `8`/`1` · 프레임해시 5개 전부 **비트 동일** 확인.
- Q7(rows md5 `d0af19b395edca366296cbd154f104f5`)은 문서화 단계에서 재계산하지 않음 — **인용**(raw 지표 전량 비트 동일로 간접 확인됨).

## 확인 필요

- 실카 현재 PTZ(`7034/2760/8155`, EV3에서 벗어남)를 누가 언제 왜 옮겼는지 — 27-B·27-C 모두 자기 접촉이 아님을 로그로 확인했으나 행위자는 미확정. **리더/마스터 판단 대기.**
- 육면체·`slot3d_front_center`의 DB 오염 여부는 코드상 판단만 있고 실행 미확인(정본·DB 무접촉 원칙).
- 프레임 종속 요동의 내부 메커니즘(어느 단계에서 quad 수가 갈리는지)은 미측정 — 28회차 표적.
