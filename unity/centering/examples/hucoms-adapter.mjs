// 실기 어댑터 예제 — Hucoms 계열 CGI 카메라.
//
// 이 라이브러리가 카메라에 요구하는 것은 이 네 개(+선택 하나)뿐이다. 다른 기종을 붙일 때는
// 이 파일만 갈아끼우면 된다.
//
//   getPtz()          → { panpos, tiltpos, zoompos }   centidegree / 줌 스텝
//   setCenter({x,y})  → 이 픽셀을 가운데로 (기종에 이 기능이 없으면 goPtz 만 구현하고
//                       ClickCentering 을 mode:"absolute" 로 쓰면 된다)
//   goPtz({panpos,tiltpos,zoompos}) → 절대이동
//   snapshotGray()    → { data, width, height }  8bit 그레이스케일 (캘리브레이션에만 필요)
//   setCenterBox()    → 선택. 박스줌을 쓸 때만
//
// 주의: 인증 방식은 기종·펌웨어마다 다르다(여기서는 Basic). 실제 배포에서는 자격증명을
// 서버에만 두고 브라우저에는 절대 내려보내지 말 것.

export class HucomsAdapter {
  constructor({ host, port = 80, username, password, timeoutMs = 8000, decodeGray }) {
    this.base = `http://${host}:${port}`;
    this.auth = username ? "Basic " + Buffer.from(`${username}:${password ?? ""}`).toString("base64") : null;
    this.timeoutMs = timeoutMs;
    // JPEG → 그레이스케일 디코더는 주입한다. 라이브러리를 의존성 없이 두기 위한 경계다.
    //   node:    sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true })
    //   브라우저: createImageBitmap → canvas → getImageData
    this.decodeGray = decodeGray;
  }

  async #get(path, params = {}) {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: this.auth ? { authorization: this.auth } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res;
  }

  async #text(path, params) {
    return (await this.#get(path, params)).text();
  }

  async getPtz() {
    const text = await this.#text("/cgi-bin/control/ptzf_status.cgi", { action: "getptzfpos" });
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0) {
        const value = line.slice(i + 1).trim();
        const n = Number(value);
        out[line.slice(0, i).trim()] = value !== "" && Number.isFinite(n) ? n : value;
      }
    }
    return out;
  }

  async goPtz({ panpos, tiltpos, zoompos, panspeed, tiltspeed, zoomspeed }) {
    await this.#text("/cgi-bin/control/ptzf_status.cgi", {
      action: "goptzfpos", panpos, tiltpos, zoompos, panspeed, tiltspeed, zoomspeed,
    });
  }

  /** 좌표는 **이미 보정된 값**이 들어온다 — 보정은 ClickCentering 이 한다. */
  async setCenter({ x, y, speed }) {
    await this.#text("/cgi-bin/control/ptz_centering.cgi", {
      action: "setcenter", type: "point", "center.pointx": x, "center.pointy": y, speed,
    });
  }

  async setCenterBox({ startX, startY, endX, endY, speed }) {
    await this.#text("/cgi-bin/control/ptz_centering.cgi", {
      action: "setcenter", type: "box",
      "center.startx": startX, "center.starty": startY,
      "center.endx": endX, "center.endy": endY, speed,
    });
  }

  async snapshotGray() {
    if (!this.decodeGray) throw new Error("snapshotGray: decodeGray 를 주입해야 합니다 (캘리브레이션에만 필요).");
    const bytes = Buffer.from(await (await this.#get("/cgi-bin/image/jpeg.cgi")).arrayBuffer());
    return this.decodeGray(bytes);
  }
}

// ---------------------------------------------------------------------------
// 쓰는 법
//
// import sharp from "sharp";
// import { ClickCentering, CalibrationRunner } from "../index.mjs";
//
// const camera = new HucomsAdapter({
//   host: "192.168.0.50", username: "admin", password: "****",
//   decodeGray: async (jpeg) => {
//     const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
//     return { data, width: info.width, height: info.height };
//   },
// });
//
// // 1) 이미 표가 있으면 바로 클릭 센터링
// const centering = new ClickCentering({ camera, calibration: "cam-001" });
// await centering.click({ x: 1440, y: 300 });
//
// // 2) 이 개체를 직접 재려면 (밝을 때, 무늬 있는 쪽을 향한 상태로)
// const runner = new CalibrationRunner({ camera, onProgress: (p) => console.log(p.message ?? "") });
// const verified = await runner.verify();            // 3분 — 프리셋으로 되는지 먼저 본다
// if (verified.verdict !== "pass") {
//   const measured = await runner.run({ mode: "full" });   // 20분
//   await saveToConfig(measured.calibration.toJSON());
// }
