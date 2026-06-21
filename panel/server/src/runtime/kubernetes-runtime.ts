import http from 'node:http';
import zlib from 'node:zlib';
import * as k8s from '@kubernetes/client-node';
import { appendInstanceLog, deleteInstanceLog, filterSince, readInstanceLog, readPanelLog } from '../logs.js';
import { instanceAppType, type Instance } from '../store.js';
import type { RuntimeDriver, RuntimeState, TransferFile, VolEntry, WechatStatus } from './types.js';
import { loadKubernetesConfig, parseKubernetesRuntimeConfig } from './kubernetes-config.js';
import {
  INSTANCE_CONTAINER_NAME,
  buildInstanceHeadlessService,
  buildInstancePvc,
  buildInstanceService,
  buildInstanceStatefulSet,
  headlessServiceName,
  podName,
} from './kubernetes-manifests.js';
import { buildTarGz } from '../tar.js';
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

function isConflictError(e: any): boolean {
  return e?.response?.statusCode === 409 || e?.statusCode === 409 || e?.code === 409;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

function ownedByStatefulSet(pod: k8s.V1Pod): boolean {
  return (pod.metadata?.ownerReferences || []).some((r) => r.kind === 'StatefulSet');
}

// 从命名空间里挑出「未登记的 woc-wx-* 残留工作负载」并转成清理 DTO。两类残留：
//   1) 残留 StatefulSet（旧实例删除时控制器没删干净，或登记丢失）—— id 用 StatefulSet 名（= containerName）。
//      删除必须删 StatefulSet 本体（连带其 Pod/Service），只删 Pod 会被控制器立刻重建。
//   2) 旧版「直连 Pod」（StatefulSet 化之前的运行时遗留的裸 Pod woc-wx-<id>，无 StatefulSet owner）。
// 关键：已登记实例的 Pod 是 woc-wx-<id>-0，由 StatefulSet 持有（ownedByStatefulSet=true），既不会被当作
// 裸 Pod 残留，其工作负载名 woc-wx-<id> 又在 known 集里，故不会被误报为孤儿。
export function selectOrphanWorkloads(
  statefulSets: k8s.V1StatefulSet[],
  pods: k8s.V1Pod[],
  knownContainerNames: Set<string>,
) {
  const out: { id: string; name: string; status: string; volumeName?: string }[] = [];
  const podByName = new Map<string, k8s.V1Pod>();
  for (const pod of pods || []) {
    const n = pod.metadata?.name;
    if (n) podByName.set(n, pod);
  }
  const dataClaim = (volumes: k8s.V1Volume[] | undefined): string | undefined =>
    volumes?.find((v) => v.persistentVolumeClaim?.claimName?.startsWith('woc-data-'))?.persistentVolumeClaim?.claimName;

  for (const ss of statefulSets || []) {
    const name = ss.metadata?.name;
    if (!name || !name.startsWith('woc-wx-') || knownContainerNames.has(name)) continue;
    const pod = podByName.get(`${name}-0`);
    out.push({
      id: name,
      name,
      // No pod when scaled to 0 — report it as Stopped rather than blank so the admin knows it exists.
      status: pod?.status?.phase || ((ss.spec?.replicas ?? 0) === 0 ? 'Stopped' : 'Pending'),
      volumeName: dataClaim(ss.spec?.template?.spec?.volumes) || dataClaim(pod?.spec?.volumes),
    });
  }
  for (const pod of pods || []) {
    const name = pod.metadata?.name;
    if (!name || !name.startsWith('woc-wx-') || knownContainerNames.has(name)) continue;
    // StatefulSet-owned pods are represented by their workload above (or are a registered instance's -0 pod).
    if (ownedByStatefulSet(pod)) continue;
    out.push({
      id: name,
      name,
      status: pod.status?.phase || '',
      volumeName: dataClaim(pod.spec?.volumes),
    });
  }
  return out;
}

// 收集命名空间内任意 Pod（含未登记 / 失败的残留 Pod）实际挂载的 woc-data-* PVC 名。
export function mountedDataPvcNames(pods: k8s.V1Pod[]): Set<string> {
  const names = new Set<string>();
  for (const pod of pods || []) {
    for (const v of pod.spec?.volumes || []) {
      const claim = v.persistentVolumeClaim?.claimName;
      if (claim && claim.startsWith('woc-data-')) names.add(claim);
    }
  }
  return names;
}

// 收集所有 StatefulSet 的 Pod 模板里声明的 woc-data-* PVC 名。补 mountedDataPvcNames 的盲区：
// 已停止（replicas=0，无 Pod）的实例/残留 StatefulSet 仍「拥有」其 PVC，但没有运行 Pod 挂载它——
// 仅看 Pod 会把它误判成孤儿卷而允许删除，删掉就丢了停机实例的聊天数据。
export function templateDataPvcNames(statefulSets: k8s.V1StatefulSet[]): Set<string> {
  const names = new Set<string>();
  for (const ss of statefulSets || []) {
    for (const v of ss.spec?.template?.spec?.volumes || []) {
      const claim = v.persistentVolumeClaim?.claimName;
      if (claim && claim.startsWith('woc-data-')) names.add(claim);
    }
  }
  return names;
}

// 判定「未使用的 woc-data-* PVC」：store 视角 ∪ Pod 视角 ∪ StatefulSet 模板视角。仅看 store/Pod 会把
// 未登记工作负载或停机实例占用的 PVC 误判为孤儿，删除时撞 pvc-protection 卡在 Terminating，或丢数据。
export function selectOrphanVolumes(
  pvcs: k8s.V1PersistentVolumeClaim[],
  pods: k8s.V1Pod[],
  statefulSets: k8s.V1StatefulSet[],
  referencedVolumes: Set<string>,
) {
  const referenced = new Set<string>([
    ...referencedVolumes,
    ...mountedDataPvcNames(pods),
    ...templateDataPvcNames(statefulSets),
  ]);
  return (pvcs || [])
    .filter((pvc) => pvc.metadata?.name?.startsWith('woc-data-') && !referenced.has(pvc.metadata.name))
    .map((pvc) => ({
      name: pvc.metadata!.name!,
      createdAt: pvc.metadata?.creationTimestamp ? new Date(pvc.metadata.creationTimestamp).toISOString() : undefined,
    }));
}

export class KubernetesRuntime implements RuntimeDriver {
  readonly kind = 'kubernetes' as const;
  private readonly cfg = parseKubernetesRuntimeConfig();
  // The Kubernetes client is created lazily so that importing this module in
  // Docker mode (the facade statically imports both runtimes) never loads a
  // kubeconfig or contacts the API server.
  private _kubeConfig?: k8s.KubeConfig;
  private _core?: k8s.CoreV1Api;
  private _apps?: k8s.AppsV1Api;
  private _exec?: KubernetesExecHelper;

  private get kubeConfig(): k8s.KubeConfig {
    return (this._kubeConfig ??= loadKubernetesConfig());
  }

  private get core(): k8s.CoreV1Api {
    return (this._core ??= this.kubeConfig.makeApiClient(k8s.CoreV1Api));
  }

  private get apps(): k8s.AppsV1Api {
    return (this._apps ??= this.kubeConfig.makeApiClient(k8s.AppsV1Api));
  }

  private get exec(): KubernetesExecHelper {
    return (this._exec ??= new KubernetesExecHelper(this.kubeConfig, this.cfg.namespace));
  }

  async ensureRuntimeReady(): Promise<void> {
    // Probe a namespaced resource the panel Role actually grants. (readNamespace would need
    // cluster-scoped get on `namespaces`, which the namespaced Role does not — and cannot — grant,
    // so it would always 403 and the readiness check would be dead.)
    await this.core.listNamespacedPod({ namespace: this.cfg.namespace, limit: 1 });
  }

  // Create or restart the instance running the CURRENT template. Idempotent. `forcePull` (upgrade) flips
  // the image pull policy to Always so a mutable :latest tag is re-fetched. The pod is only force-recreated
  // when one already exists — on first create, or after a scale 0→1, the controller starts a fresh pod from
  // the current template, so no extra restart is needed.
  async runInstance(inst: Instance, forcePull = false): Promise<void> {
    await this.ensurePvc(inst);
    await this.ensureService(inst);
    await this.ensureHeadlessService(inst);
    // Migration: a leftover legacy direct Pod named woc-wx-<id> (pre-StatefulSet runtime) shares this
    // instance's labels, so the Service would load-balance across it AND the StatefulSet pod woc-wx-<id>-0.
    // It has no owner reference, so GC never reaps it — remove it (exact name, never the -0 pod) up front.
    await this.deleteLegacyPod(inst);
    // Wait for the legacy pod to actually disappear so its ReadWriteOnce woc-data-<id> volume detaches
    // before the StatefulSet pod is scheduled; otherwise woc-wx-<id>-0 can stall on a Multi-Attach error
    // if it lands on a different node. Best-effort (returns on timeout); a no-op when no legacy pod exists.
    await this.waitForPodGone(inst.containerName);
    const hadPod = await this.podExists(inst);
    await this.applyStatefulSet(inst, 1, forcePull);
    // updateStrategy:OnDelete means a template change won't auto-roll the pod. If a pod was already running
    // (restart / upgrade), recreate it to pick up the current template; otherwise the just-(re)started pod is
    // already fresh.
    if (hadPod) await this.rollPod(inst);
    appendInstanceLog(inst.id, 'Pod 已启动');
  }

  async ensureRunning(inst: Instance): Promise<void> {
    try {
      const ss = await this.apps.readNamespacedStatefulSet({ namespace: this.cfg.namespace, name: inst.containerName });
      // Already exists: just ensure it is scaled up. Do NOT route through runInstance — that would force a
      // needless pod recreate on a healthy instance. The controller (re)creates the pod from the template.
      if ((ss.spec?.replicas ?? 0) !== 1) {
        await this.scaleStatefulSet(inst, 1);
      }
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      await this.runInstance(inst);
    }
  }

  async upgradeInstance(inst: Instance): Promise<void> {
    // Force a fresh image pull so the Upgrade button is true to its text even with a cached :latest.
    await this.runInstance(inst, true);
  }

  async regenInstanceMachineId(inst: Instance): Promise<void> {
    // Old images lack the identity hook, so a restart would NOT roll a new machine-id — reject loudly
    // instead of silently no-op'ing (parity with the Docker runtime).
    const hasHook = (await this.exec.execCapture(inst, ['sh', '-c', 'test -f /custom-cont-init.d/00-woc-identity && echo yes || echo no'])).trim();
    if (hasHook !== 'yes') {
      throw new Error('该实例运行的是旧镜像（无设备身份模块），请先「升级实例」后再重置设备 ID');
    }
    await this.exec.execCapture(inst, ['sh', '-c', 'rm -f /config/.woc-machine-id']);
    // Recreate pod woc-wx-<id>-0 (OnDelete → controller rebuilds it) so the identity hook rolls a fresh
    // machine-id on boot. Keeps replicas=1, so it is a single in-place restart, not a stop+start.
    await this.rollPod(inst);
  }

  async stopInstance(inst: Instance): Promise<void> {
    // Snapshot the dying pod's last lines BEFORE scaling down — afterwards readNamespacedPodLog returns
    // NotFound and the crash logs are lost.
    await this.snapshotPodLog(inst);
    await ignoreNotFound(() => this.scaleStatefulSet(inst, 0));
    // Scaling is asynchronous; wait until the pod is actually gone so a later restart/instanceRuntime does
    // not race a still-Terminating woc-wx-<id>-0.
    await this.waitForPodGone(podName(inst));
    appendInstanceLog(inst.id, 'Pod 已停止');
  }

  async removeInstance(inst: Instance, purgeVolume: boolean): Promise<void> {
    await this.snapshotPodLog(inst);
    // Delete the StatefulSet FIRST so the controller stops recreating the pod; the cascade removes pod -0.
    await ignoreNotFound(() => this.apps.deleteNamespacedStatefulSet({ namespace: this.cfg.namespace, name: inst.containerName }));
    await this.waitForPodGone(podName(inst));
    await ignoreNotFound(() => this.core.deleteNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName }));
    await ignoreNotFound(() => this.core.deleteNamespacedService({ namespace: this.cfg.namespace, name: headlessServiceName(inst) }));
    // Also clear any legacy direct Pod from the pre-StatefulSet runtime.
    await ignoreNotFound(() => this.core.deleteNamespacedPod({ namespace: this.cfg.namespace, name: inst.containerName, gracePeriodSeconds: 0 }));
    if (purgeVolume) {
      await ignoreNotFound(() => this.core.deleteNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name: inst.volumeName }));
      deleteInstanceLog(inst.id);
    }
  }

  async listOrphanVolumes(referencedVolumes: Set<string>) {
    const [pvcs, pods, sets] = await Promise.all([
      this.core.listNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace }),
      this.core.listNamespacedPod({ namespace: this.cfg.namespace }),
      this.apps.listNamespacedStatefulSet({ namespace: this.cfg.namespace }),
    ]);
    return selectOrphanVolumes(pvcs.items || [], pods.items || [], sets.items || [], referencedVolumes);
  }

  async removeVolume(name: string): Promise<void> {
    await this.core.deleteNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name });
  }

  async listOrphanContainers(knownContainerNames: Set<string>) {
    const [sets, pods] = await Promise.all([
      this.apps.listNamespacedStatefulSet({ namespace: this.cfg.namespace }),
      this.core.listNamespacedPod({ namespace: this.cfg.namespace }),
    ]);
    return selectOrphanWorkloads(sets.items || [], pods.items || [], knownContainerNames);
  }

  async removeContainerById(idOrName: string): Promise<void> {
    // An orphan is either a StatefulSet (delete the controller + its Services, else the pod is recreated)
    // or a legacy bare Pod from the pre-StatefulSet runtime. Probe for a StatefulSet first.
    let isStatefulSet = false;
    try {
      await this.apps.readNamespacedStatefulSet({ namespace: this.cfg.namespace, name: idOrName });
      isStatefulSet = true;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
    if (isStatefulSet) {
      await ignoreNotFound(() => this.apps.deleteNamespacedStatefulSet({ namespace: this.cfg.namespace, name: idOrName }));
      await ignoreNotFound(() => this.core.deleteNamespacedService({ namespace: this.cfg.namespace, name: idOrName }));
      await ignoreNotFound(() => this.core.deleteNamespacedService({ namespace: this.cfg.namespace, name: `${idOrName}-headless` }));
      return;
    }
    // Legacy bare pod. Swallow NotFound (it may have self-terminated since the orphan set was computed) so a
    // successful-in-effect cleanup doesn't surface a 500 — parity with the StatefulSet branch above.
    await ignoreNotFound(() => this.core.deleteNamespacedPod({ namespace: this.cfg.namespace, name: idOrName }));
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
          host: `${inst.containerName}.${this.cfg.namespace}`,
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
      const ss = await this.apps.readNamespacedStatefulSet({ namespace: this.cfg.namespace, name: inst.containerName });
      // replicas=0 is an intentional stop (pod removed); replicas=1 → read the pod's phase.
      if ((ss.spec?.replicas ?? 0) === 0) return 'stopped';
      try {
        const pod = await this.core.readNamespacedPod({ namespace: this.cfg.namespace, name: podName(inst) });
        return podPhaseToRuntimeState(pod.status?.phase);
      } catch (e) {
        if (!isNotFoundError(e)) throw e;
        return 'stopped'; // scaled up but the pod has not appeared yet → not running
      }
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      const hasData = await this.hasPvcOrService(inst);
      return hasData ? 'stopped' : 'missing';
    }
  }

  async triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void> {
    const at = instanceAppType(inst);
    const action = cmd === 'update' ? 'update' : 'install';
    // Docker fires install/update with a detached exec and returns immediately while it runs (the UI
    // polls wechatStatus for progress). Mirror that: background the work with detached stdio and exit
    // the foreground shell so the exec session closes right away, instead of blocking the HTTP request
    // for the whole multi-minute install (which would hang or time out). at/action come from fixed
    // enums, so the interpolation is safe.
    const inner = `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} ${action}; else /woc/wechat-ctl.sh ${action}; fi`;
    await this.exec.execCapture(inst, ['sh', '-c', `nohup sh -c '${inner}' >/dev/null 2>&1 </dev/null & exit 0`]);
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
      let text = `实例: ${inst.name}\nID: ${inst.id}\nStatefulSet: ${inst.containerName}\nPod: ${podName(inst)}\n类型: ${instanceAppType(inst)}\nPVC: ${inst.volumeName}\n创建: ${inst.createdAt}\n\n`;
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
    return await this.core.readNamespacedPodLog({ namespace: this.cfg.namespace, name: podName(inst), container: INSTANCE_CONTAINER_NAME, tailLines: tail, timestamps: true });
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
    // Stream the tar straight through gzip to the HTTP response instead of buffering the whole
    // /config volume (and its gzip) in panel memory — mirrors Docker's getArchive().pipe(createGzip()).
    const tarStream = await this.exec.getTarStream(inst, VOL_ROOT);
    const gzip = zlib.createGzip();
    tarStream.on('error', (e) => gzip.destroy(e));
    return tarStream.pipe(gzip);
  }

  async volRestoreArchive(inst: Instance, archive: Buffer): Promise<void> {
    await this.exec.putTar(inst, '/', maybeGunzip(archive));
  }

  instanceTarget(inst: Instance): string {
    // Namespace-qualify the Service name so the panel reaches instances even when WOC_K8S_NAMESPACE
    // points at a namespace other than the one the panel Pod runs in (a bare short name only resolves
    // within the resolver's own namespace). `<svc>.<ns>` lets the pod's search domains complete it to
    // the full cluster FQDN, so this stays correct regardless of the cluster DNS domain. The Service name
    // is still inst.containerName (unchanged by the StatefulSet migration), so this needs no change.
    return `http://${inst.containerName}.${this.cfg.namespace}:3000`;
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
    try {
      // The selector/ports never change between rebuilds, so an existing Service is left as-is.
      // Replacing it with a fresh body would clear the immutable spec.clusterIP → rejected with 422.
      await this.core.readNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName });
      return;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
    await this.core.createNamespacedService({ namespace: this.cfg.namespace, body: buildInstanceService(inst, this.cfg) });
  }

  private async ensureHeadlessService(inst: Instance): Promise<void> {
    try {
      await this.core.readNamespacedService({ namespace: this.cfg.namespace, name: headlessServiceName(inst) });
      return;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
    await this.core.createNamespacedService({ namespace: this.cfg.namespace, body: buildInstanceHeadlessService(inst, this.cfg) });
  }

  // Read the StatefulSet, build the desired body from it, then replace — retrying on 409 Conflict. The
  // StatefulSet controller bumps resourceVersion via .status writes (readyReplicas/currentRevision/…) during
  // pod create/roll, so a full PUT can lose the optimistic-lock race in the narrow read→replace window; a
  // bounded re-read+retry absorbs it. Read NotFound propagates so callers can distinguish "does not exist".
  private async replaceStatefulSet(
    name: string,
    build: (existing: k8s.V1StatefulSet) => k8s.V1StatefulSet,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const existing = await this.apps.readNamespacedStatefulSet({ namespace: this.cfg.namespace, name });
      const body = build(existing);
      body.metadata = { ...body.metadata, resourceVersion: existing.metadata?.resourceVersion };
      try {
        await this.apps.replaceNamespacedStatefulSet({ namespace: this.cfg.namespace, name, body });
        return;
      } catch (e) {
        if (isConflictError(e) && attempt < 5) {
          await delay(200);
          continue;
        }
        throw e;
      }
    }
  }

  // Create the StatefulSet, or replace an existing one to apply a new template/replicas. Returns true when
  // it was freshly created (no pod existed yet). selector/serviceName are derived deterministically from
  // inst.id and never change, so a replace never hits the immutable-field guard.
  private async applyStatefulSet(inst: Instance, replicas: number, forcePull: boolean): Promise<boolean> {
    try {
      await this.replaceStatefulSet(inst.containerName, () => buildInstanceStatefulSet(inst, this.cfg, replicas, forcePull));
      return false;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      await this.apps.createNamespacedStatefulSet({ namespace: this.cfg.namespace, body: buildInstanceStatefulSet(inst, this.cfg, replicas, forcePull) });
      return true;
    }
  }

  private async scaleStatefulSet(inst: Instance, replicas: number): Promise<void> {
    await this.replaceStatefulSet(inst.containerName, (existing) => {
      if (existing.spec) existing.spec.replicas = replicas;
      return existing;
    });
  }

  // Migration helper: best-effort delete a legacy direct Pod whose name is EXACTLY inst.containerName
  // (no -0 suffix). Never matches the StatefulSet pod woc-wx-<id>-0.
  private async deleteLegacyPod(inst: Instance): Promise<void> {
    await ignoreNotFound(() => this.core.deleteNamespacedPod({ namespace: this.cfg.namespace, name: inst.containerName, gracePeriodSeconds: 0 }));
  }

  private async podExists(inst: Instance): Promise<boolean> {
    try {
      await this.core.readNamespacedPod({ namespace: this.cfg.namespace, name: podName(inst) });
      return true;
    } catch (e) {
      if (isNotFoundError(e)) return false;
      throw e;
    }
  }

  // Force a fresh pod: snapshot the dying pod's logs, then force-delete woc-wx-<id>-0. The OnDelete
  // StatefulSet controller recreates it from the current template. No wait — recreation is the controller's
  // job and the readinessProbe gates the Service endpoint, so traffic only resumes once the new pod is up.
  private async rollPod(inst: Instance): Promise<void> {
    await this.snapshotPodLog(inst);
    await ignoreNotFound(() => this.core.deleteNamespacedPod({ namespace: this.cfg.namespace, name: podName(inst), gracePeriodSeconds: 0 }));
  }

  private async waitForPodGone(name: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.core.readNamespacedPod({ namespace: this.cfg.namespace, name });
      } catch (e) {
        if (isNotFoundError(e)) return;
        throw e;
      }
      if (Date.now() >= deadline) return;
      await delay(300);
    }
  }

  private async snapshotPodLog(inst: Instance): Promise<void> {
    // Persist the dying pod's last lines before a rebuild so "上次为何停/崩" survives (parity with
    // Docker's snapshotContainerLog). Best-effort: on first create / when stopped there is no pod yet.
    try {
      const logs = (await this.instanceLogs(inst, 200)).trimEnd();
      if (logs) {
        appendInstanceLog(inst.id, `──── 容器重建（重启/升级/自愈），保留上一容器最后日志 ────\n${logs}\n──── 上一容器日志快照结束 ────`);
      }
    } catch {
      /* 尚无 Pod（首次创建 / 已停止），忽略 */
    }
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

export const kubernetesRuntime = new KubernetesRuntime();
