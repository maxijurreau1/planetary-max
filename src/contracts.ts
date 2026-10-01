export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type UmbrellaMode = 'strict' | 'advisory' | 'off';
export type PlanetaryMode = string;
export type IdentityCurvature = number | JsonObject;

export type LaneRouting = {
  lane?: string;
  allowedLanes?: string[];
  [key: string]: JsonValue | undefined;
};

export type KernelEnvelope = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  identity: string;
  governanceContext: Record<string, unknown>;
  identityCurvature?: IdentityCurvature;
  entropyTick?: number;
  planetaryMode?: PlanetaryMode;
  umbrellaEnforcement?: UmbrellaMode;
  laneRouting?: LaneRouting;
};

export type Bindings = {
  PORTAL_KERNEL: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } };
  MAX_OS_1: { fetch(request: Request): Promise<Response> };
  IDENTITY_JWT_SECRET: string;
  IDENTITY_JWT_ISSUER?: string;
  IDENTITY_JWT_AUDIENCE?: string;
  PLANETARY_MODE?: string;
  UMBRELLA_ENFORCEMENT?: string;
};

export type GovernanceMetadata = {
  mode: UmbrellaMode;
  decision: 'allowed' | 'denied' | 'advisory' | 'bypassed';
  deltas: Array<Record<string, unknown>>;
};

export type KernelLane = {
  name: string;
  result: { results: Array<{ result: { data: Record<string, unknown>; meta: { source: string; governance: UmbrellaMode; planetaryMode?: string } } }> };
};

export type KernelSuccess = {
  ok: true;
  data: Record<string, unknown>;
  lanes: KernelLane[];
  meta: {
    messageId: string;
    type: string;
    umbrella: string;
    identity: { propagated: true };
    governance: GovernanceMetadata;
    identityCurvature: IdentityCurvature;
    entropyTick: number;
    planetaryMode: PlanetaryMode;
    umbrellaEnforcement: UmbrellaMode;
    laneRouting: LaneRouting;
  };
};

export type KernelFailure = {
  ok: false;
  error: { code: string; message: string };
  meta?: { messageId?: string; type?: string; governance?: GovernanceMetadata; planetaryMode?: string; umbrellaEnforcement?: UmbrellaMode };
};

export type KernelResult = KernelSuccess | KernelFailure;
