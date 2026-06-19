# Hybrid Kubernetes Runtime Implementation Plan

> ⚠️ **STATUS: IMPLEMENTED — this plan is now a historical record, not an execution script.** Do NOT
> re-implement it verbatim. The code blocks below are the *original* drafts and contain defects that
> were caught in review and fixed after the fact (commit `b309650` and the follow-ups). Known defects
> still embedded in the snippets below include: facade re-exports without `.bind` (loses `this` for the
> class-based Kubernetes driver); eager Kubernetes client construction at import (crashes Docker mode);
> `deletePod` race (`gracePeriodSeconds: 5`, no wait, no 409 retry); `ensureService` replace that wipes
> the immutable `clusterIP` (422); blocking `triggerWechat`; silent-no-op `regenInstanceMachineId`;
> in-memory `volBackupStream`; execs running as root instead of `abc`; hardcoded `admin/wechat` in
> `deployment.yaml`; and the obsolete `isNotFoundError` shape for `@kubernetes/client-node` 1.x.
> **The shipped source under `panel/server/src/runtime/` and `k8s/` is the source of truth.** A later
> review (`docs/...` review notes) also fixed: byte-unsafe tar filenames, bare Service short-name
> addressing (now namespace-qualified), the RBAC/`readNamespace` readiness mismatch, snapshot-before-
> delete, exec fail-closed, Pod requests/readiness probe, image pull secrets, and panel hardening.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `WOC_RUNTIME=docker|kubernetes` so the current Docker/Compose deployment stays unchanged while the panel can also manage WechatOnCloud instances as Kubernetes Pods, PVCs, and Services.

**Architecture:** Introduce a `RuntimeDriver` boundary in the panel server. The existing Docker implementation becomes the default driver, and a Kubernetes driver implements the same operations with in-cluster Kubernetes API calls. The HTTP routes keep their behavior by importing the runtime facade instead of importing Docker directly.

**Tech Stack:** TypeScript, Fastify, Dockerode, `@kubernetes/client-node`, Kubernetes CoreV1 API, plain YAML manifests, Node test runner with `tsx`.

---

## File Structure

- Create `panel/server/src/runtime/types.ts`: shared runtime types and the `RuntimeDriver` interface.
- Create `panel/server/src/runtime/docker-runtime.ts`: adapter object around the current `docker.ts` exports.
- Create `panel/server/src/runtime/index.ts`: selects the runtime from `WOC_RUNTIME` and re-exports the current function names used by `index.ts`.
- Create `panel/server/src/runtime/kubernetes-config.ts`: Kubernetes client loading, namespace detection, and runtime config parsing.
- Create `panel/server/src/runtime/kubernetes-manifests.ts`: pure Pod/PVC/Service manifest builders.
- Create `panel/server/src/runtime/kubernetes-exec.ts`: exec/log/archive helpers built on `@kubernetes/client-node`.
- Create `panel/server/src/runtime/kubernetes-runtime.ts`: Kubernetes implementation of `RuntimeDriver`.
- Modify `panel/server/src/index.ts`: import runtime facade from `./runtime/index.js` instead of `./docker.js`; update Docker-specific labels/errors to runtime-neutral text where visible.
- Modify `panel/server/package.json` and `panel/server/package-lock.json`: add Kubernetes client dependency and test scripts.
- Create tests under `panel/server/src/runtime/*.test.ts`: runtime selection, env parsing, manifest builders, and Kubernetes status mapping.
- Create `k8s/*.yaml`: plain Kubernetes manifests for panel deployment, RBAC, panel PVC, service, and optional ingress example.
- Modify `.env.example`, `README.md`, `doc/运行原理.md`, `doc/部署与运维.md`, `doc/数据卷管理.md`: document hybrid runtime and Kubernetes deployment.

## Implementation Rules

- Keep Docker mode behavior byte-for-byte close where possible. `WOC_RUNTIME` defaults to `docker`.
- Do not rename store fields in the first pass. `containerName` means runtime workload name; `volumeName` means runtime data resource name.
- Kubernetes mode only manages resources in one namespace.
- Kubernetes mode names resources exactly like Docker mode: workload/service `woc-wx-<id>`, data PVC `woc-data-<id>`.
- Kubernetes mode treats a missing Pod plus an existing PVC or Service as `stopped`; no Pod/PVC/Service is `missing`.
- Kubernetes mode does not implement camera/video host-device passthrough in this first pass.
- Kubernetes memory watchdog uses `0` when metrics API is unavailable. HTTP health probing remains available.

---

### Task 1: Add Test Harness

**Files:**
- Modify: `panel/server/package.json`
- Create: `panel/server/src/runtime/runtime-test-smoke.test.ts`

- [ ] **Step 1: Add server test scripts**

Update `panel/server/package.json` scripts to:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "node --test --import tsx \"src/**/*.test.ts\"",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Add a smoke test**

Create `panel/server/src/runtime/runtime-test-smoke.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('server test runner executes TypeScript tests', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run the smoke test**

Run:

```bash
cd panel/server
npm test -- src/runtime/runtime-test-smoke.test.ts
```

Expected: one passing test.

- [ ] **Step 4: Run typecheck**

Run:

```bash
cd panel/server
npm run typecheck
```

Expected: TypeScript passes. If it exposes pre-existing strictness issues, capture the exact errors and fix only errors in touched files.

- [ ] **Step 5: Commit**

```bash
git add panel/server/package.json panel/server/src/runtime/runtime-test-smoke.test.ts
git commit -m "test(panel): add server TypeScript test runner"
```

---

### Task 2: Define the Runtime Interface

**Files:**
- Create: `panel/server/src/runtime/types.ts`
- Test: `panel/server/src/runtime/types.test.ts`

- [ ] **Step 1: Write the interface test**

Create `panel/server/src/runtime/types.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeDriver, RuntimeState, WechatStatus } from './types.js';

test('runtime states are compatible with the existing API contract', () => {
  const states: RuntimeState[] = ['running', 'stopped', 'missing'];
  assert.deepEqual(states, ['running', 'stopped', 'missing']);
});

test('runtime driver can be implemented by a plain object', () => {
  const status: WechatStatus = {
    phase: 'idle',
    percent: 0,
    installed: false,
    version: '',
    message: '未安装',
    updatedAt: 0,
  };

  assert.equal(status.phase, 'idle');

  const keys = [
    'kind',
    'ensureRuntimeReady',
    'runInstance',
    'ensureRunning',
    'upgradeInstance',
    'regenInstanceMachineId',
    'stopInstance',
    'removeInstance',
    'listOrphanVolumes',
    'removeVolume',
    'listOrphanContainers',
    'removeContainerById',
    'instanceMemoryMB',
    'instanceHttpHealthy',
    'instanceRuntime',
    'triggerWechat',
    'wechatStatus',
    'buildDiagnostics',
    'uploadToInstance',
    'listInstanceFiles',
    'deleteInstanceFile',
    'downloadFromInstance',
    'instanceLogs',
    'typeInInstance',
    'keyInInstance',
    'listVolume',
    'volMkdir',
    'volMove',
    'volDelete',
    'volUploadFile',
    'volExtractArchive',
    'volDownloadFile',
    'volBackupStream',
    'volRestoreArchive',
    'instanceTarget',
  ] satisfies Array<keyof RuntimeDriver>;

  assert.equal(keys.includes('instanceTarget'), true);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd panel/server
npm test -- src/runtime/types.test.ts
```

Expected: FAIL because `./types.js` does not exist.

- [ ] **Step 3: Implement runtime types**

Create `panel/server/src/runtime/types.ts`:

```ts
import type { Instance } from '../store.js';

export type RuntimeKind = 'docker' | 'kubernetes';
export type RuntimeState = 'running' | 'stopped' | 'missing';

export interface WechatStatus {
  phase: string;
  percent: number;
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

export interface TransferFile {
  name: string;
  size: number;
}

export interface VolEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
}

export interface OrphanVolume {
  name: string;
  createdAt?: string;
  sizeBytes?: number;
}

export interface OrphanContainer {
  id: string;
  name: string;
  status: string;
  volumeName?: string;
}

export interface RuntimeDriver {
  kind: RuntimeKind;
  ensureRuntimeReady(): Promise<void>;
  runInstance(inst: Instance): Promise<void>;
  ensureRunning(inst: Instance): Promise<void>;
  upgradeInstance(inst: Instance): Promise<void>;
  regenInstanceMachineId(inst: Instance): Promise<void>;
  stopInstance(inst: Instance): Promise<void>;
  removeInstance(inst: Instance, purgeVolume: boolean): Promise<void>;
  listOrphanVolumes(referencedVolumes: Set<string>): Promise<OrphanVolume[]>;
  removeVolume(name: string): Promise<void>;
  listOrphanContainers(knownContainerNames: Set<string>): Promise<OrphanContainer[]>;
  removeContainerById(idOrName: string): Promise<void>;
  instanceMemoryMB(inst: Instance): Promise<number>;
  instanceHttpHealthy(inst: Instance, timeoutMs?: number): Promise<boolean>;
  instanceRuntime(inst: Instance): Promise<RuntimeState>;
  triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void>;
  wechatStatus(inst: Instance): Promise<WechatStatus>;
  buildDiagnostics(instances: Instance[], sinceMs: number, meta: Record<string, string>): Promise<Buffer>;
  uploadToInstance(inst: Instance, name: string, content: Buffer): Promise<void>;
  listInstanceFiles(inst: Instance): Promise<TransferFile[]>;
  deleteInstanceFile(inst: Instance, name: string): Promise<void>;
  downloadFromInstance(inst: Instance, name: string): Promise<Buffer>;
  instanceLogs(inst: Instance, tail?: number): Promise<string>;
  typeInInstance(inst: Instance, text: string): Promise<void>;
  keyInInstance(inst: Instance, key: string): Promise<void>;
  listVolume(inst: Instance, rel: string): Promise<{ path: string; entries: VolEntry[] }>;
  volMkdir(inst: Instance, rel: string): Promise<void>;
  volMove(inst: Instance, fromRel: string, toRel: string): Promise<void>;
  volDelete(inst: Instance, rel: string): Promise<void>;
  volUploadFile(inst: Instance, rel: string, name: string, content: Buffer): Promise<void>;
  volExtractArchive(inst: Instance, rel: string, archive: Buffer): Promise<void>;
  volDownloadFile(inst: Instance, rel: string): Promise<Buffer>;
  volBackupStream(inst: Instance): Promise<NodeJS.ReadableStream>;
  volRestoreArchive(inst: Instance, archive: Buffer): Promise<void>;
  instanceTarget(inst: Instance): string;
}
```

- [ ] **Step 4: Run the test**

Run:

```bash
cd panel/server
npm test -- src/runtime/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/server/src/runtime/types.ts panel/server/src/runtime/types.test.ts
git commit -m "feat(panel): define instance runtime interface"
```

---

### Task 3: Wrap the Existing Docker Runtime

**Files:**
- Create: `panel/server/src/runtime/docker-runtime.ts`
- Test: `panel/server/src/runtime/docker-runtime.test.ts`

- [ ] **Step 1: Write the adapter test**

Create `panel/server/src/runtime/docker-runtime.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerRuntime } from './docker-runtime.js';

test('docker runtime exposes the current runtime contract', () => {
  assert.equal(dockerRuntime.kind, 'docker');
  assert.equal(typeof dockerRuntime.ensureRuntimeReady, 'function');
  assert.equal(typeof dockerRuntime.runInstance, 'function');
  assert.equal(typeof dockerRuntime.instanceTarget, 'function');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd panel/server
npm test -- src/runtime/docker-runtime.test.ts
```

Expected: FAIL because `docker-runtime.ts` does not exist.

- [ ] **Step 3: Implement the Docker adapter**

Create `panel/server/src/runtime/docker-runtime.ts`:

```ts
import * as docker from '../docker.js';
import type { RuntimeDriver } from './types.js';

export const dockerRuntime: RuntimeDriver = {
  kind: 'docker',
  ensureRuntimeReady: async () => {
    await docker.ensureNetwork();
  },
  runInstance: docker.runInstance,
  ensureRunning: docker.ensureRunning,
  upgradeInstance: docker.upgradeInstance,
  regenInstanceMachineId: docker.regenInstanceMachineId,
  stopInstance: docker.stopInstance,
  removeInstance: docker.removeInstance,
  listOrphanVolumes: docker.listOrphanVolumes,
  removeVolume: docker.removeVolume,
  listOrphanContainers: docker.listOrphanContainers,
  removeContainerById: docker.removeContainerById,
  instanceMemoryMB: docker.instanceMemoryMB,
  instanceHttpHealthy: docker.instanceHttpHealthy,
  instanceRuntime: docker.instanceRuntime,
  triggerWechat: docker.triggerWechat,
  wechatStatus: docker.wechatStatus,
  buildDiagnostics: docker.buildDiagnostics,
  uploadToInstance: docker.uploadToInstance,
  listInstanceFiles: docker.listInstanceFiles,
  deleteInstanceFile: docker.deleteInstanceFile,
  downloadFromInstance: docker.downloadFromInstance,
  instanceLogs: docker.instanceLogs,
  typeInInstance: docker.typeInInstance,
  keyInInstance: docker.keyInInstance,
  listVolume: docker.listVolume,
  volMkdir: docker.volMkdir,
  volMove: docker.volMove,
  volDelete: docker.volDelete,
  volUploadFile: docker.volUploadFile,
  volExtractArchive: docker.volExtractArchive,
  volDownloadFile: docker.volDownloadFile,
  volBackupStream: docker.volBackupStream,
  volRestoreArchive: docker.volRestoreArchive,
  instanceTarget: docker.instanceTarget,
};
```

- [ ] **Step 4: Run the adapter test**

Run:

```bash
cd panel/server
npm test -- src/runtime/docker-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/server/src/runtime/docker-runtime.ts panel/server/src/runtime/docker-runtime.test.ts
git commit -m "feat(panel): wrap docker runtime behind driver"
```

---

### Task 4: Add Runtime Selection Facade

**Files:**
- Create: `panel/server/src/runtime/index.ts`
- Test: `panel/server/src/runtime/index.test.ts`

- [ ] **Step 1: Write runtime selection tests**

Create `panel/server/src/runtime/index.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeKindFromEnv } from './index.js';

test('runtime defaults to docker', () => {
  assert.equal(runtimeKindFromEnv(undefined), 'docker');
  assert.equal(runtimeKindFromEnv(''), 'docker');
});

test('runtime accepts docker and kubernetes', () => {
  assert.equal(runtimeKindFromEnv('docker'), 'docker');
  assert.equal(runtimeKindFromEnv('kubernetes'), 'kubernetes');
});

test('runtime trims and lowercases env input', () => {
  assert.equal(runtimeKindFromEnv(' Kubernetes '), 'kubernetes');
});

test('runtime rejects unknown input', () => {
  assert.throws(() => runtimeKindFromEnv('compose'), /Unsupported WOC_RUNTIME/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd panel/server
npm test -- src/runtime/index.test.ts
```

Expected: FAIL because `runtimeKindFromEnv` does not exist.

- [ ] **Step 3: Implement facade with Docker selected**

Create `panel/server/src/runtime/index.ts`:

```ts
import type { RuntimeKind } from './types.js';
import { dockerRuntime } from './docker-runtime.js';

export function runtimeKindFromEnv(value: string | undefined): RuntimeKind {
  const normalized = (value || 'docker').trim().toLowerCase();
  if (!normalized || normalized === 'docker') return 'docker';
  if (normalized === 'kubernetes' || normalized === 'k8s') return 'kubernetes';
  throw new Error(`Unsupported WOC_RUNTIME="${value}". Expected "docker" or "kubernetes".`);
}

const selectedKind = runtimeKindFromEnv(process.env.WOC_RUNTIME);

export const runtime = selectedKind === 'docker'
  ? dockerRuntime
  : dockerRuntime;

export const ensureNetwork = runtime.ensureRuntimeReady;
export const runInstance = runtime.runInstance;
export const ensureRunning = runtime.ensureRunning;
export const upgradeInstance = runtime.upgradeInstance;
export const regenInstanceMachineId = runtime.regenInstanceMachineId;
export const stopInstance = runtime.stopInstance;
export const removeInstance = runtime.removeInstance;
export const listOrphanVolumes = runtime.listOrphanVolumes;
export const removeVolume = runtime.removeVolume;
export const listOrphanContainers = runtime.listOrphanContainers;
export const removeContainerById = runtime.removeContainerById;
export const instanceMemoryMB = runtime.instanceMemoryMB;
export const instanceHttpHealthy = runtime.instanceHttpHealthy;
export const instanceRuntime = runtime.instanceRuntime;
export const triggerWechat = runtime.triggerWechat;
export const wechatStatus = runtime.wechatStatus;
export const buildDiagnostics = runtime.buildDiagnostics;
export const uploadToInstance = runtime.uploadToInstance;
export const listInstanceFiles = runtime.listInstanceFiles;
export const deleteInstanceFile = runtime.deleteInstanceFile;
export const downloadFromInstance = runtime.downloadFromInstance;
export const instanceLogs = runtime.instanceLogs;
export const typeInInstance = runtime.typeInInstance;
export const keyInInstance = runtime.keyInInstance;
export const listVolume = runtime.listVolume;
export const volMkdir = runtime.volMkdir;
export const volMove = runtime.volMove;
export const volDelete = runtime.volDelete;
export const volUploadFile = runtime.volUploadFile;
export const volExtractArchive = runtime.volExtractArchive;
export const volDownloadFile = runtime.volDownloadFile;
export const volBackupStream = runtime.volBackupStream;
export const volRestoreArchive = runtime.volRestoreArchive;
export const instanceTarget = runtime.instanceTarget;
```

This temporarily maps Kubernetes to Docker so the route import can be changed before the Kubernetes implementation exists. Task 9 replaces this branch.

- [ ] **Step 4: Run runtime selection tests**

Run:

```bash
cd panel/server
npm test -- src/runtime/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/server/src/runtime/index.ts panel/server/src/runtime/index.test.ts
git commit -m "feat(panel): add runtime selection facade"
```

---

### Task 5: Route Panel Through Runtime Facade

**Files:**
- Modify: `panel/server/src/index.ts`

- [ ] **Step 1: Change the import source**

In `panel/server/src/index.ts`, change:

```ts
} from './docker.js';
```

to:

```ts
} from './runtime/index.js';
```

Do not change the imported names in this step.

- [ ] **Step 2: Run typecheck**

Run:

```bash
cd panel/server
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run server tests**

Run:

```bash
cd panel/server
npm test
```

Expected: PASS.

- [ ] **Step 4: Run a Docker-mode startup smoke check**

Run:

```bash
cd panel/server
WOC_RUNTIME=docker PANEL_DATA=/tmp/woc-panel-runtime-smoke/accounts.json PORT=18080 npm run start
```

Expected: process logs contain `多实例反代已就绪`. Stop the process with `Ctrl+C`.

- [ ] **Step 5: Commit**

```bash
git add panel/server/src/index.ts
git commit -m "refactor(panel): route instance operations through runtime facade"
```

---

### Task 6: Add Kubernetes Client Dependency

**Files:**
- Modify: `panel/server/package.json`
- Modify: `panel/server/package-lock.json`

- [ ] **Step 1: Install Kubernetes client**

Run:

```bash
cd panel/server
npm install @kubernetes/client-node
```

Expected: `@kubernetes/client-node` is added to dependencies and lockfile.

- [ ] **Step 2: Run tests**

Run:

```bash
cd panel/server
npm test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd panel/server
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add panel/server/package.json panel/server/package-lock.json
git commit -m "chore(panel): add kubernetes client dependency"
```

---

### Task 7: Add Kubernetes Config Parser

**Files:**
- Create: `panel/server/src/runtime/kubernetes-config.ts`
- Test: `panel/server/src/runtime/kubernetes-config.test.ts`

- [ ] **Step 1: Write config tests**

Create `panel/server/src/runtime/kubernetes-config.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKubernetesRuntimeConfig } from './kubernetes-config.js';

test('kubernetes runtime config has practical defaults', () => {
  const cfg = parseKubernetesRuntimeConfig({});
  assert.equal(cfg.namespace, 'default');
  assert.equal(cfg.instanceImage, 'ghcr.io/gloridust/wechat-on-cloud:latest');
  assert.equal(cfg.puid, '1000');
  assert.equal(cfg.pgid, '1000');
  assert.equal(cfg.timezone, 'Asia/Shanghai');
  assert.equal(cfg.enableGpu, false);
  assert.equal(cfg.spoofOs, true);
  assert.equal(cfg.imagePullPolicy, 'IfNotPresent');
  assert.equal(cfg.storageSize, '10Gi');
  assert.equal(cfg.storageClassName, undefined);
});

test('kubernetes runtime config reads env overrides', () => {
  const cfg = parseKubernetesRuntimeConfig({
    WOC_K8S_NAMESPACE: 'wechat',
    WOC_WECHAT_IMAGE: 'example.com/woc/wechat:1.2.3',
    PUID: '1001',
    PGID: '1002',
    TZ: 'Asia/Hong_Kong',
    WOC_ENABLE_GPU: '1',
    WOC_SPOOF_OS: '0',
    WOC_K8S_IMAGE_PULL_POLICY: 'Always',
    WOC_K8S_STORAGE_SIZE: '25Gi',
    WOC_K8S_STORAGE_CLASS: 'fast',
    WOC_INSTANCE_MEM_GB: '3',
  });

  assert.equal(cfg.namespace, 'wechat');
  assert.equal(cfg.instanceImage, 'example.com/woc/wechat:1.2.3');
  assert.equal(cfg.puid, '1001');
  assert.equal(cfg.pgid, '1002');
  assert.equal(cfg.timezone, 'Asia/Hong_Kong');
  assert.equal(cfg.enableGpu, true);
  assert.equal(cfg.spoofOs, false);
  assert.equal(cfg.imagePullPolicy, 'Always');
  assert.equal(cfg.storageSize, '25Gi');
  assert.equal(cfg.storageClassName, 'fast');
  assert.equal(cfg.memoryLimitBytes, 3221225472);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
cd panel/server
npm test -- src/runtime/kubernetes-config.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement config parser**

Create `panel/server/src/runtime/kubernetes-config.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import * as k8s from '@kubernetes/client-node';

const SERVICEACCOUNT_NAMESPACE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

export interface KubernetesRuntimeConfig {
  namespace: string;
  instanceImage: string;
  puid: string;
  pgid: string;
  timezone: string;
  enableGpu: boolean;
  spoofOs: boolean;
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never';
  storageSize: string;
  storageClassName?: string;
  memoryLimitBytes: number;
}

function readNamespaceFromServiceAccount(): string | undefined {
  try {
    if (!existsSync(SERVICEACCOUNT_NAMESPACE)) return undefined;
    const ns = readFileSync(SERVICEACCOUNT_NAMESPACE, 'utf8').trim();
    return ns || undefined;
  } catch {
    return undefined;
  }
}

function imagePullPolicy(value: string | undefined): 'Always' | 'IfNotPresent' | 'Never' {
  if (value === 'Always' || value === 'IfNotPresent' || value === 'Never') return value;
  return 'IfNotPresent';
}

export function parseKubernetesRuntimeConfig(env: NodeJS.ProcessEnv = process.env): KubernetesRuntimeConfig {
  const memGb = Number(env.WOC_INSTANCE_MEM_GB) || 0;
  const storageClassName = (env.WOC_K8S_STORAGE_CLASS || '').trim() || undefined;
  return {
    namespace: (env.WOC_K8S_NAMESPACE || readNamespaceFromServiceAccount() || 'default').trim(),
    instanceImage: env.WOC_WECHAT_IMAGE || 'ghcr.io/gloridust/wechat-on-cloud:latest',
    puid: env.PUID || '1000',
    pgid: env.PGID || '1000',
    timezone: env.TZ || 'Asia/Shanghai',
    enableGpu: env.WOC_ENABLE_GPU === '1',
    spoofOs: env.WOC_SPOOF_OS !== '0',
    imagePullPolicy: imagePullPolicy(env.WOC_K8S_IMAGE_PULL_POLICY),
    storageSize: env.WOC_K8S_STORAGE_SIZE || '10Gi',
    storageClassName,
    memoryLimitBytes: memGb > 0 ? Math.floor(memGb * 1024 * 1024 * 1024) : 0,
  };
}

export function loadKubernetesConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}
```

- [ ] **Step 4: Run config tests**

Run:

```bash
cd panel/server
npm test -- src/runtime/kubernetes-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/server/src/runtime/kubernetes-config.ts panel/server/src/runtime/kubernetes-config.test.ts
git commit -m "feat(panel): parse kubernetes runtime config"
```

---

### Task 8: Build Kubernetes Manifests

**Files:**
- Create: `panel/server/src/runtime/kubernetes-manifests.ts`
- Test: `panel/server/src/runtime/kubernetes-manifests.test.ts`

- [ ] **Step 1: Write manifest tests**

Create `panel/server/src/runtime/kubernetes-manifests.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstancePod, buildInstancePvc, buildInstanceService, instanceLabels } from './kubernetes-manifests.js';
import type { KubernetesRuntimeConfig } from './kubernetes-config.js';
import type { Instance } from '../store.js';

const inst: Instance = {
  id: 'abc123def0',
  name: '测试实例',
  appType: 'chromium',
  containerName: 'woc-wx-abc123def0',
  volumeName: 'woc-data-abc123def0',
  kasmUser: 'woc',
  kasmPassword: 'secret',
  createdAt: '2026-06-18T00:00:00.000Z',
  createdBy: 'admin',
};

const cfg: KubernetesRuntimeConfig = {
  namespace: 'wechat',
  instanceImage: 'example.com/wechat-on-cloud:1.2.3',
  puid: '1000',
  pgid: '1000',
  timezone: 'Asia/Hong_Kong',
  enableGpu: false,
  spoofOs: true,
  imagePullPolicy: 'Always',
  storageSize: '20Gi',
  storageClassName: 'fast',
  memoryLimitBytes: 2147483648,
};

test('instance labels are stable and searchable', () => {
  assert.deepEqual(instanceLabels(inst), {
    'app.kubernetes.io/name': 'wechat-on-cloud',
    'app.kubernetes.io/component': 'instance',
    'woc.gloridust.io/instance-id': 'abc123def0',
  });
});

test('buildInstancePvc creates persistent config storage', () => {
  const pvc = buildInstancePvc(inst, cfg);
  assert.equal(pvc.metadata?.name, 'woc-data-abc123def0');
  assert.equal(pvc.metadata?.namespace, 'wechat');
  assert.equal(pvc.spec?.resources?.requests?.storage, '20Gi');
  assert.equal(pvc.spec?.storageClassName, 'fast');
});

test('buildInstanceService exposes KasmVNC HTTP inside the namespace', () => {
  const svc = buildInstanceService(inst, cfg);
  assert.equal(svc.metadata?.name, 'woc-wx-abc123def0');
  assert.equal(svc.spec?.ports?.[0]?.port, 3000);
  assert.equal(svc.spec?.selector?.['woc.gloridust.io/instance-id'], 'abc123def0');
});

test('buildInstancePod maps config PVC and shm memory volume', () => {
  const pod = buildInstancePod(inst, cfg);
  const container = pod.spec?.containers?.[0];

  assert.equal(pod.metadata?.name, 'woc-wx-abc123def0');
  assert.equal(pod.spec?.restartPolicy, 'Always');
  assert.equal(container?.name, 'instance');
  assert.equal(container?.image, 'example.com/wechat-on-cloud:1.2.3');
  assert.equal(container?.imagePullPolicy, 'Always');
  assert.equal(container?.ports?.[0]?.containerPort, 3000);
  assert.equal(container?.env?.some((e) => e.name === 'DISABLE_DRI' && e.value === '1'), true);
  assert.equal(container?.env?.some((e) => e.name === 'WOC_APP_TYPE' && e.value === 'chromium'), true);
  assert.equal(container?.resources?.limits?.memory, '2147483648');
  assert.equal(pod.spec?.securityContext?.seccompProfile?.type, 'Unconfined');
  assert.equal(pod.spec?.volumes?.some((v) => v.name === 'config' && v.persistentVolumeClaim?.claimName === 'woc-data-abc123def0'), true);
  assert.equal(pod.spec?.volumes?.some((v) => v.name === 'shm' && v.emptyDir?.medium === 'Memory'), true);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd panel/server
npm test -- src/runtime/kubernetes-manifests.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement manifest builders**

Create `panel/server/src/runtime/kubernetes-manifests.ts`:

```ts
import type * as k8s from '@kubernetes/client-node';
import { instanceAppType, type Instance } from '../store.js';
import type { KubernetesRuntimeConfig } from './kubernetes-config.js';

export const INSTANCE_CONTAINER_NAME = 'instance';

export function instanceLabels(inst: Instance): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'wechat-on-cloud',
    'app.kubernetes.io/component': 'instance',
    'woc.gloridust.io/instance-id': inst.id,
  };
}

function env(name: string, value: string): k8s.V1EnvVar {
  return { name, value };
}

function instanceEnv(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1EnvVar[] {
  const out: k8s.V1EnvVar[] = [
    env('PUID', cfg.puid),
    env('PGID', cfg.pgid),
    env('TZ', cfg.timezone),
    env('CUSTOM_USER', inst.kasmUser),
    env('PASSWORD', inst.kasmPassword),
    env('WOC_SPOOF_OS', cfg.spoofOs ? '1' : '0'),
    env('WOC_APP_TYPE', instanceAppType(inst)),
  ];
  if (!cfg.enableGpu) out.push(env('DISABLE_DRI', '1'));
  if (instanceAppType(inst) === 'custom' && inst.customLaunch) {
    out.push(env('WOC_CUSTOM_LAUNCH', inst.customLaunch));
  }
  return out;
}

export function buildInstancePvc(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: inst.volumeName,
      namespace: cfg.namespace,
      labels: instanceLabels(inst),
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: cfg.storageClassName,
      resources: {
        requests: {
          storage: cfg.storageSize,
        },
      },
    },
  };
}

export function buildInstanceService(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: inst.containerName,
      namespace: cfg.namespace,
      labels: instanceLabels(inst),
    },
    spec: {
      type: 'ClusterIP',
      selector: instanceLabels(inst),
      ports: [
        {
          name: 'http',
          protocol: 'TCP',
          port: 3000,
          targetPort: 3000,
        },
      ],
    },
  };
}

export function buildInstancePod(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1Pod {
  const limits: Record<string, string> = {};
  if (cfg.memoryLimitBytes > 0) limits.memory = String(cfg.memoryLimitBytes);

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: inst.containerName,
      namespace: cfg.namespace,
      labels: instanceLabels(inst),
    },
    spec: {
      restartPolicy: 'Always',
      securityContext: {
        seccompProfile: { type: 'Unconfined' },
      },
      containers: [
        {
          name: INSTANCE_CONTAINER_NAME,
          image: cfg.instanceImage,
          imagePullPolicy: cfg.imagePullPolicy,
          env: instanceEnv(inst, cfg),
          ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
          volumeMounts: [
            { name: 'config', mountPath: '/config' },
            { name: 'shm', mountPath: '/dev/shm' },
          ],
          resources: Object.keys(limits).length ? { limits } : undefined,
        },
      ],
      volumes: [
        { name: 'config', persistentVolumeClaim: { claimName: inst.volumeName } },
        { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
      ],
    },
  };
}
```

- [ ] **Step 4: Run manifest tests**

Run:

```bash
cd panel/server
npm test -- src/runtime/kubernetes-manifests.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/server/src/runtime/kubernetes-manifests.ts panel/server/src/runtime/kubernetes-manifests.test.ts
git commit -m "feat(panel): build kubernetes instance manifests"
```

---

### Task 9: Add Kubernetes Exec and Archive Helpers

**Files:**
- Create: `panel/server/src/runtime/kubernetes-exec.ts`
- Test: `panel/server/src/runtime/kubernetes-exec.test.ts`

- [ ] **Step 1: Write pure helper tests**

Create `panel/server/src/runtime/kubernetes-exec.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeName, safeVolPath, tarSingleFile } from './kubernetes-exec.js';

test('safeName accepts normal basenames', () => {
  assert.equal(safeName('hello.txt'), true);
  assert.equal(safeName('微信 文件.zip'), true);
});

test('safeName rejects traversal and empty names', () => {
  assert.equal(safeName(''), false);
  assert.equal(safeName('../x'), false);
  assert.equal(safeName('a/b'), false);
  assert.equal(safeName('..'), false);
});

test('safeVolPath resolves paths under /config', () => {
  assert.equal(safeVolPath(''), '/config');
  assert.equal(safeVolPath('/Desktop'), '/config/Desktop');
  assert.equal(safeVolPath('a/./b'), '/config/a/b');
});

test('safeVolPath rejects parent traversal', () => {
  assert.throws(() => safeVolPath('../secret'), /路径不合法/);
});

test('tarSingleFile creates a tar archive containing the filename', () => {
  const tar = tarSingleFile('hello.txt', Buffer.from('abc'));
  assert.equal(tar.subarray(0, 9).toString('utf8'), 'hello.txt');
  assert.equal(tar.length % 512, 0);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd panel/server
npm test -- src/runtime/kubernetes-exec.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement exec helpers**

Create `panel/server/src/runtime/kubernetes-exec.ts`:

```ts
import { PassThrough, Writable } from 'node:stream';
import zlib from 'node:zlib';
import * as k8s from '@kubernetes/client-node';
import type { Instance } from '../store.js';
import { INSTANCE_CONTAINER_NAME } from './kubernetes-manifests.js';

export const TRANSFER_DIR = '/config/Desktop';
export const VOL_ROOT = '/config';

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

export function tarSingleFile(name: string, content: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([h, content, Buffer.alloc(pad, 0), Buffer.alloc(1024, 0)]);
}

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
    let exitCode = 0;
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
      inst.containerName,
      INSTANCE_CONTAINER_NAME,
      command,
      stdout,
      stderr,
      input,
      false,
      (status) => {
        exitCode = Number((status as any)?.details?.causes?.find((c: any) => c.reason === 'ExitCode')?.message || 0);
      },
    );
    await new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    if (exitCode !== 0) throw new Error((err || out || `命令执行失败，退出码 ${exitCode}`).trim());
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
    let exitCode = 0;
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        err += Buffer.from(chunk).toString('utf8');
        cb();
      },
    });
    const ws = await this.exec.exec(
      this.namespace,
      inst.containerName,
      INSTANCE_CONTAINER_NAME,
      ['tar', '-cf', '-', path],
      stdout,
      stderr,
      null,
      false,
      (status) => {
        exitCode = Number((status as any)?.details?.causes?.find((c: any) => c.reason === 'ExitCode')?.message || 0);
      },
    );
    await new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    if (exitCode !== 0) throw new Error((err || `tar 读取失败，退出码 ${exitCode}`).trim());
    return Buffer.concat(chunks);
  }
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
cd panel/server
npm test -- src/runtime/kubernetes-exec.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/server/src/runtime/kubernetes-exec.ts panel/server/src/runtime/kubernetes-exec.test.ts
git commit -m "feat(panel): add kubernetes exec archive helpers"
```

---

### Task 10: Implement Kubernetes Runtime Lifecycle

**Files:**
- Create: `panel/server/src/runtime/kubernetes-runtime.ts`
- Test: `panel/server/src/runtime/kubernetes-runtime.test.ts`

- [ ] **Step 1: Write status mapping tests**

Create `panel/server/src/runtime/kubernetes-runtime.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { podPhaseToRuntimeState, isNotFoundError } from './kubernetes-runtime.js';

test('pod phase maps to runtime state', () => {
  assert.equal(podPhaseToRuntimeState('Running'), 'running');
  assert.equal(podPhaseToRuntimeState('Pending'), 'stopped');
  assert.equal(podPhaseToRuntimeState('Succeeded'), 'stopped');
  assert.equal(podPhaseToRuntimeState('Failed'), 'stopped');
  assert.equal(podPhaseToRuntimeState(undefined), 'stopped');
});

test('isNotFoundError recognizes kubernetes 404 shapes', () => {
  assert.equal(isNotFoundError({ response: { statusCode: 404 } }), true);
  assert.equal(isNotFoundError({ statusCode: 404 }), true);
  assert.equal(isNotFoundError({ response: { statusCode: 500 } }), false);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd panel/server
npm test -- src/runtime/kubernetes-runtime.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement lifecycle runtime**

Create `panel/server/src/runtime/kubernetes-runtime.ts` with this structure:

```ts
import http from 'node:http';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import * as k8s from '@kubernetes/client-node';
import { appendInstanceLog, appendPanelLog, deleteInstanceLog, filterSince, readInstanceLog, readPanelLog } from '../logs.js';
import { instanceAppType, type Instance } from '../store.js';
import type { RuntimeDriver, RuntimeState, TransferFile, VolEntry, WechatStatus } from './types.js';
import { loadKubernetesConfig, parseKubernetesRuntimeConfig } from './kubernetes-config.js';
import { buildInstancePod, buildInstancePvc, buildInstanceService } from './kubernetes-manifests.js';
import {
  KubernetesExecHelper,
  TRANSFER_DIR,
  VOL_ROOT,
  extractSingleFileFromTar,
  maybeGunzip,
  relOf,
  safeName,
  safeVolPath,
  tarSingleFile,
} from './kubernetes-exec.js';

const DEFAULT_STATUS: WechatStatus = { phase: 'idle', percent: 0, installed: false, version: '', message: '未安装', updatedAt: 0 };

export function isNotFoundError(e: any): boolean {
  return e?.response?.statusCode === 404 || e?.statusCode === 404 || e?.code === 404;
}

export function podPhaseToRuntimeState(phase: string | undefined): RuntimeState {
  return phase === 'Running' ? 'running' : 'stopped';
}

async function ignoreNotFound(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!isNotFoundError(e)) throw e;
  }
}

export class KubernetesRuntime implements RuntimeDriver {
  readonly kind = 'kubernetes' as const;
  private readonly kubeConfig = loadKubernetesConfig();
  private readonly core = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
  private readonly cfg = parseKubernetesRuntimeConfig();
  private readonly exec = new KubernetesExecHelper(this.kubeConfig, this.cfg.namespace);

  async ensureRuntimeReady(): Promise<void> {
    await this.core.readNamespace({ name: this.cfg.namespace });
  }

  async runInstance(inst: Instance): Promise<void> {
    await this.ensurePvc(inst);
    await this.ensureService(inst);
    await this.deletePod(inst);
    await this.core.createNamespacedPod({ namespace: this.cfg.namespace, body: buildInstancePod(inst, this.cfg) });
    appendInstanceLog(inst.id, 'Pod 已启动');
  }

  async ensureRunning(inst: Instance): Promise<void> {
    try {
      const pod = await this.core.readNamespacedPod({ namespace: this.cfg.namespace, name: inst.containerName });
      if (pod.status?.phase === 'Running' || pod.status?.phase === 'Pending') return;
      await this.runInstance(inst);
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      await this.runInstance(inst);
    }
  }

  async upgradeInstance(inst: Instance): Promise<void> {
    await this.runInstance(inst);
  }

  async regenInstanceMachineId(inst: Instance): Promise<void> {
    await this.exec.execCapture(inst, ['sh', '-c', 'test -f /custom-cont-init.d/00-woc-identity && echo yes || echo no']);
    await this.exec.execCapture(inst, ['sh', '-c', 'rm -f /config/.woc-machine-id']);
    await this.stopInstance(inst);
    await this.runInstance(inst);
  }

  async stopInstance(inst: Instance): Promise<void> {
    await this.deletePod(inst);
    appendInstanceLog(inst.id, 'Pod 已停止');
  }

  async removeInstance(inst: Instance, purgeVolume: boolean): Promise<void> {
    await this.deletePod(inst);
    await ignoreNotFound(() => this.core.deleteNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName }));
    if (purgeVolume) {
      await ignoreNotFound(() => this.core.deleteNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name: inst.volumeName }));
      deleteInstanceLog(inst.id);
    }
  }

  async listOrphanVolumes(referencedVolumes: Set<string>) {
    const pvcs = await this.core.listNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace });
    return (pvcs.items || [])
      .filter((pvc) => pvc.metadata?.name?.startsWith('woc-data-') && !referencedVolumes.has(pvc.metadata.name))
      .map((pvc) => ({
        name: pvc.metadata!.name!,
        createdAt: pvc.metadata?.creationTimestamp ? new Date(pvc.metadata.creationTimestamp).toISOString() : undefined,
      }));
  }

  async removeVolume(name: string): Promise<void> {
    await this.core.deleteNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name });
  }

  async listOrphanContainers(knownContainerNames: Set<string>) {
    const pods = await this.core.listNamespacedPod({ namespace: this.cfg.namespace });
    return (pods.items || [])
      .filter((pod) => pod.metadata?.name?.startsWith('woc-wx-') && !knownContainerNames.has(pod.metadata.name))
      .map((pod) => ({
        id: pod.metadata?.uid || pod.metadata!.name!,
        name: pod.metadata!.name!,
        status: pod.status?.phase || '',
        volumeName: pod.spec?.volumes?.find((v) => v.persistentVolumeClaim?.claimName?.startsWith('woc-data-'))?.persistentVolumeClaim?.claimName,
      }));
  }

  async removeContainerById(idOrName: string): Promise<void> {
    await this.core.deleteNamespacedPod({ namespace: this.cfg.namespace, name: idOrName });
  }

  async instanceMemoryMB(): Promise<number> {
    return 0;
  }

  async instanceHttpHealthy(inst: Instance, timeoutMs = 8000): Promise<boolean> {
    const auth = 'Basic ' + Buffer.from(`${inst.kasmUser}:${inst.kasmPassword}`).toString('base64');
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const req = http.get(
        {
          host: inst.containerName,
          port: 3000,
          path: '/vnc/index.html',
          headers: { authorization: auth },
          timeout: timeoutMs,
        },
        (res) => {
          const ok = !!res.statusCode && res.statusCode < 500;
          res.resume();
          done(ok);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => done(false));
    });
  }

  async instanceRuntime(inst: Instance): Promise<RuntimeState> {
    try {
      const pod = await this.core.readNamespacedPod({ namespace: this.cfg.namespace, name: inst.containerName });
      return podPhaseToRuntimeState(pod.status?.phase);
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      const hasData = await this.hasPvcOrService(inst);
      return hasData ? 'stopped' : 'missing';
    }
  }

  async triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void> {
    const at = instanceAppType(inst);
    const action = cmd === 'update' ? 'update' : 'install';
    await this.exec.execCapture(inst, ['bash', '-c', `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} ${action}; else /woc/wechat-ctl.sh ${action}; fi`]);
  }

  async wechatStatus(inst: Instance): Promise<WechatStatus> {
    try {
      const at = instanceAppType(inst);
      const raw = await this.exec.execCapture(inst, ['bash', '-c', `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} status; else /woc/wechat-ctl.sh status; fi`]);
      return { ...DEFAULT_STATUS, ...JSON.parse(raw.trim()) };
    } catch {
      return DEFAULT_STATUS;
    }
  }

  async buildDiagnostics(instances: Instance[], sinceMs: number, meta: Record<string, string>): Promise<Buffer> {
    const entries: { name: string; content: string | Buffer }[] = [];
    entries.push({ name: 'README.txt', content: `云微 · WechatOnCloud Kubernetes 诊断包\n生成时间: ${new Date().toISOString()}\n` });
    entries.push({ name: 'panel.log', content: filterSince(readPanelLog(), sinceMs) || '（无面板日志）' });
    let system = `runtime: kubernetes\nnamespace: ${this.cfg.namespace}\nimage: ${this.cfg.instanceImage}\n`;
    for (const [k, v] of Object.entries(meta)) system += `${k}: ${v}\n`;
    entries.push({ name: 'system.txt', content: system });
    for (const inst of instances) {
      let text = `实例: ${inst.name}\nID: ${inst.id}\nPod: ${inst.containerName}\n类型: ${instanceAppType(inst)}\nPVC: ${inst.volumeName}\n创建: ${inst.createdAt}\n\n`;
      text += `===== 持久化日志 =====\n${filterSince(readInstanceLog(inst.id), sinceMs) || '（无）'}\n\n`;
      try {
        text += `===== Pod 日志 =====\n${await this.instanceLogs(inst, 300)}\n`;
      } catch (e: any) {
        text += `===== Pod 日志 =====\n获取失败：${e?.message || e}\n`;
      }
      entries.push({ name: `instances/${inst.id}.log`, content: text });
    }
    return buildTarGz(entries);
  }

  async uploadToInstance(inst: Instance, name: string, content: Buffer): Promise<void> {
    if (!safeName(name)) throw new Error('文件名不合法');
    await this.exec.putTar(inst, TRANSFER_DIR, tarSingleFile(name, content));
  }

  async listInstanceFiles(inst: Instance): Promise<TransferFile[]> {
    const out = await this.exec.execCapture(inst, ['sh', '-c', `find ${TRANSFER_DIR} -maxdepth 1 -type f -printf '%f\\t%s\\n' 2>/dev/null`]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [name, size] = line.split('\t');
      return { name, size: Number(size) || 0 };
    });
  }

  async deleteInstanceFile(inst: Instance, name: string): Promise<void> {
    if (!safeName(name)) throw new Error('文件名不合法');
    await this.exec.execCapture(inst, ['rm', '-f', `${TRANSFER_DIR}/${name}`]);
  }

  async downloadFromInstance(inst: Instance, name: string): Promise<Buffer> {
    if (!safeName(name)) throw new Error('文件名不合法');
    return extractSingleFileFromTar(await this.exec.getTar(inst, `${TRANSFER_DIR}/${name}`));
  }

  async instanceLogs(inst: Instance, tail = 600): Promise<string> {
    return await this.core.readNamespacedPodLog({ namespace: this.cfg.namespace, name: inst.containerName, container: 'instance', tailLines: tail });
  }

  async typeInInstance(inst: Instance, text: string): Promise<void> {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const cmd = [
      'set -e',
      'display="${DISPLAY:-}"',
      'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
      'export DISPLAY="${display:-:1}"',
      'command -v xclip >/dev/null 2>&1 || { echo "xclip not installed in instance image" >&2; exit 127; }',
      'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
      `echo '${b64}' | base64 -d | xclip -selection clipboard -i >/dev/null 2>&1`,
      'xdotool key --clearmodifiers ctrl+v',
    ].join('; ');
    await this.exec.execCapture(inst, ['bash', '-c', cmd]);
  }

  async keyInInstance(inst: Instance, key: string): Promise<void> {
    if (!/^[A-Za-z_]{1,20}$/.test(key)) throw new Error('按键名不合法');
    await this.exec.execCapture(inst, ['bash', '-c', `xdotool key --clearmodifiers ${key}`]);
  }

  async listVolume(inst: Instance, rel: string): Promise<{ path: string; entries: VolEntry[] }> {
    const abs = safeVolPath(rel);
    const out = await this.exec.execCapture(inst, ['find', abs, '-maxdepth', '1', '-mindepth', '1', '-printf', '%y\\t%s\\t%T@\\t%f\\n']);
    const entries: VolEntry[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const i1 = line.indexOf('\t');
      const i2 = line.indexOf('\t', i1 + 1);
      const i3 = line.indexOf('\t', i2 + 1);
      if (i1 < 0 || i2 < 0 || i3 < 0) continue;
      const y = line.slice(0, i1);
      entries.push({
        type: y === 'd' ? 'dir' : y === 'f' ? 'file' : y === 'l' ? 'link' : 'other',
        size: Number(line.slice(i1 + 1, i2)) || 0,
        mtime: Math.round(parseFloat(line.slice(i2 + 1, i3)) * 1000) || 0,
        name: line.slice(i3 + 1),
      });
    }
    return { path: relOf(abs), entries };
  }

  async volMkdir(inst: Instance, rel: string): Promise<void> {
    const abs = safeVolPath(rel);
    if (abs === VOL_ROOT) throw new Error('路径不合法');
    await this.exec.execCapture(inst, ['mkdir', '-p', abs]);
  }

  async volMove(inst: Instance, fromRel: string, toRel: string): Promise<void> {
    const from = safeVolPath(fromRel);
    const to = safeVolPath(toRel);
    if (from === VOL_ROOT || to === VOL_ROOT) throw new Error('不能移动数据卷根目录');
    if (from === to) return;
    await this.exec.execCapture(inst, ['mv', '-f', from, to]);
  }

  async volDelete(inst: Instance, rel: string): Promise<void> {
    const abs = safeVolPath(rel);
    if (abs === VOL_ROOT) throw new Error('不能删除数据卷根目录');
    await this.exec.execCapture(inst, ['rm', '-rf', abs]);
  }

  async volUploadFile(inst: Instance, rel: string, name: string, content: Buffer): Promise<void> {
    if (!safeName(name)) throw new Error('文件名不合法');
    await this.exec.putTar(inst, safeVolPath(rel), tarSingleFile(name, content));
  }

  async volExtractArchive(inst: Instance, rel: string, archive: Buffer): Promise<void> {
    await this.exec.putTar(inst, safeVolPath(rel), maybeGunzip(archive));
  }

  async volDownloadFile(inst: Instance, rel: string): Promise<Buffer> {
    const abs = safeVolPath(rel);
    if (abs === VOL_ROOT) throw new Error('不能下载整个根目录，请用整卷备份');
    return extractSingleFileFromTar(await this.exec.getTar(inst, abs));
  }

  async volBackupStream(inst: Instance): Promise<NodeJS.ReadableStream> {
    const tar = await this.exec.getTar(inst, VOL_ROOT);
    return Readable.from(zlib.gzipSync(tar));
  }

  async volRestoreArchive(inst: Instance, archive: Buffer): Promise<void> {
    await this.exec.putTar(inst, '/', maybeGunzip(archive));
  }

  instanceTarget(inst: Instance): string {
    return `http://${inst.containerName}:3000`;
  }

  private async ensurePvc(inst: Instance): Promise<void> {
    try {
      await this.core.readNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name: inst.volumeName });
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      await this.core.createNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, body: buildInstancePvc(inst, this.cfg) });
    }
  }

  private async ensureService(inst: Instance): Promise<void> {
    const body = buildInstanceService(inst, this.cfg);
    try {
      await this.core.readNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName });
      await this.core.replaceNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName, body });
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      await this.core.createNamespacedService({ namespace: this.cfg.namespace, body });
    }
  }

  private async deletePod(inst: Instance): Promise<void> {
    await ignoreNotFound(() => this.core.deleteNamespacedPod({ namespace: this.cfg.namespace, name: inst.containerName, gracePeriodSeconds: 5 }));
  }

  private async hasPvcOrService(inst: Instance): Promise<boolean> {
    try {
      await this.core.readNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name: inst.volumeName });
      return true;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
    try {
      await this.core.readNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName });
      return true;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      return false;
    }
  }
}

function tarEntry(name: string, content: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([h, content, Buffer.alloc(pad, 0)]);
}

function buildTarGz(entries: { name: string; content: string | Buffer }[]): Buffer {
  const parts = entries.map((e) => tarEntry(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8')));
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}

export const kubernetesRuntime = new KubernetesRuntime();
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd panel/server
npm test -- src/runtime/kubernetes-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
cd panel/server
npm run typecheck
```

Expected: PASS. Fix any API method signature mismatches from the installed `@kubernetes/client-node` version by consulting its installed TypeScript declarations in `node_modules/@kubernetes/client-node/dist/`.

- [ ] **Step 6: Commit**

```bash
git add panel/server/src/runtime/kubernetes-runtime.ts panel/server/src/runtime/kubernetes-runtime.test.ts
git commit -m "feat(panel): implement kubernetes runtime lifecycle"
```

---

### Task 11: Select Kubernetes Runtime in Facade

**Files:**
- Modify: `panel/server/src/runtime/index.ts`
- Test: `panel/server/src/runtime/index.test.ts`

- [ ] **Step 1: Extend facade test**

Append to `panel/server/src/runtime/index.test.ts`:

```ts
test('runtime accepts k8s alias', () => {
  assert.equal(runtimeKindFromEnv('k8s'), 'kubernetes');
});
```

- [ ] **Step 2: Modify facade selection**

Update `panel/server/src/runtime/index.ts` imports and selection:

```ts
import type { RuntimeKind } from './types.js';
import { dockerRuntime } from './docker-runtime.js';
import { kubernetesRuntime } from './kubernetes-runtime.js';
```

Replace the `runtime` assignment with:

```ts
export const runtime = selectedKind === 'docker'
  ? dockerRuntime
  : kubernetesRuntime;
```

- [ ] **Step 3: Run tests**

Run:

```bash
cd panel/server
npm test -- src/runtime/index.test.ts src/runtime/kubernetes-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
cd panel/server
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/server/src/runtime/index.ts panel/server/src/runtime/index.test.ts
git commit -m "feat(panel): enable kubernetes runtime selection"
```

---

### Task 12: Make Visible Text Runtime-Aware

**Files:**
- Modify: `panel/server/src/index.ts`
- Modify: `panel/web/src/pages/Admin.tsx`
- Modify: `panel/web/src/api.ts` if response types need label changes

- [ ] **Step 1: Add runtime info endpoint**

In `panel/server/src/index.ts`, import `runtime`:

```ts
import {
  runtime,
  ensureNetwork,
  ensureRunning,
  runInstance,
  stopInstance,
  upgradeInstance,
  removeInstance as removeInstanceContainer,
  instanceRuntime,
  triggerWechat,
  wechatStatus,
  instanceTarget,
  uploadToInstance,
  listInstanceFiles,
  downloadFromInstance,
  deleteInstanceFile,
  instanceLogs,
  buildDiagnostics,
  typeInInstance,
  keyInInstance,
  listOrphanVolumes,
  removeVolume,
  listOrphanContainers,
  removeContainerById,
  instanceMemoryMB,
  instanceHttpHealthy,
  regenInstanceMachineId,
  listVolume,
  volMkdir,
  volMove,
  volDelete,
  volUploadFile,
  volExtractArchive,
  volDownloadFile,
  volBackupStream,
  volRestoreArchive,
} from './runtime/index.js';
```

Add an authenticated endpoint near `/api/version`:

```ts
app.get('/api/runtime', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { runtime: runtime.kind };
});
```

- [ ] **Step 2: Add client API type**

In `panel/web/src/api.ts`, add:

```ts
export function getRuntimeInfo() {
  return req<{ runtime: 'docker' | 'kubernetes' }>('/api/runtime');
}
```

- [ ] **Step 3: Update Admin page labels**

In `panel/web/src/pages/Admin.tsx`, fetch `getRuntimeInfo()` with the other admin data. Use these labels:

```ts
const runtimeLabels = runtimeInfo?.runtime === 'kubernetes'
  ? {
      upgradeHint: '在集群中更新面板 Deployment 镜像；各实例镜像可在「管理 → 升级」单独重建。',
      orphanVolumeTitle: '未登记 PVC',
      orphanContainerTitle: '未登记 Pod',
      orphanContainerHelp: '这些 Pod 存在于 Kubernetes 命名空间中，但不在面板实例登记里。',
    }
  : {
      upgradeHint: '在宿主执行 docker compose pull && docker compose up -d 升级面板；各实例镜像可在「管理 → 升级」单独更新。',
      orphanVolumeTitle: '孤儿数据卷',
      orphanContainerTitle: '残留容器',
      orphanContainerHelp: '这些容器存在于 Docker 中，但不在面板实例登记里。',
    };
```

Replace the visible hardcoded Docker cleanup labels with these runtime labels.

- [ ] **Step 4: Run frontend build**

Run:

```bash
cd panel/web
npm run build
```

Expected: PASS.

- [ ] **Step 5: Run server checks**

Run:

```bash
cd panel/server
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add panel/server/src/index.ts panel/web/src/api.ts panel/web/src/pages/Admin.tsx
git commit -m "feat(panel): expose runtime mode in admin UI"
```

---

### Task 13: Add Kubernetes Manifests

**Files:**
- Create: `k8s/namespace.yaml`
- Create: `k8s/serviceaccount.yaml`
- Create: `k8s/rbac.yaml`
- Create: `k8s/panel-pvc.yaml`
- Create: `k8s/deployment.yaml`
- Create: `k8s/service.yaml`
- Create: `k8s/ingress.example.yaml`
- Create: `k8s/kustomization.yaml`

- [ ] **Step 1: Create namespace**

Create `k8s/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: wechat-on-cloud
```

- [ ] **Step 2: Create service account**

Create `k8s/serviceaccount.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: woc-panel
  namespace: wechat-on-cloud
```

- [ ] **Step 3: Create RBAC**

Create `k8s/rbac.yaml`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: woc-panel
  namespace: wechat-on-cloud
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec", "services", "persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: woc-panel
  namespace: wechat-on-cloud
subjects:
  - kind: ServiceAccount
    name: woc-panel
    namespace: wechat-on-cloud
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: woc-panel
```

- [ ] **Step 4: Create panel data PVC**

Create `k8s/panel-pvc.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: woc-panel-data
  namespace: wechat-on-cloud
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 2Gi
```

- [ ] **Step 5: Create panel Deployment**

Create `k8s/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: woc-panel
  namespace: wechat-on-cloud
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: wechat-on-cloud
      app.kubernetes.io/component: panel
  template:
    metadata:
      labels:
        app.kubernetes.io/name: wechat-on-cloud
        app.kubernetes.io/component: panel
    spec:
      serviceAccountName: woc-panel
      containers:
        - name: panel
          image: docker.io/gloridust/woc-panel:latest
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: PORT
              value: "8080"
            - name: WOC_RUNTIME
              value: kubernetes
            - name: WOC_K8S_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: WOC_WECHAT_IMAGE
              value: docker.io/gloridust/wechat-on-cloud:latest
            - name: PANEL_DATA
              value: /data/accounts.json
            - name: PANEL_ADMIN_USER
              value: admin
            - name: PANEL_ADMIN_PASSWORD
              value: wechat
            - name: TZ
              value: Asia/Shanghai
            - name: PUID
              value: "1000"
            - name: PGID
              value: "1000"
            - name: PANEL_ALLOWED_HOSTS
              value: ""
            - name: WOC_K8S_STORAGE_SIZE
              value: 10Gi
            - name: WOC_K8S_IMAGE_PULL_POLICY
              value: IfNotPresent
          volumeMounts:
            - name: panel-data
              mountPath: /data
      volumes:
        - name: panel-data
          persistentVolumeClaim:
            claimName: woc-panel-data
```

- [ ] **Step 6: Create panel Service**

Create `k8s/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: woc-panel
  namespace: wechat-on-cloud
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: wechat-on-cloud
    app.kubernetes.io/component: panel
  ports:
    - name: http
      port: 8080
      targetPort: 8080
```

- [ ] **Step 7: Create ingress example**

Create `k8s/ingress.example.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: woc-panel
  namespace: wechat-on-cloud
spec:
  rules:
    - host: woc.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: woc-panel
                port:
                  number: 8080
```

- [ ] **Step 8: Create kustomization**

Create `k8s/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - serviceaccount.yaml
  - rbac.yaml
  - panel-pvc.yaml
  - deployment.yaml
  - service.yaml
```

- [ ] **Step 9: Validate manifests client-side**

Run:

```bash
kubectl apply --dry-run=client -k k8s
```

Expected: all resources render without YAML/schema errors.

- [ ] **Step 10: Commit**

```bash
git add k8s
git commit -m "feat(k8s): add panel deployment manifests"
```

---

### Task 14: Add Kubernetes Documentation and Env Reference

**Files:**
- Modify: `.env.example`
- Create: `doc/Kubernetes部署.md`
- Modify: `README.md`
- Modify: `doc/运行原理.md`
- Modify: `doc/部署与运维.md`
- Modify: `doc/数据卷管理.md`

- [ ] **Step 1: Extend `.env.example`**

Add a Kubernetes section after image/runtime config:

```dotenv
# ── 运行时后端 ───────────────────────────────────────────────
# docker      默认。面板挂载 /var/run/docker.sock，按需创建 Docker 容器和命名卷。
# kubernetes  面板运行在 Kubernetes 中，用 ServiceAccount 创建 Pod / PVC / Service。
WOC_RUNTIME=docker

# ── Kubernetes 运行时（仅 WOC_RUNTIME=kubernetes 时生效） ─────
# 留空时面板优先读取当前 Pod 所在 namespace；本地 kubeconfig 调试时默认 default。
WOC_K8S_NAMESPACE=

# 每个实例 PVC 的默认容量。每个实例独立一个 PVC，挂载到实例容器 /config。
WOC_K8S_STORAGE_SIZE=10Gi

# 每个实例 PVC 的 StorageClass。留空使用集群默认 StorageClass。
WOC_K8S_STORAGE_CLASS=

# 实例 Pod 镜像拉取策略：IfNotPresent / Always / Never。
WOC_K8S_IMAGE_PULL_POLICY=IfNotPresent
```

- [ ] **Step 2: Write Kubernetes deployment doc**

Create `doc/Kubernetes部署.md`:

```markdown
# Kubernetes 部署

WechatOnCloud 支持两种运行时：

- `WOC_RUNTIME=docker`：默认模式，面板通过 `/var/run/docker.sock` 创建实例容器。
- `WOC_RUNTIME=kubernetes`：面板通过 Kubernetes API 创建每个实例的 Pod、PVC 和 Service。

## 快速部署

```bash
kubectl apply -k k8s
kubectl -n wechat-on-cloud port-forward svc/woc-panel 8080:8080
```

访问 `http://127.0.0.1:8080`，默认管理员为 `admin / wechat`。生产使用前必须改密码，或者在 `k8s/deployment.yaml` 中修改 `PANEL_ADMIN_PASSWORD` 后再部署。

## 资源模型

面板自身：

- Deployment：`woc-panel`
- Service：`woc-panel`
- PVC：`woc-panel-data`，保存账号、实例登记、日志
- ServiceAccount：`woc-panel`

每个实例：

- Pod：`woc-wx-<id>`
- Service：`woc-wx-<id>`，仅集群内访问，面板反代到 `:3000`
- PVC：`woc-data-<id>`，挂载到实例 `/config`

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WOC_RUNTIME` | `docker` | Kubernetes 部署设为 `kubernetes` |
| `WOC_K8S_NAMESPACE` | 当前 Pod namespace | 面板管理实例资源的 namespace |
| `WOC_WECHAT_IMAGE` | `docker.io/gloridust/wechat-on-cloud:latest` | 实例镜像 |
| `WOC_K8S_STORAGE_SIZE` | `10Gi` | 每个实例 PVC 容量 |
| `WOC_K8S_STORAGE_CLASS` | 空 | 留空使用默认 StorageClass |
| `WOC_K8S_IMAGE_PULL_POLICY` | `IfNotPresent` | 实例 Pod 镜像拉取策略 |
| `PANEL_ALLOWED_HOSTS` | 空 | 使用 Ingress 域名时必须填写对外域名 |

## 限制

- Kubernetes 模式不挂载宿主 `docker.sock`。
- Kubernetes 模式第一版不支持摄像头宿主设备直通。
- 内存 watchdog 在 Kubernetes 模式不依赖 metrics-server；没有 metrics API 时内存值显示为 0，HTTP 响应性自愈仍可使用。
- 实例数据依赖集群 StorageClass。没有默认 StorageClass 时，需要设置 `WOC_K8S_STORAGE_CLASS`。

## 卸载

仅删除面板和运行中实例：

```bash
kubectl delete -k k8s
```

删除后，如果保留了实例 PVC，可用以下命令查看：

```bash
kubectl -n wechat-on-cloud get pvc -l app.kubernetes.io/name=wechat-on-cloud
```
```

- [ ] **Step 3: Update README docs table**

Add this row to the documentation table in `README.md`:

```markdown
| [Kubernetes 部署](doc/Kubernetes部署.md) | 使用 `WOC_RUNTIME=kubernetes` 在集群中运行面板，并由面板创建实例 Pod / PVC / Service |
```

- [ ] **Step 4: Update architecture docs**

In `doc/运行原理.md`, add a subsection after the Docker explanation:

```markdown
## Kubernetes 运行时

默认部署仍是 Docker/Compose。需要集群部署时，可把面板部署进 Kubernetes 并设置 `WOC_RUNTIME=kubernetes`。此时面板不再访问 `docker.sock`，而是使用自己的 ServiceAccount 调 Kubernetes API：

```text
panel Pod ──(Kubernetes API)──▶ Pod / PVC / Service
                                  ├─ woc-wx-<id> Pod：运行 KasmVNC + 应用
                                  ├─ woc-data-<id> PVC：保存 /config
                                  └─ woc-wx-<id> Service：仅集群内访问
```

浏览器仍只访问面板；面板仍负责鉴权、注入 KasmVNC Basic Auth，并反向代理到对应实例。
```

- [ ] **Step 5: Update operations docs**

In `doc/部署与运维.md`, add:

```markdown
## Kubernetes 运维入口

Kubernetes 模式下，面板日志查看：

```bash
kubectl -n wechat-on-cloud logs deploy/woc-panel
```

实例日志查看：

```bash
kubectl -n wechat-on-cloud logs pod/woc-wx-<id> -c instance
```

实例数据查看：

```bash
kubectl -n wechat-on-cloud get pvc woc-data-<id>
```

不要手动删除面板已登记实例的 Pod / Service / PVC；请在面板中启动、停止、删除实例，避免登记状态和集群资源不一致。
```

- [ ] **Step 6: Update data-volume docs**

In `doc/数据卷管理.md`, add:

```markdown
Kubernetes 模式下，实例数据不是 Docker 命名卷，而是同名 PVC：`woc-data-<id>`。面板中的数据卷浏览、上传、备份、恢复仍然操作实例容器内的 `/config`，底层通过 Kubernetes exec 流式读写。
```

- [ ] **Step 7: Run docs grep check**

Run:

```bash
rg -n "Kubernetes|WOC_RUNTIME|WOC_K8S" README.md .env.example doc
```

Expected: all new docs references appear.

- [ ] **Step 8: Commit**

```bash
git add .env.example README.md doc/Kubernetes部署.md doc/运行原理.md doc/部署与运维.md doc/数据卷管理.md
git commit -m "docs: document hybrid kubernetes runtime"
```

---

### Task 15: Local Verification Without a Cluster

**Files:**
- No source edits unless checks expose issues

- [ ] **Step 1: Run all server tests**

Run:

```bash
cd panel/server
npm test
```

Expected: PASS.

- [ ] **Step 2: Run server typecheck**

Run:

```bash
cd panel/server
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run frontend build**

Run:

```bash
cd panel/web
npm run build
```

Expected: PASS.

- [ ] **Step 4: Validate Kubernetes YAML**

Run:

```bash
kubectl apply --dry-run=client -k k8s
```

Expected: PASS.

- [ ] **Step 5: Confirm Docker default remains default**

Run:

```bash
cd panel/server
node --test --import tsx src/runtime/index.test.ts
```

Expected: PASS, including the default-to-docker test.

- [ ] **Step 6: Commit verification fixes if any**

If fixes were needed:

```bash
git add panel k8s README.md doc .env.example
git commit -m "fix: resolve hybrid runtime verification issues"
```

If no fixes were needed, do not create an empty commit.

---

### Task 16: Optional Kind Integration Verification

**Files:**
- No source edits unless checks expose issues

- [ ] **Step 1: Build local images**

Run:

```bash
./scripts/build-local.sh
```

Expected: local `woc-panel` and `wechat-on-cloud` images exist.

- [ ] **Step 2: Create a kind cluster**

Run:

```bash
kind create cluster --name woc-hybrid
```

Expected: cluster is created.

- [ ] **Step 3: Load images into kind**

Run:

```bash
kind load docker-image docker.io/gloridust/woc-panel:latest --name woc-hybrid
kind load docker-image docker.io/gloridust/wechat-on-cloud:latest --name woc-hybrid
```

Expected: both images load.

- [ ] **Step 4: Deploy manifests**

Run:

```bash
kubectl apply -k k8s
kubectl -n wechat-on-cloud rollout status deploy/woc-panel --timeout=180s
```

Expected: deployment rolls out.

- [ ] **Step 5: Port-forward the panel**

Run:

```bash
kubectl -n wechat-on-cloud port-forward svc/woc-panel 18080:8080
```

Expected: `http://127.0.0.1:18080` loads the panel.

- [ ] **Step 6: Create one Chromium instance in the UI**

Expected cluster resources:

```bash
kubectl -n wechat-on-cloud get pod,svc,pvc | rg "woc-wx-|woc-data-"
```

Expected: one `woc-wx-<id>` Pod, one `woc-wx-<id>` Service, and one `woc-data-<id>` PVC.

- [ ] **Step 7: Test desktop proxy**

Open the instance from the UI.

Expected: KasmVNC desktop loads through `/desktop/<id>/...`.

- [ ] **Step 8: Test lifecycle**

In the UI, stop, start, restart, and delete the instance without purge.

Expected:

```bash
kubectl -n wechat-on-cloud get pod,svc,pvc | rg "woc-wx-|woc-data-"
```

After delete without purge: Pod and Service are gone; PVC remains.

- [ ] **Step 9: Clean up kind cluster**

Run:

```bash
kind delete cluster --name woc-hybrid
```

Expected: cluster is removed.

---

## Self-Review Checklist

- Spec coverage: The plan covers runtime selection, Docker preservation, Kubernetes Pod/PVC/Service lifecycle, exec-backed app control, file transfer, volume operations, logs, diagnostics, docs, manifests, and verification.
- Placeholder scan: No task depends on unnamed files or undefined runtime behavior.
- Type consistency: Runtime function names match the existing `index.ts` imports so the route layer can move from Docker to runtime facade with minimal churn.
- Risk notes: Kubernetes client method signatures may differ by installed package version. Task 10 requires typechecking against installed declarations before commit; this keeps the plan grounded in the actual dependency resolution.
