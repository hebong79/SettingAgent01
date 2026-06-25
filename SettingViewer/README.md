# SettingViewer

ParkAgent **카메라 영상·PTZ 제어·주차면 ROI 검수** 웹 뷰어. SettingAgent에서 분리된 **독립 서비스**(자체 Node/Fastify 서버, 포트 `13030`)다.

> 브라우저는 SettingViewer(:13030)**만** 호출한다. 카메라(시뮬레이터/실 PTZ)와 SettingAgent의 셋업 산출물(`/mapping`)은 **서버측에서 프록시**하므로 CORS 없이 단일 출처로 동작한다.

---

## 무엇을 하나

- **카메라별 프리셋** 목록 표시·선택·이동
- **실시간 영상**(스냅샷 폴링 ≈3fps, 시작/정지·fps 조절)
- **PTZ 제어**(방향·스텝·zoom·절대 이동) — `allowMove=false`면 조회 전용
- **주차면 ROI 오버레이** — SettingAgent `/mapping`의 차량/번호판 ROI를 영상 위에 표시
- **소스 추상화** — 시뮬레이터(Unity) + 실 PTZ(Hucoms CGI, 자격증명은 UI 입력→프록시 통과)

---

## 아키텍처

```
Browser ──HTTP──► SettingViewer (:13030, Fastify)
                     ├ GET  /viewer/             정적 SPA(web/)
                     ├ GET  /viewer/api/cameras       ─┐
                     ├ GET  /viewer/api/snapshot       │→ 카메라 소스(Unity :13100 / Hucoms)
                     ├ POST /viewer/api/move           │
                     ├ POST /viewer/api/camera/login  ─┘
                     ├ GET  /viewer/api/health
                     └ GET  /viewer/api/mapping  ──프록시──► SettingAgent (:13020) /mapping
```

---

## 사전 준비

- **Node.js 20+**
- **SettingAgent**(:13020) 기동 — ROI 검수용 `/mapping` 제공. (영상·제어만 쓸 거면 없어도 동작하나 ROI는 비표시)
- **카메라 서버** — 시뮬레이터(Unity, :13100) 또는 실 PTZ(Hucoms)

---

## 빠른 시작

```bash
# 0) 의존성 설치 (워크스페이스 루트에서 1회)
cd d:/Work/Parking3D/AgentVLA/ParkAgent && npm install

# 1) SettingAgent 먼저 (/mapping 제공)
cd SettingAgent && npm run start        # :13020

# 2) SettingViewer 기동
cd ../SettingViewer && npm run start     # :13030
```

브라우저에서 **http://localhost:13030/viewer/** 접속.

> 기동 순서: SettingAgent → SettingViewer. (SettingViewer가 `/mapping`을 프록시하므로 SettingAgent가 먼저 떠 있어야 ROI가 보인다.)

---

## npm 스크립트

```bash
npm run start       # 서버 기동(:13030)
npm run dev         # 변경 감시 기동(tsx watch)
npm run typecheck   # 타입 검사
npm test            # 유닛테스트(vitest, 외부 서버 불필요)
```

---

## 설정 (`config/viewer.config.json`)

| 키 | 의미 | 기본값 |
|----|------|--------|
| `camera.baseUrl` | 시뮬레이터(Unity) 카메라 서버 주소 | `http://localhost:13100` |
| `camera.zoomMin`/`zoomMax` | zoom 클램프 범위 | `1.0` / `36.0` |
| `viewer.enabled` | 뷰어 라우트·정적 서빙 노출 | `true` |
| `viewer.allowMove` | `false`면 `POST /viewer/api/move` → **403**(조회 전용) | `true` |
| `viewer.defaultFps` | 기본 스트림 fps | `3` |
| `viewer.staticDir` | SPA 자산 폴더 | `web` |
| `viewer.controlToken` | 설정 시 move 요청에 `X-Viewer-Token` 일치 요구(빈 값=미사용) | `""` |
| `settingAgentUrl` | `/mapping` 프록시 대상(SettingAgent) | `http://localhost:13020` |
| `server.port` | SettingViewer 포트 | `13030` |
| `cameraSources[]` | 다중/실 카메라 소스 목록(옵셔널). 미설정 시 `camera` 단일 sim 소스로 폴백 | — |

> 다른 PC로 옮기면 **호스트만** 바꾸면 된다(코드 수정 불필요).

### 실 PTZ(Hucoms) 소스 예시

```jsonc
"cameraSources": [
  { "id": "sim", "kind": "sim", "baseUrl": "http://localhost:13100" },
  { "id": "cam1", "kind": "hucoms", "host": "192.168.0.153", "port": 80,
    "loginPath": "/cgi-bin/login.cgi",
    "snapshotUrl": "http://192.168.0.153/cgi-bin/snapshot.cgi",
    "ptz": { "panRange": [0, 36000], "tiltRange": [0, 9000], "zoomRange": [1, 36] } }
]
```

- **자격증명(아이디/비밀번호)은 config에 두지 않는다.** 뷰어 UI에서 입력 → 프록시가 세션 동안만 보유(저장·로그·응답 노출 안 함).
- Hucoms CGI 경로/원시 PTZ 범위는 **가정값**이므로 실기기(192.168.0.153) 연결 후 보정이 필요하다.

---

## REST API (:13030)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/viewer/api/cameras` | 카메라·프리셋 목록(`?source=`) |
| GET | `/viewer/api/snapshot` | 스냅샷 JPEG(`cam`,`preset`,`mode=preset\|manual`,`pan/tilt/zoom`). 응답 헤더 `X-PTZ-*` |
| POST | `/viewer/api/move` | PTZ 절대 이동(`{cam,pan,tilt,zoom}`). `allowMove=false`→403 |
| POST | `/viewer/api/camera/login` | 실카메라 로그인(`{source,user,pass}`) — 자격증명 통과·미저장 |
| GET | `/viewer/api/health` | 상태·소스 목록 |
| GET | `/viewer/api/mapping` | SettingAgent `/mapping` 프록시(ROI 산출물) |
| GET/POST | `/viewer/api/capture/*` | SettingAgent `/capture/*` 프록시(정밀 수집: 반복 관측→SQLite 누적→정밀 ROI). "정밀 수집" 탭에서 사용 |

> 명명 규약: 프런트 URL은 `cam`/`preset`, 서버 내부 `camIdx`/`presetIdx`, 카메라 API는 `cam_idx`/`preset_idx`.

---

## 폴더 구조

```
SettingViewer/
├ src/
│  ├ index.ts            # 부트스트랩(설정 로드 → 서버 기동)
│  ├ server.ts           # Fastify 조립 + /mapping 프록시
│  ├ config/viewerConfig.ts
│  ├ clients/CameraClient.ts   # 카메라 REST(독립 복제)
│  ├ util/http.ts              # fetchWithTimeout(독립 복제)
│  └ viewer/             # CameraSource·SimulatorSource·RealPtzSource·sourceRegistry·routes
├ web/                   # 바닐라 SPA(index.html, app.js, core.js, app.css)
├ config/viewer.config.json
├ test/                  # vitest
└ doc/                   # 설계·구현·영향도 문서
```

---

## 문서 (`doc/`)

- 설계서: `20260625_170811_SettingViewer_웹뷰어_설계서.md`
- 구현문서: `20260625_182819_SettingViewer_구현문서.md`
- 영향도분석: `20260625_182819_SettingViewer_영향도분석.md`
- 독립 분리: `20260625_195152_SettingViewer_독립서비스_분리.md`

---

## 알아둘 점

- **두 서비스 구성**: SettingViewer(:13030) + SettingAgent(:13020). 기동 순서 주의.
- **중복 코드**: `CameraClient`·`http util`은 독립성을 위해 SettingAgent와 별도 복제본을 둔다(변경 시 수동 동기화).
- **미검증(장비/실서버 필요)**: 실 PTZ(Hucoms) 실연동, Unity 실서버 영상, 브라우저 DOM 동작은 단위테스트 범위 밖 — 연결 시 수동 확인.
