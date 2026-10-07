/**
 * Machine facts over IPC.
 *
 * The renderer is sandboxed and cannot statfs or read os.totalmem, so these go
 * over IPC like the other host bridges.
 *
 * The measuring itself is in machine.ts, which has no electron import, so the
 * first-boot provisioner can use it without dragging Electron in.
 */

import { ipcMain } from 'electron';
import { platform } from 'node:os';

import { measureMachine } from './machine.js';
import type { MachineInfo } from './hardware.js';

export { measureMachine } from './machine.js';

export function registerHardwareHandlers(modelDir: string): void {
  ipcMain.handle('hardware:info', () => measureMachine(modelDir));
}

// sanitizeMachineInfo lives in hardware.ts, not here: the renderer imports it,
// and this module imports electron, so pulling it in would drag the main
// process into the renderer bundle.

/** Platform string, for the onboarding hardware scan's wording. */
export const hostPlatform = (): string => platform();

export type { MachineInfo };
