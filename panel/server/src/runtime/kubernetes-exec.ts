import { PassThrough, Writable } from 'node:stream';
import zlib from 'node:zlib';
import * as k8s from '@kubernetes/client-node';
import type { Instance } from '../store.js';
import { INSTANCE_CONTAINER_NAME, podName } from './kubernetes-manifests.js';

export const TRANSFER_DIR = '/config/Desktop';
export const VOL_ROOT = '/config';

// Docker runs every in-container exec as the unprivileged app user ('abc', PUID 1000) via dockerode's
// `User` option. The Kubernetes exec API has no user parameter, so wrap each command to drop privileges
// with the linuxserver baseimage's s6-setuidgid. The `command -v` guard means a missing helper degrades
// to running as-is (root) rather than failing every exec. Using `exec` keeps the command's own exit code.
export const EXEC_USER = 'abc';
const DROP_PRIV_PROLOGUE = `if command -v s6-setuidgid >/dev/null 2>&1; then exec s6-setuidgid ${EXEC_USER} "$@"; else exec "$@"; fi`;

export function asAppUser(command: string[]): string[] {
  return ['sh', '-c', DROP_PRIV_PROLOGUE, '--', ...command];
}

export function safeName(name: string): boolean {
  return !!name && name.length <= 200 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..';
}

export function safeVolPath(rel: string): string {
  const raw = (rel ?? '').replace(/\\/g, '/');
  if (raw.includes('\0')) throw new Error('路径不合法');
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error('路径不合法（禁止 ..）');
    parts.push(seg);
  }
  return parts.length ? `${VOL_ROOT}/${parts.join('/')}` : VOL_ROOT;
}

export const relOf = (abs: string): string => (abs === VOL_ROOT ? '' : abs.slice(VOL_ROOT.length + 1));

export function maybeGunzip(buf: Buffer): Buffer {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
}

// Shared, byte-safe USTAR encoder (handles multibyte filenames / oversized files in one place).
export { tarSingleFile } from '../tar.js';

export function extractSingleFileFromTar(tar: Buffer): Buffer {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { allZero = false; break; }
    if (allZero) break;
    const sizeStr = header.toString('ascii', 124, 136).replace(/[^0-7]/g, '');
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeflag = header[156];
    const dataStart = off + 512;
    if (typeflag === 0x30 || typeflag === 0) {
      return tar.subarray(dataStart, dataStart + size);
    }
    off = dataStart + size + ((512 - (size % 512)) % 512);
  }
  return Buffer.alloc(0);
}

interface ExecStatus {
  seen: boolean;
  exitCode: number;
  message: string;
}

// k8s.Exec fires this callback with a V1Status when the exec channel closes normally (Success, or
// Failure carrying the ExitCode). If the websocket dies WITHOUT a status frame — mid-stream network
// drop, API-server closing the channel, the process being SIGKILLed (OOM / pod teardown) — the callback
// never fires. Tracking `seen` lets callers treat "closed without a status" as failure instead of
// silently returning whatever partial output was buffered (for tar: a truncated archive served as success).
function makeStatusHandler(st: ExecStatus) {
  return (status: unknown) => {
    st.seen = true;
    const s = status as any;
    if (s?.status === 'Success') {
      st.exitCode = 0;
      return;
    }
    st.exitCode = Number(s?.details?.causes?.find((c: any) => c.reason === 'ExitCode')?.message) || 1;
    st.message = s?.message || '';
  };
}

const NO_STATUS_ERROR = 'exec 连接异常关闭，未收到结束状态（输出可能不完整）';

export class KubernetesExecHelper {
  private readonly exec: k8s.Exec;

  constructor(
    kubeConfig: k8s.KubeConfig,
    private readonly namespace: string,
  ) {
    this.exec = new k8s.Exec(kubeConfig);
  }

  async execCapture(inst: Instance, command: string[], stdin?: Buffer): Promise<string> {
    let out = '';
    let err = '';
    const st: ExecStatus = { seen: false, exitCode: 0, message: '' };
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        out += Buffer.from(chunk).toString('utf8');
        cb();
      },
    });
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        err += Buffer.from(chunk).toString('utf8');
        cb();
      },
    });
    const input = stdin ? PassThrough.from(stdin) : null;
    const ws = await this.exec.exec(
      this.namespace,
      // Under a StatefulSet the pod is woc-wx-<id>-0, not the workload/Service name woc-wx-<id>.
      podName(inst),
      INSTANCE_CONTAINER_NAME,
      asAppUser(command),
      stdout,
      stderr,
      input,
      false,
      makeStatusHandler(st),
    );
    await new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    if (!st.seen) throw new Error(NO_STATUS_ERROR);
    if (st.exitCode !== 0) throw new Error((err || out || st.message || `命令执行失败，退出码 ${st.exitCode}`).trim());
    return out || err;
  }

  async putTar(inst: Instance, dir: string, tar: Buffer): Promise<void> {
    await this.execCapture(inst, ['mkdir', '-p', dir]);
    await this.execCapture(inst, ['tar', '-xf', '-', '-C', dir], tar);
  }

  async getTar(inst: Instance, path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    let err = '';
    const st: ExecStatus = { seen: false, exitCode: 0, message: '' };
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        err += Buffer.from(chunk).toString('utf8');
        cb();
      },
    });
    const ws = await this.exec.exec(
      this.namespace,
      // Under a StatefulSet the pod is woc-wx-<id>-0, not the workload/Service name woc-wx-<id>.
      podName(inst),
      INSTANCE_CONTAINER_NAME,
      asAppUser(['tar', '-cf', '-', path]),
      stdout,
      stderr,
      null,
      false,
      makeStatusHandler(st),
    );
    await new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    // Fail closed: never return a tar that the exec did not confirm finished cleanly, or a downstream
    // restore/download would treat a truncated archive as valid.
    if (!st.seen) throw new Error(NO_STATUS_ERROR);
    if (st.exitCode !== 0) throw new Error((err || st.message || `tar 读取失败，退出码 ${st.exitCode}`).trim());
    return Buffer.concat(chunks);
  }

  // Streaming counterpart to getTar: the tar bytes flow straight to the returned stream instead of
  // being buffered into memory. Used for whole-volume backup, which can be multiple GB.
  async getTarStream(inst: Instance, path: string): Promise<NodeJS.ReadableStream> {
    const stdout = new PassThrough();
    let err = '';
    const st: ExecStatus = { seen: false, exitCode: 0, message: '' };
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        err += Buffer.from(chunk).toString('utf8');
        cb();
      },
    });
    const ws = await this.exec.exec(
      this.namespace,
      // Under a StatefulSet the pod is woc-wx-<id>-0, not the workload/Service name woc-wx-<id>.
      podName(inst),
      INSTANCE_CONTAINER_NAME,
      asAppUser(['tar', '-cf', '-', path]),
      stdout,
      stderr,
      null,
      false,
      makeStatusHandler(st),
    );
    ws.on('close', () => {
      // Destroy (rather than cleanly end) when the exec did not report success or closed without a
      // status frame — so a backup that drops mid-stream surfaces as a broken download, not a clean EOF
      // on a truncated archive. Bytes already flushed cannot be un-sent; the route must abort the
      // HTTP response on stream error.
      if (!st.seen) stdout.destroy(new Error(NO_STATUS_ERROR));
      else if (st.exitCode !== 0) stdout.destroy(new Error((err || st.message || `tar 读取失败，退出码 ${st.exitCode}`).trim()));
      else if (!stdout.writableEnded) stdout.end();
    });
    ws.on('error', (e) => stdout.destroy(e as Error));
    return stdout;
  }
}
