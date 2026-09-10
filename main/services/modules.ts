/**
 * Runtime gate for optional modules.
 *
 * The check runs per request rather than at mount time so a merchant can turn a
 * module on in Settings and use it without restarting the app. Routes are
 * always mounted; this middleware decides whether they answer.
 */
import { Request, Response, NextFunction } from 'express';
import {
  MODULE_SETTING_KEY,
  OPTIONAL_MODULES,
  ModuleStates,
  OptionalModule,
  moduleEnabledFromSetting,
} from '../../shared/modules';
import { getSettingValue } from '../db';

export function isModuleEnabled(module: OptionalModule): boolean {
  return moduleEnabledFromSetting(module, getSettingValue(MODULE_SETTING_KEY[module]));
}

export function getModuleStates(): ModuleStates {
  return Object.fromEntries(
    OPTIONAL_MODULES.map((module) => [module, isModuleEnabled(module)]),
  ) as ModuleStates;
}

/**
 * Blocks a module's routes while it is off. Answers 403 with the module name so
 * the renderer can tell "turned off" apart from "route does not exist" and show
 * the merchant a way to enable it, instead of a generic failure.
 */
export function requireModule(module: OptionalModule) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!isModuleEnabled(module)) {
      return res.status(403).json({
        error: 'Module is disabled for this business',
        module,
        enabled: false,
      });
    }
    next();
  };
}
