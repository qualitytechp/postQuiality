/**
 * Optional modules: features a merchant turns on or off for their business.
 *
 * A module is declared here and nowhere else. The backend gate, the settings
 * allowlist, the `/api/modules` endpoint and the renderer all read this list,
 * so adding one means adding a single entry rather than hunting for scattered
 * `getSettingValue` calls — the mistake `loyalty_enabled` made, where the same
 * flag is re-read in eight files.
 *
 * Modules never require one another. When two are on, the surface that joins
 * them appears; when one goes off, that surface disappears and its rows stay
 * exactly where they were. Turning a module off hides it, it never resolves or
 * deletes anything.
 */

export const OPTIONAL_MODULES = ['purchases', 'receivables'] as const;

export type OptionalModule = typeof OPTIONAL_MODULES[number];

/** Settings key backing each module. */
export const MODULE_SETTING_KEY = {
  purchases: 'purchases_enabled',
  receivables: 'receivables_enabled',
} as const satisfies Record<OptionalModule, string>;

/**
 * Off by default. These are new surfaces: an existing store that upgrades
 * should see exactly what it saw before until someone asks for them.
 */
export const MODULE_DEFAULT = {
  purchases: false,
  receivables: false,
} as const satisfies Record<OptionalModule, boolean>;

export type ModuleStates = Record<OptionalModule, boolean>;

export function isOptionalModule(value: unknown): value is OptionalModule {
  return typeof value === 'string' && (OPTIONAL_MODULES as readonly string[]).includes(value);
}

/** Settings keys the wildcard route and the renderer may write. */
export const MODULE_SETTING_KEYS: readonly string[] =
  OPTIONAL_MODULES.map((module) => MODULE_SETTING_KEY[module]);

/** Every module off — what the renderer assumes until `/api/modules` answers. */
export function allModulesOff(): ModuleStates {
  return Object.fromEntries(OPTIONAL_MODULES.map((module) => [module, false])) as ModuleStates;
}

/** Resolves a stored settings value against the module's default. */
export function moduleEnabledFromSetting(module: OptionalModule, stored: string | null | undefined): boolean {
  if (stored === 'true' || stored === '1') return true;
  if (stored === 'false' || stored === '0') return false;
  return MODULE_DEFAULT[module];
}
