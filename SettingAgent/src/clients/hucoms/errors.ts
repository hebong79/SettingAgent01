/** Hucoms HTTP API 오류의 공통 기반. */
export class HucomsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 호출 전에 발견된 인자 범위·형식 오류. */
export class HucomsValidationError extends HucomsError {}

/** DNS, 연결, timeout 등 전송 계층 오류. */
export class HucomsTransportError extends HucomsError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

/** HTTP 2xx가 아닌 응답. */
export class HucomsHttpError extends HucomsError {
  constructor(public readonly status: number, public readonly statusText: string) {
    super(`HTTP ${status}${statusText ? `: ${statusText}` : ''}`);
  }
}

/** HTTP 200이지만 본문이 `Error: ...`인 장비 오류. */
export class HucomsResponseError extends HucomsError {
  constructor(message: string, public readonly rawText = '') {
    super(message);
  }
}

/** multipart MJPEG/event 응답 형식 오류. */
export class HucomsStreamError extends HucomsError {}
