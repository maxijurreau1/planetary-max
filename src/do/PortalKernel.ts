import type { KernelEnvelope, KernelResult, UmbrellaMode } from '../contracts';
import { resolveUmbrellaMode, failureResponse, readKernelResult, resultResponse } from '../kernel-bridge';
import { hydrateContext } from '../lane-execution-context';

type UniverseState = {
  tick: number;
  properties: Record<string, unknown>;
  lastOperation: null | { messageId: string; type: string };
};

type PortalKernelEnv = {
  UMBRELLA_ENFORCEMENT?: string;
  PLANETARY_MODE?: string;
};

export class PortalKernel {
  private state: DurableObjectState;
  private env: PortalKernelEnv;
  private universeState: UniverseState | null = null;
  private entropyTick: number = 0;

  constructor(state: DurableObjectState, env: PortalKernelEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'portal-kernel' });
    }

    if (url.pathname === '/api/kernel/message' && request.method === 'POST') {
      return this.handleKernelMessage(request);
    }

    return failureResponse('NOT_FOUND', 'Route not found', 404);
  }

  private async handleKernelMessage(request: Request): Promise<Response> {
    let envelope: KernelEnvelope;

    try {
      envelope = await request.json();
    } catch {
      return failureResponse('INVALID_JSON', 'Request body must be valid JSON', 400);
    }

    if (!this.isValidEnvelope(envelope)) {
      return failureResponse('INVALID_MESSAGE', 'Envelope must include id, type, payload, identity, and governanceContext', 400);
    }

    // Increment entropy tick per Phase-12 invariant
    this.entropyTick++;
    envelope.entropyTick = this.entropyTick;

    // Propagate planetary mode
    if (!envelope.planetaryMode) {
      envelope.planetaryMode = this.env.PLANETARY_MODE ?? 'default';
    }

    const mode = resolveUmbrellaMode(
      typeof envelope.governanceContext.umbrellaMode === 'string' ? (envelope.governanceContext.umbrellaMode as string) : this.env.UMBRELLA_ENFORCEMENT
    );

    // Check governance denials
    if (envelope.governanceContext.deny === true && mode === 'strict') {
      return failureResponse('FORBIDDEN', 'Operation denied by governance', 403);
    }

    // Hydrate lane execution context for all operations
    const context = hydrateContext(envelope, mode, envelope.planetaryMode, this.entropyTick, this.state.storage ?? {});

    // Handle specific operation types
    if (envelope.type === 'universe.state') {
      return this.handleUniverseState(envelope, mode, context);
    }

    if (envelope.type === 'universe.tick') {
      return this.handleUniverseTick(envelope, mode, context);
    }

    if (envelope.type === 'umbrella.os') {
      return this.handleUmbrellaOS(envelope, mode, context);
    }

    // Check lane access policy
    const allowedLanes = envelope.governanceContext.allowedLanes as string[] | undefined;
    if (allowedLanes && !this.isLaneAllowed(envelope.type, allowedLanes)) {
      return failureResponse('FORBIDDEN', 'Lane access denied', 403);
    }

    // Default operation handler
    const result: KernelResult = {
      ok: true,
      data: {
        kernel: 'Portal-OS Kernel Engine',
        operation: envelope.type,
        accepted: true,
      },
      lanes: [
        {
          name: 'kernel',
          result: {
            results: [
              {
                result: {
                  data: {
                    kernel: 'Portal-OS Kernel Engine',
                    operation: envelope.type,
                    accepted: true,
                  },
                  meta: { source: 'PortalKernel', governance: mode, planetaryMode: context.planetaryMode },
                },
              },
            ],
          },
        },
      ],
      meta: {
        messageId: envelope.id,
        type: envelope.type,
        umbrella: `umbrella.${envelope.type}`,
        identity: { propagated: true },
        governance: {
          mode,
          decision: mode === 'off' ? 'bypassed' : mode === 'advisory' ? 'advisory' : 'allowed',
          deltas: [],
        },
        identityCurvature: context.identityCurvature,
        entropyTick: this.entropyTick,
        planetaryMode: context.planetaryMode,
        umbrellaEnforcement: mode,
        laneRouting: envelope.laneRouting ?? {},
      },
    };

    return resultResponse(result, 200);
  }

  private async handleUniverseState(envelope: KernelEnvelope, mode: UmbrellaMode, context: any): Promise<Response> {
    const state = await this.getUniverseState();

    const result: KernelResult = {
      ok: true,
      data: state,
      lanes: [
        {
          name: 'universe',
          result: {
            results: [
              {
                result: {
                  data: state,
                  meta: { source: 'PortalKernel', governance: mode, planetaryMode: context.planetaryMode },
                },
              },
            ],
          },
        },
      ],
      meta: {
        messageId: envelope.id,
        type: envelope.type,
        umbrella: 'universe-state',
        identity: { propagated: true },
        governance: {
          mode,
          decision: mode === 'off' ? 'bypassed' : mode === 'advisory' ? 'advisory' : 'allowed',
          deltas: [],
        },
        identityCurvature: context.identityCurvature,
        entropyTick: this.entropyTick,
        planetaryMode: context.planetaryMode,
        umbrellaEnforcement: mode,
        laneRouting: envelope.laneRouting ?? {},
      },
    };

    return resultResponse(result, 200);
  }

  private async handleUniverseTick(envelope: KernelEnvelope, mode: UmbrellaMode, context: any): Promise<Response> {
    const state = await this.getUniverseState();

    // Apply changes deterministically
    const changes = envelope.payload.changes as Record<string, unknown> | undefined;
    if (changes && typeof changes === 'object') {
      const sorted = Object.keys(changes).sort();
      for (const key of sorted) {
        const value = changes[key];
        if (typeof value === 'number') {
          const current = typeof state.properties[key] === 'number' ? (state.properties[key] as number) : 0;
          state.properties[key] = current + value;
        }
      }
    }

    state.tick++;
    state.lastOperation = { messageId: envelope.id, type: envelope.type };

    await this.state.storage?.put('universe', state);

    const result: KernelResult = {
      ok: true,
      data: state,
      lanes: [
        {
          name: 'universe',
          result: {
            results: [
              {
                result: {
                  data: state,
                  meta: { source: 'PortalKernel', governance: mode, planetaryMode: context.planetaryMode },
                },
              },
            ],
          },
        },
      ],
      meta: {
        messageId: envelope.id,
        type: envelope.type,
        umbrella: 'universe-tick',
        identity: { propagated: true },
        governance: {
          mode,
          decision: mode === 'off' ? 'bypassed' : mode === 'advisory' ? 'advisory' : 'allowed',
          deltas: [],
        },
        identityCurvature: context.identityCurvature,
        entropyTick: this.entropyTick,
        planetaryMode: context.planetaryMode,
        umbrellaEnforcement: mode,
        laneRouting: envelope.laneRouting ?? {},
      },
    };

    return resultResponse(result, 200);
  }

  private async handleUmbrellaOS(envelope: KernelEnvelope, mode: UmbrellaMode, context: any): Promise<Response> {
    const permissions = envelope.payload.permissions as Record<string, unknown> | undefined;

    const result: KernelResult = {
      ok: true,
      data: {
        osPermissions: permissions ?? {},
        osIdentity: {},
        osGovernanceFlags: {},
        osTruthInvariants: { structuralTruth: true },
      },
      lanes: [
        {
          name: 'umbrella.os',
          result: {
            results: [
              {
                result: {
                  data: {
                    osPermissions: permissions ?? {},
                    osIdentity: {},
                    osGovernanceFlags: {},
                    osTruthInvariants: { structuralTruth: true },
                  },
                  meta: { source: 'PortalKernel', governance: mode, planetaryMode: context.planetaryMode },
                },
              },
            ],
          },
        },
      ],
      meta: {
        messageId: envelope.id,
        type: envelope.type,
        umbrella: 'os-update',
        identity: { propagated: true },
        governance: {
          mode,
          decision: mode === 'off' ? 'bypassed' : mode === 'advisory' ? 'advisory' : 'allowed',
          deltas: [],
        },
        identityCurvature: context.identityCurvature,
        entropyTick: this.entropyTick,
        planetaryMode: context.planetaryMode,
        umbrellaEnforcement: mode,
        laneRouting: envelope.laneRouting ?? {},
      },
    };

    return resultResponse(result, 200);
  }

  private async getUniverseState(): Promise<UniverseState> {
    const stored = await this.state.storage?.get<UniverseState>('universe');
    if (stored) {
      this.universeState = stored;
      return stored;
    }

    this.universeState = {
      tick: 0,
      properties: {},
      lastOperation: null,
    };

    return this.universeState;
  }

  private isValidEnvelope(value: unknown): value is KernelEnvelope {
    if (!this.isRecord(value)) return false;
    return (
      typeof value.id === 'string' &&
      typeof value.type === 'string' &&
      this.isRecord(value.payload) &&
      typeof value.identity === 'string' &&
      this.isRecord(value.governanceContext)
    );
  }

  private isLaneAllowed(type: string, allowedLanes: string[]): boolean {
    const lane = type.includes('.') ? type.substring(0, type.lastIndexOf('.')) : type;
    return allowedLanes.includes(lane);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
