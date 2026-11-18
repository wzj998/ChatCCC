import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { artifactToolArgument, isOmittedToolArgument } from "./tool-argument-replay.js";

/** Matches the file tool's single-read byte limit; larger values keep the unavailable fallback. */
export const MAX_TOOL_ARGUMENT_ARTIFACT_BYTES = 1024 * 1024;

export class ToolArgumentArtifactStore {
  readonly directory: string;
  private readonly sessionDirectory: string;
  constructor(sessionDirectory: string) {
    this.sessionDirectory = resolve(sessionDirectory);
    this.directory = join(this.sessionDirectory, "tool-arguments");
  }

  preserve(text: string): string | undefined {
    if (isOmittedToolArgument(text)) return undefined;
    if (Buffer.byteLength(text, "utf8") > MAX_TOOL_ARGUMENT_ARTIFACT_BYTES) return undefined;
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    const filename = digest+".txt";
    try {
      mkdirSync(this.directory, {recursive:true,mode:0o700});
      try { writeFileSync(join(this.directory, filename), text, {encoding:"utf8",flag:"wx",mode:0o600}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (createHash("sha256").update(readFileSync(join(this.directory,filename))).digest("hex") !== digest) {
        throw Object.assign(new Error("stored argument hash mismatch"), {code:"ARGUMENT_ARTIFACT_HASH_MISMATCH"});
      }
      return artifactToolArgument(filename);
    } catch (error) {
      // Never advertise a nonexistent/corrupted artifact or echo the input value.
      console.warn(`[DeepCCC] tool argument artifact unavailable (${(error as NodeJS.ErrnoException).code ?? "storage error"}); retaining unavailable-argument fallback`);
      return undefined;
    }
  }

  clear(): void {
    // Only the literal owned child of this normalized session directory is removed.
    const target = resolve(this.directory);
    if (dirname(target) !== this.sessionDirectory || basename(target) !== "tool-arguments") {
      throw new Error("Invalid tool argument artifact cleanup target");
    }
    rmSync(target, {recursive:true,force:true});
  }
}

/** Resolve the expected content hash only inside this session's managed directory. */
export function expectedToolArgumentArtifactHash(directory: string | undefined, filePath: string): string | undefined {
  if (!directory) return undefined;
  const key = (value:string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  if (key(dirname(filePath)) !== key(directory)) return undefined;
  return basename(filePath).match(/^([a-f0-9]{64})\.txt$/i)?.[1].toLowerCase();
}
