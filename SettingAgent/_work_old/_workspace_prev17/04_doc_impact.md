# 04 · 영향도 분석 — 정밀수집 3기능(프리셋 리스트 CRUD / 박스 편집 / 자동보정)

- 작성: 2026-07-13 01:10 (documenter)
- 상세 문서: `SettingAgent/docs/20260713_011021_정밀수집_프리셋리스트_박스편집_자동보정.md`
- 결론: **전부 가산·하위호환. 회귀 0(전체 1304 테스트 통과, tsc 통과).** 신규 외부 의존성 0.

---

## 1. 변경 파일별 영향

| 파일 | 변경 | 파급 |
|------|------|------|
| `web/core.js` | 순수 6종 가산(파일 말미) | 기존 export/서명 불변. vitest 직접 import → 회귀 없음 |
| `web/core.d.ts` | 위 6종 타입 선언 가산 | core.js와 1:1. 타입만 |
| `web/app.js` | import·state 3필드·함수 그룹·오버레이 분기·버튼/단축키 결선 | `wireOverlayEditing` mousedown 상단에 ②분기 추가(가드 이전). `drawDetectOverlay`/`drawRoiOverlay` 렌더 경로에 선택 하이라이트 가산. `savePreset`에 선택 인자 추가(제어패널 호출부 무영향) |
| `web/index.html` | `#cpreset-box`·`#align-box` 섹션 + `#det-delete` 버튼 | ID 접두사로 기존 `preset-*` 등과 격리 |
| `src/capture/frameAlign.ts` | **신규**(순수 수학) | 신규 모듈. captureRoutes만 import |
| `src/capture/placeRoi.ts` | `applyPlaceRoiUpdate` 가산 | 기존 `normalizePtzCamRoi`/`loadNormalizedPlaceRoi` 불변. 왕복(정규화↔픽셀) 정합 vitest 검증 |
| `src/api/captureRoutes.ts` | 라우트 3종 + `refFrameDir` dep + zod + `jpegToGray`(sharp) | camera/refFrameDir/placeRoiFile 주입 시에만 등록(런타임 게이트) |
| `src/api/server.ts` | `ApiDeps.refFrameDir?` 필드 + captureRoutes 전달 | 1필드 가산, 옵셔널 |
| `src/index.ts` | `refFrameDir: join(dataDir,'refframes')` 배선 | 1줄 |

---

## 2. 신규 라우트 3종 — 가산·하위호환

- POST `/capture/refframe`, POST `/capture/autocorrect` : **camera + refFrameDir 동시 주입 시에만** 등록. 미주입이면 미등록 → 기존 동작 회귀 0.
- PUT `/capture/place-roi` : `placeRoiFile` 런타임 게이트(GET place-roi와 대칭). 정규화 spaces → 픽셀 역변환 저장.
- 셋 다 zod 검증. **무토큰**(`/capture/*` 관례). place-roi PUT은 파일 정본을 변형하므로 아래 리스크 참조.

---

## 3. 공유 도메인·데이터 정본 파급

- **`PtzCamRoi.json`이 자동보정 저장 정본(픽셀 좌표)**. PUT place-roi가 이 파일을 직접 변형 → GET place-roi·`normalizePtzCamRoi` 소비처 **전체 반영**:
  - 프론트 `state.placeRoi`(정규화 byPreset) → `drawFileFloorRoi`·`updateLogicOccupancy`(점유 판정) → 보정 후 점유 판정·바닥 오버레이도 함께 이동(의도된 동작).
  - 백엔드 `loadNormalizedPlaceRoi`/Finalizer 조립 경로도 파일 재로드 시 반영.
- **`camerapos.json`**: ①이 PUT로 갱신 → `CameraposSource`(fresh read) 재조회 시 뷰어 드롭다운 반영(4초 폴). 제어패널 프리셋 UI와 **동일 파일 공유**(공유 함수화로 일관).
- **`state.detectByKey`**: ②가 메모리 변형. `runLiveDetect`/`capFrameTick`가 프리셋 재검출 시 덮음(임시 특성, 저장 경로 없음).
- **정밀수집 폴(`capPoll`/`capFrameTick`)**: 로직 불변(가산만). ② 편집분이 프레임 순환에 덮이는 것은 이 폴과의 정합.

---

## 4. 의존성

- **sharp `^0.35.3` 이미 존재** → 신규 설치 0. `jpegToGray`가 greyscale+resize+raw로 픽셀 추출만.
- CV 라이브러리 도입 없음(상호상관·스케일·아핀 전부 순수 함수).
- `frameAlign.ts` → captureRoutes만 import. 순환 의존 없음.

---

## 5. 리스크 / 확인 필요

- **자동보정 신뢰도**: 이동+스케일만(회전·원근 미보정). 특징 부족·큰 변화 시 peak 낮음 → 오정합 가능. UI에 peak 표기·되돌리기 제공으로 완화하나 **최종 저장 전 사용자 검토 필수**.
- **② 박스 편집 비영속**: 메모리만, 프레임 순환 시 소멸. 영속 저장이 필요하면 별도 설계(후속).
- **place-roi PUT 무토큰**: 파일 정본 변형인데 인증 없음. 로컬 단독은 무방하나 **네트워크 노출 환경이면 controlToken 게이트 검토 필요**(현재 `/capture/*` 관례 준수).
- **camerapos '열기'**: 정규화 views 형식만 파싱(Unity 원본 중첩 `datas` 미지원). 서버 미존재 프리셋 행 선택 시 서버 첫 프리셋으로 폴백(저장 후 정합).

---

## 6. 후속 제안

- **회전/원근 보정**: 특징점 기반(jsfeat 등) 호모그래피 추정으로 확장.
- **박스 편집 영속화**: `state.detectByKey` 편집분을 DB/파일에 저장.
- **자동보정 결과 DB 기록**: dx/dy/scale/peak를 관측 이력으로 저장(신뢰도 추적).
- **place-roi PUT 게이트**: 네트워크 노출 시 controlToken 옵션.
