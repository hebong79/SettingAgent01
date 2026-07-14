# SettingAgent 초기 셋팅 방법 가이드

> 이 문서는 **계속 참조용 고정 문서**입니다(날짜 접두사 없음). 마지막 갱신: 2026-07-13.
> 대상: 처음 셋팅하는 운영자. 실제 웹 화면 용어(탭·버튼)는 `web/index.html` 기준.

---

## 0. 개념 3줄 요약

1. **시뮬레이터/리얼 카메라 = 순수 카메라**입니다. 위치는 고정이고, 할 줄 아는 것은 "연결·현재 PTZ 알려주기·PTZ로 움직이기·영상 주기"뿐입니다.
2. **셋팅에이전트가 "카메라가 어디를 볼지"(= 카메라 PTZ 프리셋)를 정해 `camerapos.json`에 저장**합니다. 웹에서 만들고/고치고/지웁니다.
3. 그 다음 **각 프리셋 화면에서 주차면 ROI를 확보**하고, 필요하면 번호판 센터라이징으로 주차면별 정밀 PTZ(P4)를 얻어 **최종 셋업 파일**로 저장합니다.

> ⚠ 헷갈리기 쉬운 점: 여기서 말하는 "프리셋"은 **카메라 PTZ 프리셋(camerapos.json)** 입니다. Unity RPC의 `preset.*`(주차면/3D 씬 프리셋)과는 **완전히 다른 것**입니다. 뷰어 드롭다운의 프리셋 = camerapos.json 소유입니다(2026-07-12 전환).

---

## 1. 사전 준비

| 구성요소 | 포트 | 실행 방법 |
|---|---|---|
| Unity 시뮬레이터(카메라 RPC) | 13110 | Unity 에디터/빌드 실행 |
| SettingAgent 서버 | 13020 | `SettingAgent/`에서 `npm run dev` |
| 브라우저 뷰어 | — | `http://localhost:13020/viewer/` 접속 |

접속 후 상단 오른쪽 뱃지 확인:
- `backend` = SettingAgent 서버 연결.
- `camera` = Unity(13110) 연결(4초마다 `cam.list`로 확인). 꺼져 있으면 Unity 시뮬레이터를 먼저 켜세요.

---

## 2. 설정 파일 위치 · 의미

| 파일 | 핵심 항목 | 의미 |
|---|---|---|
| `config/tools.config.json` | `camera.baseUrl` = `http://localhost:13110` | 카메라(Unity RPC) 주소 |
| | `presetProvider.type` = `camerapos` | 뷰어 프리셋을 **파일(camerapos.json) 소유**로 사용(웹 편집 보존) |
| | `presetProvider.refreshOnRun` = `false` | 셋업 실행 시 camerapos.json 자동 덮어쓰기 **안 함**(수동 편집 보존) |
| | `map.cameraposFile` = `config/camerapos.json` | 카메라 PTZ 프리셋 파일 경로 |
| | `cameraMode` = `simulator` \| `real` | **카메라 모드 선택**(디폴트 `simulator`). 뷰어 라이브 소스를 시뮬(Unity RPC 13110)/리얼(Hucoms) 중 선택. 변경 시 **서버 재시작** 필요. `real` 은 `realCamera`(접속정보) 함께 설정해야 하며, 없으면 기동 실패(fail-fast). ⚠ 정밀수집/검출은 이 값과 무관하게 항상 Unity RPC(13110) 사용 → 실기 정밀수집은 미지원(후속) |
| | `viewer.controlToken` | 비어 있으면 편집 API 무인증. 네트워크 노출 시 값 설정 권장 |
| `config/camerapos.json` | `cam_id / preset_id / sname / pan / tilt / zoom` | **카메라 PTZ 프리셋**(어디를 볼지). 웹에서 편집 |
| `config/llm.config.json` | `models[]` + `activeModel` | LLM(두뇌) 프로필. 런타임 전환 가능 |

`camerapos.json` 예시(현재 파일 형태):
```json
{
  "datas": [
    { "cam_id": 1, "datas": [
      { "cam_id": 1, "preset_id": 1, "sname": "Preset 1", "pan": 22,   "tilt": 6.8,  "zoom": 1.6 },
      { "cam_id": 1, "preset_id": 2, "sname": "Preset 2", "pan": 56.6, "tilt": 7.4,  "zoom": 1.9 },
      { "cam_id": 1, "preset_id": 3, "sname": "Preset 3", "pan": 43.5, "tilt": 18.8, "zoom": 1.4 }
    ]}
  ]
}
```

> 부트스트랩(파일이 비어 있을 때): 웹에서 "새 프리셋"으로 직접 만들면 됩니다. 자동 생성을 원하면 `presetProvider.type`을 잠시 `unity-api`로 두고 1회 실행해 camerapos.json을 생성한 뒤 다시 `camerapos`로 되돌립니다.

---

## 3. 초기 셋팅 단계 (웹에서)

뷰어 상단 탭: **제어·모니터링 / 주차면 검수 / 정밀 수집 / 분석 / 옵션 / DB**.
아래 ①~④는 "제어·모니터링" 탭에서 합니다.

**① 소스·카메라 선택**
- 우측 "대상 선택" 섹션에서 **소스**(`sel-source`) = `rpc` 선택, **카메라**(`sel-cam`) 선택.
- 아래 **시작** 버튼으로 라이브 영상을 켭니다.

**② PTZ로 원하는 화면 맞추기**
- "PTZ 제어" 섹션의 방향 패드(▲◄►▼)·`+ zoom / − zoom`(step 조절)으로 조정하거나,
- "절대 이동"에 pan/tilt/zoom 숫자를 넣고 **이동** 버튼.
- 상단 "현재 PTZ"(P/T/Z)가 명령 기준으로 갱신됩니다. 이 값이 프리셋 저장의 원천입니다.

**③ 현재 PTZ를 새 프리셋으로 저장**
- "대상 선택" 아래 프리셋 편집에서 **프리셋 이름**(`preset-label`) 입력 → **새 프리셋**(`preset-new`) 버튼.
- 현재 PTZ가 새 preset_id로 `camerapos.json`에 기록되고, 드롭다운에 즉시 추가·선택됩니다.

**④ 프리셋 반복 생성·수정·삭제**
- 수정: 프리셋 선택 → PTZ 재조정 → **프리셋 저장**(`preset-save`, 선택 프리셋을 현재 PTZ로 갱신).
- 삭제: 프리셋 선택 → **삭제**(`preset-delete`).
- 저장 후 드롭다운에 즉시 반영됩니다(저장 경로가 강제 재렌더). 다른 프리셋로 이동하려면 프리셋 선택 후 **이동**(`btn-goto`) 버튼 → 카메라가 물리적으로 그 PTZ로 이동.

**⑤ 프리셋별 주차면 ROI 확보 · 정밀 수집**
- 각 프리셋 화면에서 주차면 ROI를 확보합니다(파일 제공 ROI 또는 검출).
- "주차면 검수" 탭에서 목록·선택·추가(전역 인덱스 중간삽입)·삭제·저장.
- "정밀 수집" 탭에서 반복 관측(반복 횟수·주기·체크포인트) → **시작/정지/최종화**. 필요 시 "검출 실행"으로 현재 프리셋 1회 VPD/LPD 검출.

**⑤-a 정밀 수집 탭 · 프리셋 리스트 관리**(제어패널 프리셋 편집과 동일 파일 `camerapos.json` 공유)
- 정밀 수집 탭의 프리셋 리스트(`#cpreset-list`)에서 행을 클릭하면 카메라가 그 프리셋으로 **물리 이동**하고 라이브 스트림이 재연결됩니다.
- 이름(`#cpreset-name`) 입력 후 **추가**(`#cpreset-add`, 현재 PTZ를 새 프리셋으로)·**수정**(`#cpreset-update`, 선택 프리셋을 현재 PTZ로)·**삭제**(`#cpreset-delete`)는 즉시 파일에 반영됩니다.
- **열기**(`#cpreset-open`)는 로컬 JSON을 **메모리에 표시만** 하고, **저장**(`#cpreset-save`)을 눌러야 서버 파일(`camerapos.json`)에 확정됩니다(실수 저장 방지). 열기 대상은 정규화 views 형식만 지원(Unity 원본 `datas` 포맷 아님).

**⑤-b 검출 박스 임시 편집**(화면 표시용, 저장 안 됨)
- "검출 실행"으로 VPD/LPD 박스가 오버레이에 뜬 상태에서, `roi-detect` 토글이 켜져 있으면 박스를 **클릭 선택**할 수 있습니다(Ctrl 없이 클릭 — Ctrl+드래그는 슬롯편집이라 배타).
- 차량 박스는 8핸들로 크기조절/이동, 번호판 박스는 정점 드래그. **삭제**는 `#det-delete` 버튼 또는 **Delete/Backspace**, **Esc**로 선택 해제.
- ⚠ 이 편집은 **임시(메모리)** 입니다. 저장 경로가 없어, 다음 검출/프레임 순환 시 사라집니다. 단일 프리셋 정지 상태에서만 유의미합니다.

**⑤-c 카메라가 틀어졌을 때 · 주차면 자동보정**(이동+스케일)
- 카메라가 미세하게 틀어져 기존 주차면 ROI가 화면과 어긋날 때 사용합니다.
- 순서: (1) 정상 상태에서 **기준 저장**(`#align-save-ref`, `data/refframes/cam{c}_p{p}.jpg`에 기준 프레임 저장) → (2) 틀어진 뒤 **자동보정**(`#align-run`, 기준↔현재 상호상관으로 dx/dy/스케일 추정 → 오버레이 폴리곤 이동) → (3) `#align-msg`의 **peak(신뢰도)** 확인·검토, 틀리면 **되돌리기**(`#align-undo`) → (4) 만족하면 **저장**(`#align-apply`, `PtzCamRoi.json`에 반영).
- ⚠ **이동+스케일만 보정합니다(회전·원근 미보정)**. peak가 낮으면(특징 부족·큰 변화) 신뢰하지 말고 되돌리세요.

**⑥ (선택) 번호판 센터라이징으로 주차면별 P4 PTZ**
- "정밀 수집" 탭 하단 "PTZ 캘리브레이션" — 번호판 OBB 중심 정렬·zoom 20% 수렴으로 주차면별 정밀 PTZ를 얻어 `slot_ptz.json`에 저장.

**⑦ 최종 셋업 파일 저장**
- 편집 내용을 산출물에 저장(**저장** `map-save`) → `setup_artifact.json`.
- 필요 시 **결과 저장**(`result-save`)으로 로컬 JSON 파일로 내보내기.

---

## 4. 각 단계가 무엇을 · 어디에 저장하는가

| 산출물 | 저장 위치 | 만드는 곳 |
|---|---|---|
| 카메라 PTZ 프리셋(어디를 볼지) | `config/camerapos.json` | 제어·모니터링 탭 프리셋 편집(③④) → `PUT /viewer/api/camerapos` |
| 주차면 ROI | DB `parking_slots`(관측 최종화) | 주차면 검수 / 정밀 수집 탭(⑤) |
| 주차면별 정밀 PTZ(P4) | `data/slot_ptz.json` | 정밀 수집 탭 PTZ 캘리브레이션(⑥) |
| 최종 셋업 | `data/setup_artifact.json`(+DB 스냅샷) | 저장 버튼(⑦) |

---

## 5. 자주 겪는 점

- **config 변경은 서버 재시작 필요.** `nodemon`은 `src`만 감시합니다 — `config/*.json`(tools/llm)이나 `presetProvider.type` 변경은 SettingAgent를 재시작해야 반영됩니다.
- **정적 자산은 새로고침이면 충분.** `web/*.js`,`index.html`,`app.css`는 서버가 `no-store`로 서빙 → 브라우저 새로고침이면 최신이 로드됩니다(하드 리로드 불필요).
- **camerapos.json 편집은 즉시 반영.** 파일을 매 호출 새로 읽으므로(fresh read) 웹 저장·직접 편집 모두 4초 이내(연결 폴)에 드롭다운에 반영됩니다.
- **Unity 재컴파일이 필요한 경우.** 카메라 쪽 C# 코드를 바꿨다면 Unity에서 재컴파일/재실행이 필요합니다(TypeScript 서버 재시작과 별개).
- **`camera` 뱃지가 꺼진다.** Unity(13110) 연결 실패입니다. camerapos.json 프리셋 목록은 파일 기준이라 유지되지만, 실제 이동/영상은 Unity 연결이 있어야 동작합니다.
- **PUT 무인증 주의.** `viewer.controlToken`이 비어 있으면 프리셋 저장 API에 인증이 없습니다. 로컬 단독 사용이면 무방하나, 네트워크 노출 환경이면 controlToken을 설정하세요.

---

## 6. LLM 모델 전환

- **런타임 전환(재시작 불필요):** "옵션" 탭 → "LLM (두뇌)" → **활성 모델** 드롭다운(`opt-llm-active`)에서 선택. 내부적으로 `POST /viewer/api/llm/select {id}`를 호출해 메모리에서 즉시 스왑됩니다(재시작 시 config `activeModel`로 복귀).
- **모델 프로필 추가/편집:** `config/llm.config.json`의 `models[]`에서 `enabled`(true/false)·`apiKeyEnv`(환경변수 이름)·`baseUrl`·`model`을 설정. API 키는 **서버 env로만** 주입되며 UI에 표시/편집하지 않습니다.
- `activeModel`이 서버 시작 시 기본 활성 프로필입니다. 현재 기본은 `qwen-vl`(로컬 vLLM, Qwen2.5-VL-32B — 비전 작업에 멀티모달 필수).
