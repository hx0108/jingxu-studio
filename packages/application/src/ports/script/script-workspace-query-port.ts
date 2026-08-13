import type { ScriptVersionDocument, ScriptWorkspaceSnapshot } from './script-types';

/** Bounded, read-only workspace projection; never exposes repositories or persistence handles. */
export interface ScriptWorkspaceQueryPort {
  getWorkspace(projectId: string): Promise<ScriptWorkspaceSnapshot | null>;
  getVersionDocument(projectId: string, versionId: string): Promise<ScriptVersionDocument | null>;
}
