import type { PathLike } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  discoverDocs,
  findPiVersion,
  resolveAgentDir,
  type ExecFileImpl,
  type FsImpl,
} from "../../src/core/discovery";

/**
 * Hand-rolled fsImpl fake (deliberately memfs-free): a flat list of existing
 * file paths, comparable with `/` or `\` separators. The readdirSync cast is
 * needed because node's real one is a five-overload family that a plain
 * `(path) => string[]` fake cannot structurally satisfy.
 */
function fsFake(files: string[]): FsImpl {
  const canon = (p: unknown): string =>
    String(p).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const fileSet = new Set(files.map(canon));
  const dirSet = new Set<string>();
  for (const file of fileSet) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      dirSet.add(parts.slice(0, i).join("/"));
    }
  }
  return {
    existsSync: (p: PathLike) => {
      const c = canon(p);
      return fileSet.has(c) || dirSet.has(c);
    },
    readdirSync: ((p: PathLike) => {
      const c = canon(p);
      const prefix = `${c}/`;
      const names: string[] = [];
      for (const file of fileSet) {
        if (file.startsWith(prefix)) {
          const rest = file.slice(prefix.length);
          if (!rest.includes("/")) names.push(rest);
        }
      }
      return names;
    }) as unknown as FsImpl["readdirSync"],
  };
}

const LINUX_ENV = { HOME: "/home/me" };

describe("core/discovery", () => {
  describe("resolveAgentDir", () => {
    it("resolveAgentDir_onWindows_withUserProfile_shouldUseUserProfileDotPiAgent", () => {
      expect(resolveAgentDir("win32", { USERPROFILE: "C:\\Users\\me" })).toBe(
        "C:\\Users\\me\\.pi\\agent",
      );
    });

    it("resolveAgentDir_onPosix_withPiCodingAgentDir_shouldPreferEnvOverHome", () => {
      expect(
        resolveAgentDir("linux", {
          PI_CODING_AGENT_DIR: "/opt/pi-agent",
          HOME: "/home/me",
        }),
      ).toBe("/opt/pi-agent");
    });

    it("resolveAgentDir_withFlag_shouldWinOverEnvAndHomeVerbatim", () => {
      expect(
        resolveAgentDir(
          "linux",
          { PI_CODING_AGENT_DIR: "/opt/pi-agent", HOME: "/home/me" },
          "/flag/agent dir",
        ),
      ).toBe("/flag/agent dir");
    });

    it("resolveAgentDir_onPosix_withHome_shouldUseHomeDotPiAgent", () => {
      expect(resolveAgentDir("darwin", LINUX_ENV)).toBe("/home/me/.pi/agent");
    });

    it("resolveAgentDir_withoutAnyHome_shouldAnchorAtLiteralTilde", () => {
      expect(resolveAgentDir("linux", {})).toBe("~/.pi/agent");
      expect(resolveAgentDir("win32", {})).toBe("~\\.pi\\agent");
    });
  });

  describe("discoverDocs", () => {
    it("discoverDocs_withOnlySettingsFile_shouldListModelsAndAuthAbsentThenSettings", () => {
      const result = discoverDocs({
        platform: "linux",
        env: LINUX_ENV,
        agentDir: "/agent",
        fsImpl: fsFake(["/agent/settings.json"]),
      });

      expect(result.agentDir).toBe("/agent");
      expect(result.docs).toEqual([
        {
          id: "models",
          path: "/agent/models.json",
          kind: "models",
          editable: true,
          exists: false,
        },
        {
          id: "auth",
          path: "/agent/auth.json",
          kind: "auth",
          editable: true,
          exists: false,
        },
        {
          id: "settings",
          path: "/agent/settings.json",
          kind: "other",
          editable: false,
          exists: true,
        },
      ]);
    });

    it("discoverDocs_withEveryDocumentPresent_shouldReportFixedOrder", () => {
      const result = discoverDocs({
        platform: "linux",
        env: LINUX_ENV,
        agentDir: "/agent",
        fsImpl: fsFake([
          "/agent/keybindings.json",
          "/agent/auth.json",
          "/agent/mcp.json",
          "/agent/settings.json",
          "/agent/models.json",
        ]),
      });

      expect(result.docs.map((doc) => doc.id)).toEqual([
        "models",
        "auth",
        "settings",
        "mcp",
        "keybindings",
      ]);
      expect(result.docs.map((doc) => doc.editable)).toEqual([true, true, false, false, false]);
      expect(result.docs.every((doc) => doc.exists)).toBe(true);
    });

    it("discoverDocs_withoutAgentDirInput_shouldResolveFromPlatformAndEnv", () => {
      const result = discoverDocs({
        platform: "win32",
        env: { PI_CODING_AGENT_DIR: "D:\\pi\\agent" },
        fsImpl: fsFake(["D:\\pi\\agent\\models.json"]),
      });

      expect(result.agentDir).toBe("D:\\pi\\agent");
      expect(result.docs).toEqual([
        {
          id: "models",
          path: "D:\\pi\\agent\\models.json",
          kind: "models",
          editable: true,
          exists: true,
        },
        {
          id: "auth",
          path: "D:\\pi\\agent\\auth.json",
          kind: "auth",
          editable: true,
          exists: false,
        },
      ]);
    });

    it("discoverDocs_onUnreadableAgentDir_shouldDegradeWithoutThrowing", () => {
      // A permission-blown readdir must degrade to "nothing present", never throw.
      const broken: FsImpl = {
        existsSync: () => true,
        readdirSync: (() => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }) as unknown as FsImpl["readdirSync"],
      };

      const result = discoverDocs({
        platform: "linux",
        env: LINUX_ENV,
        agentDir: "/agent",
        fsImpl: broken,
      });

      expect(result.docs.map((doc) => [doc.id, doc.exists])).toEqual([
        ["models", false],
        ["auth", false],
      ]);
    });
  });

  describe("findPiVersion", () => {
    it("findPiVersion_withVersionOutput_shouldRunBoundedAndReturnParsedVersion", async () => {
      const calls: Array<{ file: string; args: readonly string[]; options: { timeout: number } }> =
        [];
      const version = await findPiVersion(async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: "0.45.3\n", stderr: "" };
      });

      expect(version).toBe("0.45.3");
      expect(calls).toEqual([{ file: "pi", args: ["--version"], options: { timeout: 5000 } }]);
    });

    it("findPiVersion_withFailingExecFile_shouldReturnNull", async () => {
      const version = await findPiVersion(async () => {
        throw Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
      });
      expect(version).toBeNull();
    });

    it("findPiVersion_withSyncThrowingImpl_shouldReturnNull", async () => {
      const boom = (() => {
        throw new Error("port exploded synchronously");
      }) as unknown as ExecFileImpl;
      expect(await findPiVersion(boom)).toBeNull();
    });

    it("findPiVersion_withVersionlessOutput_shouldReturnNull", async () => {
      const version = await findPiVersion(async () => ({
        stdout: "pi: command not found\n",
        stderr: "",
      }));
      expect(version).toBeNull();
    });
  });
});
