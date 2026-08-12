import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import { BoardStoreError } from "../repositories/board-repository.ts";

export interface FilesystemLocation {
  label: string;
  path: string;
  kind: "current" | "home" | "root" | "drive";
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
}

export interface FilesystemBrowser {
  listLocations(): Promise<FilesystemLocation[]>;
  listDirectories(path: string, showHidden: boolean): Promise<DirectoryListing>;
  validateDirectory(path: string): Promise<string>;
}

export interface NodeFilesystemBrowserOptions {
  defaultDirectory?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export class NodeFilesystemBrowser implements FilesystemBrowser {
  private readonly defaultDirectory: string;
  private readonly homeDirectory: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: NodeFilesystemBrowserOptions = {}) {
    this.defaultDirectory = options.defaultDirectory ?? process.cwd();
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.platform = options.platform ?? process.platform;
  }

  async listLocations(): Promise<FilesystemLocation[]> {
    const current = await this.validateDirectory(this.defaultDirectory);
    const home = await this.validateDirectory(this.homeDirectory);
    const locations: FilesystemLocation[] = [
      { label: "当前工作目录", path: current, kind: "current" },
      { label: "用户目录", path: home, kind: "home" },
    ];

    if (this.platform === "win32") {
      const drives = await availableWindowsDrives();
      for (const drive of drives) {
        if (!locations.some((location) => samePath(location.path, drive, this.platform))) {
          locations.push({ label: drive, path: drive, kind: "drive" });
        }
      }
    } else if (!locations.some((location) => location.path === "/")) {
      locations.push({ label: "根目录", path: "/", kind: "root" });
    }
    return locations;
  }

  async listDirectories(inputPath: string, showHidden: boolean): Promise<DirectoryListing> {
    const canonical = await this.validateDirectory(inputPath);
    let children;
    try {
      children = await readdir(canonical, { withFileTypes: true });
    } catch (err) {
      throw filesystemError(err, `无法读取目录：${canonical}`);
    }

    const entries = (await Promise.all(children.map(async (child): Promise<DirectoryEntry | null> => {
      const hidden = child.name.startsWith(".");
      if (hidden && !showHidden) return null;
      const childPath = join(canonical, child.name);
      if (child.isDirectory()) return { name: child.name, path: childPath, hidden };
      if (!child.isSymbolicLink()) return null;
      try {
        return (await stat(childPath)).isDirectory() ? { name: child.name, path: childPath, hidden } : null;
      } catch {
        return null;
      }
    }))).filter((entry): entry is DirectoryEntry => entry !== null);

    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    const parent = dirname(canonical);
    return { path: canonical, parentPath: samePath(parent, canonical, this.platform) ? null : parent, entries };
  }

  async validateDirectory(inputPath: string): Promise<string> {
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      throw new BoardStoreError("invalid_request", "目录路径不能为空", 400);
    }
    const absolute = resolve(inputPath.trim());
    try {
      const info = await stat(absolute);
      if (!info.isDirectory()) throw new BoardStoreError("invalid_request", `不是目录：${absolute}`, 400);
      return await realpath(absolute);
    } catch (err) {
      if (err instanceof BoardStoreError) throw err;
      throw filesystemError(err, `目录不存在或无法访问：${absolute}`);
    }
  }
}

async function availableWindowsDrives(): Promise<string[]> {
  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const results = await Promise.all(candidates.map(async (drive) => await isDriveAvailable(drive) ? drive : null));
  return results.filter((drive): drive is string => drive !== null);
}

function isDriveAvailable(drive: string): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveAvailability(available);
    };
    const timeout = setTimeout(() => finish(false), 350);
    stat(drive).then((info) => finish(info.isDirectory())).catch(() => finish(false));
  });
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const root = parse(value).root;
    const trimmed = value === root ? value : value.replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.toLocaleLowerCase("en-US") : trimmed;
  };
  return normalize(left) === normalize(right);
}

function filesystemError(err: unknown, message: string): BoardStoreError {
  const code = (err as NodeJS.ErrnoException)?.code;
  const detail = code === "EACCES" || code === "EPERM" ? "（权限不足）" : "";
  return new BoardStoreError("invalid_request", `${message}${detail}`, 400);
}
