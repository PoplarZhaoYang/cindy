import type { IpcMainInvokeEvent } from 'electron';
import type { InstalledGhost } from '../../shared/ghost';
import {
  GHOST_COMPOSER_LIST_CHANNEL,
  projectGhostComposerEntries,
} from '../../shared/ghostComposer';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { throwIpcError } from '../utils/ipcValidate';

/** Read-only projection for same-account controllers and trusted local UI. */
export function createGhostComposerListHandler(deps: {
  list: () => InstalledGhost[];
  disabledIds: (workingDir: string) => string[];
}) {
  return (event: IpcMainInvokeEvent, workingDir?: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (context) {
      if (context.channel !== GHOST_COMPOSER_LIST_CHANNEL || context.sharedTask) {
        throwIpcError('PERMISSION_DENIED', 'Plugin catalog requires a same-account controller');
      }
    } else {
      assertTrustedAppRendererEvent(event);
    }
    if (
      workingDir !== undefined &&
      (typeof workingDir !== 'string' || workingDir.length > 32_768 || workingDir.includes('\0'))
    ) {
      throwIpcError('INVALID_PARAMS', 'Invalid working directory');
    }
    return projectGhostComposerEntries(
      deps.list(),
      typeof workingDir === 'string' && workingDir.trim() ? deps.disabledIds(workingDir) : [],
    );
  };
}
