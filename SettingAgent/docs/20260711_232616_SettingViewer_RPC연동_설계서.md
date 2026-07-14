# SettingViewer(13020) RPC 연동 설계서

> 작성일: 2026-07-11
> 대상: `AgentVLA/ParkAgent/SettingAgent`(포트 13020, Fastify) — 웹 뷰어(`/viewer/*`)
> 목적: 현재 카메라 스트리밍(`/stream`)만 연결된 웹 클라이언트에, Unity(포트 13110) JSON-RPC(현재 76개 method: preset.*/car.*/cam.*/map.*/measure.*/scene.*/system.*)를 통신 가능하게 만든다.
> 범위: 설계만 다룬다(코드 변경 없음). **브라우저 직접 방식**과 **13020 서버 경유(프록시) 방식** 둘 다 설계한다.

---

## 0. 요약 (TL;DR)

- 현재 `SettingViewer`(`/viewer/*`, 13020)는 `CameraSource` 추상화(`sim`/`hucoms`)를 통해 **Unity 13100(REST 카메라 전용)에만** 연결되어 있다. `preset.*`/`car.*`/`cam.setPan` 같은 **RPC(13110)는 뷰어와 전혀 연결되어 있지 않다.**
- 이미 저장소 안에 재사용 가능한 자산이 있다: `src/clients/CRpcClient.ts`(범용 JSON-RPC 클라이언트, 현재 `mcp/server.ts`만 사용), `/viewer/api/move`가 쓰는 `controlToken` 인증 패턴.
- **방식 A(브라우저 직접)**: 프론트가 Unity 13110 `/rpc`에 직접 fetch. 추가 서버 코드 거의 불필요, 지연시간 최소. 대신 인증·중앙 통제가 약함.
- **방식 B(13020 서버 경유)**: `/viewer/api/rpc` 신규 라우트를 추가해 `CRpcClient`를 재사용, 기존 `controlToken` 게이트로 통제. 단일 오리진, 중앙 로깅/화이트리스트 가능.
- 두 방식은 배타적이지 않다 — **결정론적 UI 컨트롤은 B, 저지연이 중요한 조작은 A**로 병행 가능(§6).
- 자연어 채팅(LLM이 RPC를 골라 호출)은 이번 설계 범위 밖이며, `llmConfig.ts`에 이미 있는 **미사용 `mcp` 설정 스캐폴딩**(§1.3)을 실제로 소비하는 후속 작업이다.

---

## 1. 현황 (As-Is)

### 1.1 SettingViewer 라우트 인벤토리 (`src/viewer/routes.ts`)

| 라우트 | 메서드 | 백엔드 연결 |
|---|---|---|
| `/viewer/api/cameras` | GET | `CameraSource.listCameras()` |
| `/viewer/api/snapshot` | GET | `CameraSource.snapshot()` |
| `/viewer/api/stream` | GET | `CameraSource.streamMjpeg()` (MJPEG 프록시, `sim` 소스는 Unity 13100 `/stream` 이식) |
| `/viewer/api/move` | POST | `CameraSource.move()` — **이미 `controlToken` 인증 있음**(`x-viewer-token` 헤더, `viewer.allowMove` 게이트) |
| `/viewer/api/camera/login` | POST | `CameraSource.login()`(실 PTZ 전용, sim 미구현) |
| `/viewer/api/health` | GET | 소스 목록만 |

→ **`CameraSource` 인터페이스(`src/viewer/CameraSource.ts`) 자체가 카메라 PTZ+스트리밍만 다루도록 설계되어 있다.** `preset.*`/`car.*`/`map.*` 등 나머지 73개 RPC는 이 추상화의 범위 밖 — 뷰어에 새 계층이 필요하다.

### 1.2 이미 존재하는 재사용 자산

| 자산 | 위치 | 현재 사용처 |
|---|---|---|
| 범용 JSON-RPC 클라이언트 | `src/clients/CRpcClient.ts` `callRpc(method, params)` / `getCatalog()` | `src/mcp/server.ts`(MCP 도구 `unity_rpc`/`unity_rpc_catalog`)에서만 사용 |
| RPC 서버 주소 설정 | `toolsConfig.ts` `unityRpc: { baseUrl: 'http://localhost:13110', timeoutMs }` | MCP 서버만 로드 |
| 뷰어 인증 패턴 | `routes.ts` `viewer.controlToken` + `x-viewer-token` 헤더 검사(`/viewer/api/move`) | `/move`에만 적용, 다른 라우트엔 없음 |
| MCP 클라이언트 연결 설정(**미사용 스캐폴딩**) | `llmConfig.ts` `mcp: { enabled:true, transport:'stdio', servers:[{name, command:'node', args:['dist/mcp/server.js']}] }` | 선언만 되어 있고, 실제 `@modelcontextprotocol/sdk/client` 연결 코드는 저장소 어디에도 없음(grep 확인) |

### 1.3 프로세스 경계

`SettingAgent`에는 이미 **서로 다른 두 진입점**이 있다(`package.json`):

| 진입점 | 프로세스 | 포트/전송 |
|---|---|---|
| `src/index.ts`(`npm run dev`/`start`) | 메인 Fastify 서버 — 지금 뷰어를 서빙 중 | HTTP 13020 |
| `src/mcp/server.ts`(`npm run mcp`) | MCP 서버 — `StdioServerTransport` | stdio(자식 프로세스 전용, 네트워크 불가) |

→ 브라우저는 stdio MCP 서버에 **원천적으로 접근 불가**. 뷰어에 RPC를 연결하려면 (a) 브라우저가 13110에 직접 붙거나 (b) 13020(메인 Fastify)이 중개해야 한다 — MCP stdio 프로세스를 거치는 경로는 여기서 성립하지 않는다.

---

## 2. 목표 (Goal)

`SettingViewer`(13020) 웹 클라이언트가 Unity 13110의 76개 RPC method를 호출할 수 있어야 한다. 성공 기준:

- [ ] 방식 A: 프론트 JS가 13110 `/rpc`에 직접 POST하여 임의 RPC(예: `cam.setPan`) 호출 성공
- [ ] 방식 B: `/viewer/api/rpc`(13020, 신규)로 동일 RPC 호출 성공, `controlToken` 미검증 시 403
- [ ] 두 방식 모두 `unity_rpc_catalog`/`GET /rpc/catalog` 결과와 method 목록이 일치(신규 RPC 추가 시 프론트 코드 변경 불필요)

---

## 3. 방식 A — 브라우저 직접 (Direct)

### 3.1 구조

```
브라우저(viewer SPA, web/*)
  └─ fetch('http://localhost:13110/rpc', { method:'POST',
       body: JSON.stringify({ jsonrpc:'2.0', id, method, params }) })
       └─ Unity CRpcServer(13110) — CORS 이미 열림(Access-Control-Allow-Origin:*)
```

### 3.2 구현 포인트

- `web/` 정적 SPA에 `unityRpc.baseUrl`(예: `http://localhost:13110`)을 상수 또는 서버가 내려주는 설정값으로 주입.
- `webviewer.html`(Unity 측, `Assets/Scripts/99_Network/NetworkRpc/webviewer.html:72-87`)의 `callRpc(method, params)` 패턴을 그대로 이식:
  ```js
  async function callRpc(method, params) {
    const res = await fetch(`${UNITY_RPC_BASE}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    return res.json();
  }
  ```
- 신규 서버(13020) 코드 **불필요**(순수 프론트엔드 추가).

### 3.3 장단점

| 장점 | 단점 |
|---|---|
| 지연시간 최소(1홉) | Unity RPC 자체에 인증이 없음 → 같은 네트워크의 누구나 브라우저 콘솔에서 `car.deleteAll` 같은 파괴적 호출 가능 |
| 서버 코드 변경 없음, 구현 간단 | 13020의 `controlToken`/로깅/레이트리밋 체계를 못 씀(별도 체계 필요) |
| `webviewer.html`에 이미 실증된 패턴 재사용 | 프론트가 13020(뷰어)과 13110(RPC) **두 오리진**을 알아야 함(CORS·방화벽 설정이 두 곳) |
| SettingAgent 프로세스 장애와 무관하게 동작 | Unity 13110의 bind address를 외부에 노출해야 함(`localhost`가 아닌 LAN IP로 열어야 브라우저가 붙을 수 있는 배포 환경이면 노출 범위 확대) |

---

## 4. 방식 B — 13020 서버 경유 (Proxy)

### 4.1 구조

```
브라우저(viewer SPA)
  └─ fetch('/viewer/api/rpc', { method:'POST', headers:{'x-viewer-token':...},
       body: JSON.stringify({ method, params }) })   ← 같은 오리진(13020)
       └─ SettingAgent(Fastify, src/viewer/routes.ts) 신규 핸들러
            └─ CRpcClient.callRpc(method, params)     ← MCP 서버와 동일 클래스 재사용
                 └─ Unity 13110 /rpc
```

### 4.2 구현 포인트

1. **`src/viewer/routes.ts`에 라우트 추가**:
   ```ts
   const RpcBody = z.object({
     method: z.string().min(1),
     params: z.record(z.unknown()).optional(),
   });

   app.post('/viewer/api/rpc', async (req, reply) => {
     if (viewer.controlToken && req.headers['x-viewer-token'] !== viewer.controlToken) {
       reply.code(403);
       return { error: 'invalid token' };
     }
     const parsed = RpcBody.safeParse(req.body);
     if (!parsed.success) {
       reply.code(400);
       return { error: 'invalid body', detail: parsed.error.flatten() };
     }
     try {
       const result = await rpc.callRpc(parsed.data.method, parsed.data.params);
       return { ok: true, result };
     } catch (err) {
       reply.code(502);
       return { ok: false, error: err instanceof Error ? err.message : String(err) };
     }
   });

   app.get('/viewer/api/rpc/catalog', async (_req, reply) => {
     try {
       return await rpc.getCatalog();
     } catch (err) {
       reply.code(502);
       return { error: err instanceof Error ? err.message : String(err) };
     }
   });
   ```
   `rpc: CRpcClient` 인스턴스는 `ViewerDeps`에 추가 필드로 주입(`src/api/server.ts:275` `registerViewerRoutes(instance, { sources, viewer, rpc })`), `src/index.ts`에서 `new CRpcClient(tools.unityRpc)`로 생성해 전달(MCP 서버가 만드는 것과 동일한 생성 방식).

2. **인증**: 기존 `/viewer/api/move`가 쓰는 `viewer.controlToken` 게이트를 그대로 재사용 — 신규 인증 체계를 만들 필요 없음.

3. **(선택) RPC 화이트리스트**: `toolsConfig.ts`의 `viewer` 설정에 `rpcAllowlist?: string[]` 같은 필드를 추가해, 브라우저에 노출할 method를 제한할지 검토(§8).

### 4.3 장단점

| 장점 | 단점 |
|---|---|
| 같은 오리진(13020)만 알면 됨 — 프론트가 Unity 주소를 몰라도 됨 | 홉 하나 추가(브라우저→13020→13110), 지연시간 소폭 증가 |
| 기존 `controlToken` 인증·로깅 체계를 그대로 재사용 | `src/viewer/routes.ts`/`server.ts`/`index.ts` 3개 파일 수정 필요(방식 A보다 구현량 많음) |
| Unity 13110을 외부에 직접 노출하지 않아도 됨(13020만 공개, 13110은 내부망 유지 가능) | SettingAgent(13020) 프로세스가 죽으면 RPC 제어도 함께 끊김 |
| 화이트리스트·요청 검증·감사로그를 중앙에서 추가하기 쉬움 | — |
| 자연어 채팅(§5) 확장의 자연스러운 기반이 됨(같은 프록시 위에 LLM tool-calling만 얹으면 됨) | — |

---

## 5. 자연어(채팅) 확장은 범위 밖 — 후속 작업 메모

이번 설계는 "결정론적 RPC 호출"(A/B 방식 모두)까지다. "채팅창에 문장을 치면 LLM이 알아서 RPC를 고른다"는 이전 대화에서 논의한 대로 별도 계층(채팅 백엔드 + tool-calling LLM + MCP 브리지)이 필요하며, 이번 문서 범위가 아니다.

다만 `llmConfig.ts`에 이미 **미사용 스캐폴딩**이 있다는 점은 기록해둔다:
```ts
mcp: { enabled: true, transport: 'stdio', servers: [
  { name: 'parkagent-setting-tools', transport: 'stdio', command: 'node', args: ['dist/mcp/server.js'] },
] }
```
이 설정을 실제로 소비하는 `@modelcontextprotocol/sdk/client` 연결 코드가 아직 없다(저장소 전체 grep 결과 없음). 후속으로 자연어 채팅을 붙일 때는:
1. 이 설정을 읽어 `mcp/server.ts`를 자식 프로세스로 spawn하는 MCP 클라이언트 코드 작성, **또는**
2. (더 단순한 대안) MCP 프로토콜을 거치지 않고 `CRpcClient`/`CameraClient`/`VpdClient`를 채팅 백엔드에서 직접 import해 LLM tool 정의로 재사용(같은 프로세스·같은 신뢰 경계이므로 프로토콜 오버헤드 불필요)

중 하나를 결정해야 한다(이전 대화 §"방법 A/B" 참조).

---

## 6. 권장 도입 순서

1. **방식 B부터 도입**: 뷰어 UI의 결정론적 컨트롤(프리셋 선택 버튼, PTZ 슬라이더 등)을 `/viewer/api/rpc`로 연결. 기존 `controlToken` 인증을 그대로 적용해 안전하게 시작.
2. **(선택) 방식 A 병행**: 고빈도·저지연이 중요한 조작(예: 슬라이더 드래그 중 실시간 미리보기)에 한해 브라우저 직접 호출 허용. 이 경우 §8 보안 권고를 반드시 적용.
3. **(후속, 별도 설계) 자연어 채팅**: §5의 MCP 브리지 결정 이후 진행.

---

## 7. 영향도 분석 (impact-analysis 8개 영역 준용)

1. **참조 의존성**: 방식 B는 `src/viewer/routes.ts`, `src/api/server.ts`, `src/index.ts` 3개 파일과 `toolsConfig.ts`(화이트리스트 옵션 추가 시) 수정. 방식 A는 `web/` 정적 프론트 파일만 수정.
2. **씬·프리팹 직렬화**: 해당 없음(Unity 측 무변경).
3. **ScriptableObject**: 해당 없음.
4. **실행 순서·생명주기**: 해당 없음(HTTP 요청 시점 로직).
5. **REST/RPC API**: 13020에 `POST /viewer/api/rpc`, `GET /viewer/api/rpc/catalog` **신규 추가**(하위 호환, 기존 `/viewer/api/*` 불변). 13110 쪽은 무변경.
6. **VLA 파이프라인**: 무관(뷰어·카메라 제어는 VLA 검출과 독립).
7. **기존 테스트**: `SettingAgent`에 `vitest` 테스트가 있으므로(`test/viewerStreamRoutes.test.ts` 등 기존 패턴), 신규 라우트에 대한 회귀 테스트 추가 필요(컨트롤 토큰 검증, RPC 프록시 성공/실패 케이스).
8. **씬·프리팹 조작**: 해당 없음.

---

## 8. 보안 권고 (사용자 결정 필요)

1. **`controlToken` 필수화 여부**: 현재 `if (viewer.controlToken && ...)` 구조라 `controlToken`이 빈 문자열(`''`, 기본값)이면 **검증 자체가 스킵**된다. RPC 프록시(방식 B)를 열 때는 `controlToken`을 반드시 설정하도록 강제할지 결정 필요.
2. **RPC 화이트리스트 도입 여부**: 76개 method를 전부 브라우저에 열지, 파괴적 method(`*.delete*`, `*.clear`, `scene.load` 등)를 화이트리스트/블랙리스트로 제한할지. 방식 A(직접)는 Unity 측에 인증이 없어 이 리스크가 더 크다.
3. **방식 A의 Unity bind 주소**: 브라우저가 13110에 직접 붙으려면 `CRpcServerHost.m_BindAddress`가 `localhost`가 아닌 실제 접근 가능 주소여야 하는 배포 환경도 있다(memory: 외부 PC 접속 시 LAN IP/0.0.0.0 필요) — 이 경우 13110이 내부망 전체에 노출되므로 인증 부재 리스크가 커진다.

이 3가지는 구현 착수 전 확인이 필요하다.

