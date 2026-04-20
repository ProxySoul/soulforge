import { execFile } from "node:child_process";

/** Shared execFile → Promise<stdout> wrapper used by soul tools. */
export function execFileAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, encoding: "utf-8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout as string).trim());
    });
  });
}
