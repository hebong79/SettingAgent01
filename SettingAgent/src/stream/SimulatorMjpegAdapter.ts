import type { Ptz } from '../viewer/CameraSource.js';
import type { StreamAdapter, StreamRequest } from './StreamAdapter.js';

export type SimulatorMjpegFactory = (
  cam: number,
  presetIdx: number,
  signal: AbortSignal,
  ptz?: Ptz,
) => AsyncGenerator<Buffer>;

/** Unity HTTP MJPEG generator를 공통 StreamAdapter 계약으로 노출한다. */
export class SimulatorMjpegAdapter implements StreamAdapter {
  readonly transport = 'http-mjpeg' as const;

  constructor(private readonly factory: SimulatorMjpegFactory) {}

  stream(request: StreamRequest): AsyncGenerator<Buffer> {
    return this.factory(request.cam, request.presetIdx, request.signal, request.ptz);
  }
}
