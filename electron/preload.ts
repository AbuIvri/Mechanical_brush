import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "../shared/ipc.js";
import type { AutosaveSlot } from "../shared/autosaveSlots.js";
import type {
  BaseGenerationRequest,
  DatasetScan,
  SheetData,
  GenerationResult,
  IpcResult,
  LicenseStatus,
  OriginalRef,
  Project,
  ProviderInfo,
  RecentEntry,
  SpendData,
  ValidationResult,
} from "../shared/types.js";

/** Typed, minimal surface exposed to the renderer. No Node access leaks. */
const api = {
  /** The real path of a file the user dragged in.
   *
   *  Electron 32 removed `File.path`, and this app is on 34: the property a dropped file
   *  used to carry is simply gone, so every drop of a .mbrush read `undefined` and did
   *  nothing at all. `webUtils.getPathForFile` is the replacement, and it has to be called
   *  here — the renderer has no access to it. Returns "" for anything that is not a real
   *  file on disk. */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  listProviders: (): Promise<IpcResult<ProviderInfo[]>> =>
    ipcRenderer.invoke(IPC.listProviders),

  generate: (req: BaseGenerationRequest): Promise<IpcResult<GenerationResult>> =>
    ipcRenderer.invoke(IPC.generate, req),

  keyStatus: (): Promise<IpcResult<{ secure: boolean }>> =>
    ipcRenderer.invoke(IPC.keyStatus),
  keyList: (): Promise<IpcResult<string[]>> => ipcRenderer.invoke(IPC.keyList),
  keyGet: (providerId: string): Promise<IpcResult<{ configured: boolean; hint: string | null }>> =>
    ipcRenderer.invoke(IPC.keyGet, providerId),
  keySet: (providerId: string, key: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.keySet, providerId, key),
  keyRemove: (providerId: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.keyRemove, providerId),
  keyValidate: (providerId: string, key: string): Promise<IpcResult<ValidationResult>> =>
    ipcRenderer.invoke(IPC.keyValidate, providerId, key),
  keyLink: (fromProviderId: string, toProviderId: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.keyLink, fromProviderId, toProviderId),
  chooseDirectory: (): Promise<IpcResult<string | null>> => ipcRenderer.invoke(IPC.chooseDirectory),
  writeImageTo: (dir: string, filename: string, dataUrl: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.writeImageTo, dir, filename, dataUrl),
  writeTextTo: (dir: string, filename: string, text: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.writeTextTo, dir, filename, text),

  // Series: pick a dataset root, scan it, read its sheet and its images.
  datasetPick: (): Promise<IpcResult<string | null>> => ipcRenderer.invoke(IPC.datasetPick),
  datasetScan: (root: string): Promise<IpcResult<DatasetScan>> =>
    ipcRenderer.invoke(IPC.datasetScan, root),
  readSheet: (file: string): Promise<IpcResult<SheetData>> => ipcRenderer.invoke(IPC.readSheet, file),
  readImageFile: (file: string): Promise<IpcResult<{ dataUrl: string; original?: OriginalRef }>> =>
    ipcRenderer.invoke(IPC.readImageFile, file),
  /** Full-resolution originals: register a dropped file, keep a copy of one with no file,
   *  or point a project at a file that moved. */
  originalRegister: (file: string): Promise<IpcResult<OriginalRef>> => ipcRenderer.invoke(IPC.originalRegister, file),
  originalKeep: (dataUrl: string): Promise<IpcResult<OriginalRef>> => ipcRenderer.invoke(IPC.originalKeep, dataUrl),
  originalRelink: (): Promise<IpcResult<OriginalRef | null>> => ipcRenderer.invoke(IPC.originalRelink),

  openImage: (): Promise<IpcResult<{ name: string; dataUrl: string; original?: OriginalRef } | null>> =>
    ipcRenderer.invoke(IPC.openImage),
  pickImages: (): Promise<IpcResult<{ files: { path: string; name: string }[]; skipped: number }>> =>
    ipcRenderer.invoke(IPC.pickImages),
  /** A prompt list dropped on the app: its text, with its folder granted for "@file" references. */
  promptFileOpen: (file: string): Promise<IpcResult<{ path: string; dir: string; text: string }>> =>
    ipcRenderer.invoke(IPC.promptFileOpen, file),
  openAny: (): Promise<
    IpcResult<
      | { kind: "image"; name: string; dataUrl: string; original?: OriginalRef }
      | { kind: "text"; path: string; dir: string; text: string }
      | { kind: "project"; path: string; project: Project }
      | null
    >
  > => ipcRenderer.invoke(IPC.openAny),
  saveProject: (
    project: Project,
    existingPath?: string,
  ): Promise<IpcResult<{ path: string; name: string } | null>> =>
    ipcRenderer.invoke(IPC.saveProject, project, existingPath),
  openProject: (): Promise<IpcResult<{ path: string; project: Project } | null>> =>
    ipcRenderer.invoke(IPC.openProject),
  openProjectPath: (p: string): Promise<IpcResult<{ path: string; project: Project }>> =>
    ipcRenderer.invoke(IPC.openProjectPath, p),
  recentsGet: (): Promise<IpcResult<RecentEntry[]>> => ipcRenderer.invoke(IPC.recentsGet),
  recentsAdd: (entry: {
    path: string;
    name: string;
    thumbnail?: string;
    kind?: "project" | "image";
  }): Promise<IpcResult<RecentEntry[]>> => ipcRenderer.invoke(IPC.recentsAdd, entry),
  /** Open a picture listed in the gallery. Being on the list is the grant of access. */
  recentsOpenImage: (p: string): Promise<IpcResult<{ name: string; dataUrl: string; original?: OriginalRef }>> =>
    ipcRenderer.invoke(IPC.recentsOpenImage, p),
  recentsRemove: (p: string): Promise<IpcResult<RecentEntry[]>> =>
    ipcRenderer.invoke(IPC.recentsRemove, p),
  recentsUpgradeThumbs: (limit?: number): Promise<IpcResult<{ list: RecentEntry[]; changed: boolean; remaining: number }>> =>
    ipcRenderer.invoke(IPC.recentsUpgradeThumbs, limit),
  exportImage: (
    dataUrl: string,
    suggestedName: string,
  ): Promise<IpcResult<{ path: string } | null>> =>
    ipcRenderer.invoke(IPC.exportImage, dataUrl, suggestedName),

  spendGet: (): Promise<IpcResult<SpendData>> => ipcRenderer.invoke(IPC.spendGet),
  spendAdd: (
    amount: number,
    meta?: { providerId?: string; modelId?: string; mode?: string },
  ): Promise<IpcResult<SpendData>> => ipcRenderer.invoke(IPC.spendAdd, amount, meta),

  appInfo: (): Promise<IpcResult<{ version: string; platform: string }>> =>
    ipcRenderer.invoke(IPC.appInfo),

  getPendingFile: (): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke(IPC.getPendingFile),
  onOpenProjectFile: (cb: (path: string) => void) => {
    const handler = (_e: unknown, p: string) => cb(p);
    ipcRenderer.on(IPC.openFileFromOS, handler);
    return () => {
      ipcRenderer.removeListener(IPC.openFileFromOS, handler);
    };
  },
  openExternal: (url: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.openExternal, url),
  submitFeedback: (payload: {
    message: string;
    email?: string;
    version?: string;
    platform?: string;
  }): Promise<IpcResult<boolean>> => ipcRenderer.invoke(IPC.submitFeedback, payload),

  copyImage: (dataUrl: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.copyImage, dataUrl),

  /** `docId` names the document's own recovery slot. */
  autosaveWrite: (project: Project, originalPath: string | null, docId?: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.autosaveWrite, project, originalPath, docId),
  /** Every recovery slot left on disk, newest first. */
  autosaveList: (): Promise<IpcResult<AutosaveSlot[]>> => ipcRenderer.invoke(IPC.autosaveList),
  autosaveCheck: (): Promise<IpcResult<{ name: string; originalPath: string | null; savedAt: number } | null>> =>
    ipcRenderer.invoke(IPC.autosaveCheck),
  autosaveLoad: (slotId?: string): Promise<IpcResult<{ project: Project; originalPath: string | null }>> =>
    ipcRenderer.invoke(IPC.autosaveLoad, slotId),
  /** One slot, or all of them when no id is given. */
  autosaveClear: (slotId?: string, discarded?: boolean): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke(IPC.autosaveClear, slotId, discarded),
  /** Tell the main process how many open documents have unsaved work, so closing the
   *  window can ask first. One way; nothing comes back. */
  setUnsaved: (count: number): void => ipcRenderer.send(IPC.unsavedCount, count),

  chatSend: (payload: {
    provider: "openai" | "google" | "xai" | "anthropic";
    model: string;
    system: string;
    history: { role: "user" | "assistant"; text: string }[];
    images?: string[];
  }): Promise<IpcResult<string>> => ipcRenderer.invoke(IPC.chat, payload),

  licenseStatus: (): Promise<IpcResult<LicenseStatus>> => ipcRenderer.invoke(IPC.licenseStatus),
  licenseActivate: (code: string): Promise<IpcResult<LicenseStatus>> =>
    ipcRenderer.invoke(IPC.licenseActivate, code),
};

contextBridge.exposeInMainWorld("mbrush", api);

export type MBrushApi = typeof api;
