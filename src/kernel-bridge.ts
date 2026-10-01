// Phase-12 contract re-exports from unified surface
export type {
  JsonPrimitive,
  JsonValue,
  JsonObject,
  UmbrellaMode,
  PlanetaryMode,
  IdentityCurvature,
  LaneRouting,
  KernelEnvelope,
  Bindings,
  GovernanceMetadata,
  KernelLane,
  KernelSuccess,
  KernelFailure,
  KernelResult,
} from './contracts';

export { hydrateContext } from './lane-execution-context';
export type { LaneExecutionContext } from './lane-execution-context';

import type { KernelEnvelope, KernelResult, UmbrellaMode, Bindings } from './contracts';

const KERNEL_OBJECT_NAME = 'portal-kernel';
const KERNEL_BRIDGE_URL = 'https://portal-kernel.invalid/api/kernel/message';

export function createEnvelope(
  type: string,
  payload: Record<string, unknown>,
  identity: string,
  governanceContext: Record<string, unknown>,
  configuredMode?: string
): KernelEnvelope {
  return {
    id: crypto.randomUUID(),
    type,
    payload,
    identity,
    governanceContext: { ...governanceContext, umbrellaMode: resolveUmbrellaMode(configuredMode) },
  };
}

export async function authenticatedIdentity(
  authorization: string | undefined,
  env: Pick<Bindings, 'IDENTITY_JWT_SECRET' | 'IDENTITY_JWT_ISSUER' | 'IDENTITY_JWT_AUDIENCE'>
): Promise<string | Response> {
  const token = bearerToken(authorization);
  if (!token) return failureResponse('UNAUTHENTICATED', 'Bearer token required', 401);
  if (!env.IDENTITY_JWT_SECRET) return failureResponse('IDENTITY_UNAVAILABLE', 'Identity verification is not configured', 503);
  if (!(await verifyIdentityJwt(token, env))) return failureResponse('UNAUTHENTICATED', 'Bearer token required', 401);
  return token;
}

export async function callKernel(env: Bindings, envelope: KernelEnvelope): Promise<Response> {
  const id = env.PORTAL_KERNEL.idFromName(KERNEL_OBJECT_NAME);
  const kernel = env.PORTAL_KERNEL.get(id);
  return kernel.fetch(
    new Request(KERNEL_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    })
  );
}

export async function readKernelResult(response: Response, envelope: KernelEnvelope, _fallbackSource: string): Promise<KernelResult> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return failureResult('INVALID_KERNEL_RESPONSE', 'Kernel returned invalid JSON', envelope);
  }

  if (!isRecord(value)) return failureResult('INVALID_KERNEL_RESPONSE', 'Kernel returned an invalid result', envelope);

  if (value.ok === false) {
    const error = isRecord(value.error) ? value.error : {};
    return failureResult(
      typeof error.code === 'string' ? error.code : 'KERNEL_ERROR',
      typeof error.message === 'string' ? error.message : 'Kernel request failed',
      envelope
    );
  }

  if (!response.ok) return failureResult('KERNEL_ERROR', 'Kernel request failed', envelope);

  const suppliedMeta = isRecord(value.meta) ? value.meta : {};
  const data = isRecord(value.data) ? value.data : {};

  return {
    ok: true,
    data,
    lanes: Array.isArray(value.lanes) ? (value.lanes as any[]) : [],
    meta: {
      messageId: typeof suppliedMeta.messageId === 'string' ? suppliedMeta.messageId : envelope.id,
      type: typeof suppliedMeta.type === 'string' ? suppliedMeta.type : envelope.type,
      umbrella: typeof suppliedMeta.umbrella === 'string' ? suppliedMeta.umbrella : 'none',
      identity: { propagated: true },
      governance: isGovernanceMetadata(suppliedMeta.governance)
        ? suppliedMeta.governance
        : defaultGovernance(resolveUmbrellaMode(envelope.governanceContext.umbrellaMode as string | undefined)),
      identityCurvature: envelope.identityCurvature ?? { version: 1 },
      entropyTick: envelope.entropyTick ?? 0,
      planetaryMode: envelope.planetaryMode ?? 'default',
      umbrellaEnforcement: resolveUmbrellaMode(envelope.umbrellaEnforcement as string | undefined),
      laneRouting: envelope.laneRouting ?? {},
    },
  };
}

export function resultResponse(result: KernelResult, upstreamStatus: number): Response {
  const status = result.ok
    ? upstreamStatus >= 200 && upstreamStatus < 300
      ? upstreamStatus
      : 200
    : errorStatus(result.error.code, upstreamStatus);
  return Response.json(result, { status });
}

export function failureResponse(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

function failureResult(code: string, message: string, envelope?: KernelEnvelope): any {
  return {
    ok: false,
    error: { code, message },
    ...(envelope
      ? {
          meta: {
            messageId: envelope.id,
            type: envelope.type,
            governance: defaultGovernance(resolveUmbrellaMode(envelope.governanceContext.umbrellaMode as string | undefined)),
            planetaryMode: envelope.planetaryMode ?? 'default',
            umbrellaEnforcement: resolveUmbrellaMode(envelope.umbrellaEnforcement as string | undefined),
          },
        }
      : {}),
  };
}

function errorStatus(code: string, upstreamStatus = 500): number {
  if (code === 'UNAUTHENTICATED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'INVALID_MESSAGE' || code === 'INVALID_JSON') return 400;
  if (code === 'INVALID_KERNEL_RESPONSE') return 502;
  return upstreamStatus >= 400 ? upstreamStatus : 500;
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1]?.trim() || null;
}

async function verifyIdentityJwt(
  token: string,
  env: Pick<Bindings, 'IDENTITY_JWT_SECRET' | 'IDENTITY_JWT_ISSUER' | 'IDENTITY_JWT_AUDIENCE'>
): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (header.alg !== 'HS256' || typeof claims.sub !== 'string' || !claims.sub.trim()) return false;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) return false;
    if (typeof claims.nbf === 'number' && claims.nbf > now) return false;
    if (env.IDENTITY_JWT_ISSUER && claims.iss !== env.IDENTITY_JWT_ISSUER) return false;
    if (env.IDENTITY_JWT_AUDIENCE && !jwtAudienceIncludes(claims.aud, env.IDENTITY_JWT_AUDIENCE)) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.IDENTITY_JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('HMAC', key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

function decodeJwtPart(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  if (!isRecord(decoded)) throw new Error('JWT part is not an object');
  return decoded;
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

function jwtAudienceIncludes(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.some((entry) => entry === expected));
}

export function resolveUmbrellaMode(value: string | undefined): UmbrellaMode {
  return value === 'advisory' || value === 'off' || value === 'strict' ? value : 'strict';
}

function defaultGovernance(mode: UmbrellaMode): any {
  return {
    mode,
    decision: mode === 'off' ? 'bypassed' : mode === 'advisory' ? 'advisory' : 'allowed',
    deltas: [],
  };
}

function isGovernanceMetadata(value: unknown): value is any {
  if (!isRecord(value)) return false;
  return (
    (value.mode === 'strict' || value.mode === 'advisory' || value.mode === 'off') &&
    typeof value.decision === 'string' &&
    Array.isArray(value.deltas)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
