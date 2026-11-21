import type { ReactNode } from 'react';
import { Notice } from './ui/Notice';
import { OPS_MODULES, opsAccess, opsEnabled } from '../lib/operations/ops';
import type { OpsModuleKey, Role, WorkspaceConfig } from '../lib/workspace/types';

/** Shows a clear message instead of the screen when the module is not enabled or the role may not use it. Data is never deleted when a module is disabled. */
export function OpsGate({ module, config, role, children }: { module: OpsModuleKey; config: WorkspaceConfig; role: Role; children: ReactNode }) {
  const m = OPS_MODULES.find(x => x.key === module)!;
  if (!opsEnabled(config, module)) return <Notice title={`${m.label} is not enabled`}>{m.blurb} An owner or admin can enable it in Builder under “Business operations”. Existing data is kept when a module is turned off.</Notice>;
  if (!opsAccess(role, module)) return <Notice title={`${m.label} is limited to owners, admins and managers`}>Ask an owner, admin or manager if you need something from here.</Notice>;
  return <>{children}</>;
}
