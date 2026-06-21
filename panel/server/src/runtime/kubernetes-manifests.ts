import type * as k8s from '@kubernetes/client-node';
import { instanceAppType, type Instance } from '../store.js';
import { realisticHostname, realisticMac } from '../identity.js';
import type { KubernetesRuntimeConfig } from './kubernetes-config.js';

export const INSTANCE_CONTAINER_NAME = 'instance';

// ── Naming ──────────────────────────────────────────────────────────────────
// One StatefulSet per instance. The StatefulSet, the ClusterIP Service and the PVC keep the existing
// stable names (inst.containerName / inst.volumeName) so the panel proxy target, orphan cleanup and PVC
// reuse all stay byte-for-byte compatible with the previous direct-Pod model. The only thing that moves
// is the *Pod* name: a StatefulSet with replicas=1 always names its pod `${workload}-0`, so every exec /
// log / pod-read MUST target podName(inst), never the workload/Service name.
export const workloadName = (inst: Instance): string => inst.containerName;
export const podName = (inst: Instance): string => `${inst.containerName}-0`;
export const headlessServiceName = (inst: Instance): string => `${inst.containerName}-headless`;

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

// Governing headless Service for the StatefulSet (spec.serviceName). StatefulSet requires a serviceName;
// a headless (clusterIP:None) Service gives the pod its stable per-pod DNS identity without consuming a
// VIP. Browser traffic still goes through the regular ClusterIP Service (buildInstanceService) — this one
// exists only to satisfy the controller and is harmless if the cluster never resolves the per-pod name.
export function buildInstanceHeadlessService(inst: Instance, cfg: KubernetesRuntimeConfig): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: headlessServiceName(inst),
      namespace: cfg.namespace,
      labels: instanceLabels(inst),
    },
    spec: {
      type: 'ClusterIP',
      clusterIP: 'None',
      selector: instanceLabels(inst),
      ports: [{ name: 'http', protocol: 'TCP', port: 3000, targetPort: 3000 }],
    },
  };
}

// The Pod template shared by the StatefulSet. Identical to the old direct-Pod spec body so behavior is
// unchanged; `forcePull` flips the image pull policy to Always for the upgrade path (the StatefulSet uses
// updateStrategy:OnDelete, so a template change only takes effect when the pod is explicitly recreated).
function instancePodSpec(inst: Instance, cfg: KubernetesRuntimeConfig, forcePull: boolean): k8s.V1PodSpec {
  // Always declare modest requests so instances are Burstable rather than BestEffort (first evicted
  // under node memory pressure). A memory limit is added only when WOC_INSTANCE_MEM_GB is set, matching
  // the Docker hard cap; the kubelet then OOM-kills + restarts on overrun.
  const resources: k8s.V1ResourceRequirements = {
    requests: { cpu: '250m', memory: '512Mi' },
  };
  if (cfg.memoryLimitBytes > 0) resources.limits = { memory: String(cfg.memoryLimitBytes) };

  return {
    // Pod templates may only use Always (the default); the StatefulSet itself provides node-level
    // recovery, while Always restarts the container in place on crash — same as the Docker runtime.
    restartPolicy: 'Always',
    // Internal hostname mimics a personal PC (not the woc-wx-<hex> server/container fingerprint),
    // mirroring the Docker runtime's anti-detection hostname. The Service name (containerName) remains
    // the addressable handle and is unaffected.
    hostname: realisticHostname(inst.id),
    imagePullSecrets: cfg.imagePullSecret ? [{ name: cfg.imagePullSecret }] : undefined,
    securityContext: {
      seccompProfile: { type: 'Unconfined' },
    },
    containers: [
      {
        name: INSTANCE_CONTAINER_NAME,
        image: cfg.instanceImage,
        imagePullPolicy: forcePull ? 'Always' : cfg.imagePullPolicy,
        env: instanceEnv(inst, cfg),
        ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
        volumeMounts: [
          { name: 'config', mountPath: '/config' },
          { name: 'shm', mountPath: '/dev/shm' },
        ],
        resources,
        // Gate the Service endpoint on the port actually listening so the reverse proxy does not route
        // to a Pod whose KasmVNC is still starting (which would surface as a transient 502 on rebuild).
        readinessProbe: {
          tcpSocket: { port: 3000 },
          initialDelaySeconds: 10,
          periodSeconds: 10,
          timeoutSeconds: 3,
          failureThreshold: 6,
        },
      },
    ],
    volumes: [
      { name: 'config', persistentVolumeClaim: { claimName: inst.volumeName } },
      { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
    ],
  };
}

// One StatefulSet per instance. Key choices:
//   - replicas encodes runtime state (1 = running, 0 = stopped); the runtime scales it.
//   - updateStrategy:OnDelete makes pod recreation explicit — a template change (new image / MAC / env /
//     Always pull) only takes effect when the runtime deletes pod woc-wx-<id>-0, so restart/upgrade/stop
//     stay deterministic instead of racing the controller's auto-rollout.
//   - the PVC is referenced as a pre-created named volume (NOT volumeClaimTemplates): the app supports
//     reusing an orphan woc-data-<id> PVC by name, which volumeClaimTemplates (config-woc-wx-<id>-0) would
//     break, along with the woc-data- prefix that orphan/reuse logic keys on.
//   - the Cilium MAC annotation lives on the Pod template; it is recreate-only (toggling the flag on a
//     running instance does nothing until the pod is rebuilt).
export function buildInstanceStatefulSet(
  inst: Instance,
  cfg: KubernetesRuntimeConfig,
  replicas: number,
  forcePull = false,
): k8s.V1StatefulSet {
  const annotations = cfg.ciliumMacSpoof ? { 'cni.cilium.io/mac-address': realisticMac(inst.id) } : undefined;
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: inst.containerName,
      namespace: cfg.namespace,
      labels: instanceLabels(inst),
    },
    spec: {
      replicas,
      serviceName: headlessServiceName(inst),
      // selector is immutable after creation; instanceLabels is derived purely from inst.id so it is stable.
      selector: { matchLabels: instanceLabels(inst) },
      updateStrategy: { type: 'OnDelete' },
      template: {
        metadata: {
          labels: instanceLabels(inst),
          ...(annotations ? { annotations } : {}),
        },
        spec: instancePodSpec(inst, cfg, forcePull),
      },
    },
  };
}
