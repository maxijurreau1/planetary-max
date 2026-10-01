import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { attachIntrospectionRoutes } from './introspection';

// Phase-12 Public API - Re-export all contract types
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

export {
  createEnvelope,
  authenticatedIdentity,
  callKernel,
  readKernelResult,
  resultResponse,
  failureResponse,
  resolveUmbrellaMode,
} from './kernel-bridge';

export { PortalKernel } from './do/PortalKernel';
export { KernelService } from './kernel-service';

import type { Bindings, KernelEnvelope, KernelResult, UmbrellaMode } from './contracts';
import { createEnvelope, authenticatedIdentity, callKernel, readKernelResult, resultResponse, failureResponse, resolveUmbrellaMode } from './kernel-bridge';

const KERNEL_OBJECT_NAME = 'portal-kernel';
const KERNEL_BRIDGE_URL = 'https://portal-kernel.invalid/api/kernel/message';
const MAX_OS_BRIDGE_URL = 'https://max-os-1.invalid/kernel/message';

const UNIVERSE_STATE_KEY = 'universe';
const INTROSPECTION_PREFIX = 'introspection.';

const UMBRELLA_OPERATIONS: Record<string, string> = {
  '/umbrella/identity/license': 'identity.physics.license',
  '/umbrella/governance/license': 'governance.engine.license',
  '/umbrella/apex/advisory': 'apex.alignment.advisory',
  '/umbrella/sim/pack': 'umbrella.sim.pack',
  '/umbrella/market/forecast': 'umbrella.market.forecast',
  '/umbrella/identity/mirror': 'umbrella.identity.mirror',
  '/umbrella/crossworld/access': 'umbrella.crossworld.access',
  '/umbrella/structural/truth/license': 'structural.truth.license'
};

export const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'OPTIONS']
}));

app.get('/', (c) =>
  c.json({
    status: 'Portal-OS live',
    worker: 'planetary-max',
    mode: c.env.PLANETARY_MODE ?? 'single',
    umbrella: resolveUmbrellaMode(c.env.UMBRELLA_ENFORCEMENT)
  })
);

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'planetary-max',
    umbrella: resolveUmbrellaMode(c.env.UMBRELLA_ENFORCEMENT)
  })
);

app.post('/api/kernel/message', async (c) => {
  const value = await parseEnvelope(c.req.raw, c.req.header('Authorization'), c.env);
  return value instanceof Response ? value : kernelResponse(c.env, value);
});

app.get('/api/autonomy', (c) =>
  routeKernelMessage(c.env, c.req.header('Authorization'), 'autonomy.state', {})
);

app.get('/universe/state', (c) =>
  routeKernelMessage(c.env, c.req.header('Authorization'), 'universe.state', {})
);

app.get('/universe/umbrella', (c) =>
  routeKernelMessage(c.env, c.req.header('Authorization'), 'universe.umbrella', {})
);

for (const [path, type] of Object.entries(UMBRELLA_OPERATIONS)) {
  app.post(path, async (c) => {
    const value = await parsePayload(c.req.raw, c.req.header('Authorization'), c.env);
    return value instanceof Response
      ? value
      : kernelResponse(
          c.env,
          createEnvelope(type, value.payload, value.identity, value.governanceContext, c.env.UMBRELLA_ENFORCEMENT)
        );
  });
}

app.post('/universe/tick', async (c) => {
  const value = await parsePayload(c.req.raw, c.req.header('Authorization'), c.env, true);
  return value instanceof Response
    ? value
    : kernelResponse(
        c.env,
        createEnvelope('universe.tick', value.payload, value.identity, value.governanceContext, c.env.UMBRELLA_ENFORCEMENT)
      );
});

app.post('/os/kernel/message', async (c) => {
  const parsed = await parseEnvelope(c.req.raw, c.req.header('Authorization'), c.env);
  if (parsed instanceof Response) return parsed;

  try {
    const preflight = {
      ...parsed,
      type: 'umbrella.os',
      payload: { ...parsed.payload, operation: parsed.type }
    };

    const governed = await callKernel(c.env, preflight);
    const checked = await readKernelResult(governed, preflight, 'PortalKernel');

    if (!checked.ok) return resultResponse(checked, governed.status);

    const response = await c.env.MAX_OS_1.fetch(
      new Request(MAX_OS_BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      })
    );

    return resultResponse(await readKernelResult(response, parsed, 'MAX-OS-1'), response.status);
  } catch {
    return failureResponse('MAX_OS_UNAVAILABLE', 'MAX-OS-1 bridge unavailable', 503);
  }
});

attachIntrospectionRoutes(app);

async function routeKernelMessage(
  env: Bindings,
  authorization: string | undefined,
  type: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const identity = await authenticatedIdentity(authorization, env);
  return identity instanceof Response
    ? identity
    : kernelResponse(
        env,
        createEnvelope(type, payload, identity, { surface: 'worker-api' }, env.UMBRELLA_ENFORCEMENT)
      );
}

async function parseEnvelope(
  request: Request,
  authorization: string | undefined,
  env: Bindings
): Promise<KernelEnvelope | Response> {
  const identity = await authenticatedIdentity(authorization, env);
  if (identity instanceof Response) return identity;

  const body = await readJsonObject(request, 'Request body must be JSON');
  if (body instanceof Response) return body;

  if (
    typeof body.type !== 'string' ||
    !body.type.trim() ||
    (body.payload !== undefined && !isRecord(body.payload))
  ) {
    return failureResponse('INVALID_MESSAGE', 'type and object payload are required', 400);
  }

  return createEnvelope(
    body.type,
    body.payload ?? {},
    identity,
    isRecord(body.governanceContext) ? body.governanceContext : {},
    env.UMBRELLA_ENFORCEMENT
  );
}

async function parsePayload(
  request: Request,
  authorization: string | undefined,
  env: Bindings,
  optionalBody = false
): Promise<{ identity: string; payload: Record<string, unknown>; governanceContext: Record<string, unknown> } | Response> {
  const identity = await authenticatedIdentity(authorization, env);
  if (identity instanceof Response) return identity;

  if (optionalBody && !request.headers.get('Content-Type')?.includes('application/json')) {
    return { identity, payload: {}, governanceContext: {} };
  }

  const body = await readJsonObject(request, 'Request body must be JSON');
  if (body instanceof Response) return body;

  const governanceContext = isRecord(body.governanceContext) ? body.governanceContext : {};
  const { governanceContext: _ignored, ...payload } = body;

  return { identity, payload, governanceContext };
}

async function readJsonObject(
  request: Request,
  message: string
): Promise<Record<string, unknown> | Response> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : failureResponse('INVALID_JSON', message, 400);
  } catch {
    return failureResponse('INVALID_JSON', message, 400);
  }
}

async function kernelResponse(env: Bindings, envelope: KernelEnvelope): Promise<Response> {
  try {
    const response = await callKernel(env, envelope);
    return resultResponse(await readKernelResult(response, envelope, 'PortalKernel'), response.status);
  } catch {
    return failureResponse('KERNEL_UNAVAILABLE', 'Kernel bridge unavailable', 503);
  }
}

export function extractLaneData(lanes: any[]): Record<string, unknown> {
  return lanes[0]?.result.results[0]?.result.data ?? {};
}

function laneForType(type: string): string {
  const idx = type.lastIndexOf('.');
  return idx >= 0 ? type.slice(0, idx) : type;
}

function makeLane(
  name: string,
  data: Record<string, unknown>,
  source: string,
  mode: UmbrellaMode
): any {
  return {
    name,
    result: {
      results: [
        {
          result: {
            data,
            meta: { source, governance: mode }
          }
        }
      ]
    }
  };
}

function umbrellaUpdateName(type: string): string {
  return type.startsWith('umbrella.') ? type : `umbrella.${type}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
