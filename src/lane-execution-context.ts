import type { KernelEnvelope, UmbrellaMode, PlanetaryMode, IdentityCurvature } from './contracts';

/**
 * Phase-12 LaneExecutionContext: Fully hydrated context passed to all kernel lanes.
 * Includes identity curvature, governance, planetary mode, and umbrella enforcement.
 */
export type LaneExecutionContext = {
  identity: string;
  identityCurvature: IdentityCurvature;
  governanceContext: Record<string, unknown>;
  umbrellaMode: UmbrellaMode;
  planetaryMode: PlanetaryMode;
  umbrellaEnforcement: UmbrellaMode;
  entropyTick: number;
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
};

/**
 * Hydrate a LaneExecutionContext from a KernelEnvelope.
 */
export function hydrateContext(
  envelope: KernelEnvelope,
  configuredUmbrellaMode: UmbrellaMode,
  configuredPlanetaryMode: PlanetaryMode,
  entropyTick: number,
  storage: any
): LaneExecutionContext {
  const umbrellaMode = resolveUmbrellaMode(
    typeof envelope.governanceContext.umbrellaMode === 'string'
      ? (envelope.governanceContext.umbrellaMode as string)
      : configuredUmbrellaMode
  );

  return {
    identity: envelope.identity,
    identityCurvature: envelope.identityCurvature ?? { version: 1 },
    governanceContext: envelope.governanceContext ?? {},
    umbrellaMode,
    planetaryMode: envelope.planetaryMode ?? configuredPlanetaryMode,
    umbrellaEnforcement: envelope.umbrellaEnforcement ?? configuredUmbrellaMode,
    entropyTick,
    storage,
  };
}

function resolveUmbrellaMode(value: string | undefined): UmbrellaMode {
  return value === 'advisory' || value === 'off' || value === 'strict' ? value : 'strict';
}
