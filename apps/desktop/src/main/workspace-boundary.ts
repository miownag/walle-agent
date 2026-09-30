import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

export class WorkspaceBoundary {
  private constructor(readonly root: string) {}

  static async create(workspaceRoot: string): Promise<WorkspaceBoundary> {
    if (!isAbsolute(workspaceRoot))
      throw new Error("Workspace root must be an absolute path");
    const root = await realpath(workspaceRoot);
    const info = await stat(root);
    if (!info.isDirectory())
      throw new Error("Workspace root must be a directory");
    return new WorkspaceBoundary(root);
  }

  async resolveExisting(relativePath = ""): Promise<string> {
    if (isAbsolute(relativePath))
      throw new Error("Workspace paths must be relative");
    const lexical = resolve(this.root, relativePath || ".");
    if (!inside(this.root, lexical))
      throw new Error("Path escapes the workspace root");
    const target = await realpath(lexical);
    if (!inside(this.root, target))
      throw new Error("Path resolves outside the workspace root");
    return target;
  }

  async assertDirectory(relativePath = ""): Promise<string> {
    const target = await this.resolveExisting(relativePath);
    if (!(await stat(target)).isDirectory())
      throw new Error("Path is not a directory");
    return target;
  }

  async assertFile(relativePath: string): Promise<string> {
    if (!relativePath) throw new Error("File path is required");
    const target = await this.resolveExisting(relativePath);
    if (!(await stat(target)).isFile())
      throw new Error("Path is not a regular file");
    return target;
  }

  async describeEntry(
    path: string,
  ): Promise<Awaited<ReturnType<typeof lstat>>> {
    const lexical = resolve(path);
    if (!inside(this.root, lexical))
      throw new Error("Entry escapes the workspace root");
    return lstat(lexical);
  }

  relative(target: string): string {
    if (!inside(this.root, target))
      throw new Error("Path escapes the workspace root");
    return relative(this.root, target);
  }

  contains(target: string): boolean {
    return inside(this.root, resolve(target));
  }
}
