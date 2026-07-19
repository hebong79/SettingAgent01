import { HucomsStreamError } from './errors.js';
import type { HucomsParsedResponse } from './types.js';

const ERROR_RE = /^\s*error\s*:\s*(.*)$/i;

/** `[Section]`과 `key = value`로 구성된 Hucoms 응답을 파싱한다. */
export function parseHucomsText(rawText: string): HucomsParsedResponse {
  const values: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  let message: string | undefined;

  for (const original of rawText.replace(/\r\n?/g, '\n').split('\n')) {
    const line = original.trim();
    if (!line) continue;
    const error = ERROR_RE.exec(line);
    if (error) {
      message = error[1]?.trim() ?? '';
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      current = (sections[name] ??= {});
      continue;
    }
    const equal = original.indexOf('=');
    if (equal < 1) continue;
    const key = original.slice(0, equal).trim();
    const value = original
      .slice(equal + 1)
      .trim()
      .replace(/\s+\*\s+.*$/, '')
      .trim();
    values[key] = value;
    if (current) current[key] = value;
  }
  return { values, sections, rawText, message };
}

export function multipartBoundary(contentType: string): string {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new HucomsStreamError('multipart 응답에 boundary가 없습니다');
  return boundary;
}

/** 메모리에 수신한 multipart/x-mixed-replace 응답에서 각 payload를 분리한다. */
export function parseMultipart(body: Buffer, contentType: string): Buffer[] {
  const marker = Buffer.from(`--${multipartBoundary(contentType)}`);
  const parts: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const begin = body.indexOf(marker, cursor);
    if (begin < 0) break;
    let start = begin + marker.length;
    if (body.subarray(start, start + 2).equals(Buffer.from('--'))) break;
    if (body.subarray(start, start + 2).equals(Buffer.from('\r\n'))) start += 2;
    else if (body[start] === 0x0a) start += 1;

    let headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
    let separatorLength = 4;
    if (headerEnd < 0) {
      headerEnd = body.indexOf(Buffer.from('\n\n'), start);
      separatorLength = 2;
    }
    if (headerEnd < 0) throw new HucomsStreamError('multipart part header가 끝나지 않았습니다');
    const headerText = body.subarray(start, headerEnd).toString('latin1');
    const payloadStart = headerEnd + separatorLength;
    const lengthMatch = /^content-length\s*:\s*(\d+)\s*$/im.exec(headerText);
    if (lengthMatch) {
      const length = Number(lengthMatch[1]);
      if (!Number.isSafeInteger(length) || body.length < payloadStart + length) {
        throw new HucomsStreamError('multipart Content-Length가 올바르지 않습니다');
      }
      parts.push(body.subarray(payloadStart, payloadStart + length));
      cursor = payloadStart + length;
    } else {
      const next = body.indexOf(marker, payloadStart);
      if (next < 0) break;
      let payloadEnd = next;
      while (payloadEnd > payloadStart && (body[payloadEnd - 1] === 0x0a || body[payloadEnd - 1] === 0x0d)) {
        payloadEnd -= 1;
      }
      parts.push(body.subarray(payloadStart, payloadEnd));
      cursor = next;
    }
  }
  return parts;
}
