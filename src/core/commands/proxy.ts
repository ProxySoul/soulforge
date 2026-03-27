import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import type { TaskRouter } from "../../types/index.js";
import { icon } from "../icons.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

async function cleanupProxySelections(ctx: CommandContext): Promise<void> {
  if (ctx.chat.activeModel.startsWith("proxy/")) {
    ctx.chat.setActiveModel("none");
    ctx.saveToScope({ defaultModel: "none" }, ctx.detectScope("defaultModel"));
    const { notifyProviderSwitch } = await import("../llm/provider.js");
    await notifyProviderSwitch("none");
  }

  const { loadConfig, loadProjectConfig } = await import("../../config/index.js");
  const global = loadConfig();
  const project = loadProjectConfig(ctx.cwd);
  const router = (project?.taskRouter ?? global.taskRouter) as TaskRouter | undefined;
  if (!router) return;

  const nulled: Record<string, null> = {};
  let dirty = false;
  for (const [key, val] of Object.entries(router)) {
    if (typeof val === "string" && val.startsWith("proxy/")) {
      nulled[key] = null;
      dirty = true;
    }
  }
  if (dirty) {
    ctx.saveToScope({ taskRouter: { ...router, ...nulled } }, ctx.detectScope("taskRouter"));
  }
}

async function handleProxyStatus(_input: string, ctx: CommandContext): Promise<void> {
  const { fetchProxyStatus, listProxyAccounts } = await import("../proxy/lifecycle.js");

  const buildLines = (s: Awaited<ReturnType<typeof fetchProxyStatus>>): InfoPopupLine[] => {
    const lines: InfoPopupLine[] = [
      {
        type: "entry",
        label: "Status",
        desc: s.running ? "● running" : "○ stopped",
        descColor: s.running ? "#2d5" : "#FF0040",
      },
      { type: "entry", label: "Endpoint", desc: s.endpoint, descColor: "#888" },
      {
        type: "entry",
        label: "Binary",
        desc: s.binaryPath ?? "not installed",
        descColor: s.installed ? "#888" : "#FF0040",
      },
    ];
    if (s.pid) lines.push({ type: "entry", label: "PID", desc: String(s.pid), descColor: "#888" });

    if (s.version) {
      lines.push({ type: "spacer" }, { type: "separator" }, { type: "spacer" });
      lines.push({ type: "header", label: "Version" });
      lines.push({
        type: "entry",
        label: "Installed",
        desc: `v${s.version.installed}`,
        descColor: "#888",
      });
      if (s.version.latest) {
        lines.push({
          type: "entry",
          label: "Latest",
          desc: `v${s.version.latest}`,
          descColor: s.version.updateAvailable ? "#FFD700" : "#2d5",
        });
      }
      if (s.version.updateAvailable) {
        lines.push({
          type: "text",
          label: "  Run /proxy upgrade to update",
          color: "#FFD700",
        });
      }
    }

    const accounts = listProxyAccounts();
    if (accounts.length > 0) {
      lines.push({ type: "spacer" }, { type: "separator" }, { type: "spacer" });
      lines.push({ type: "header", label: `Accounts (${accounts.length})` });
      for (const a of accounts) {
        lines.push({ type: "entry", label: a.provider, desc: a.label, descColor: "#888" });
      }
    }

    if (s.models.length > 0) {
      lines.push({ type: "spacer" }, { type: "separator" }, { type: "spacer" });
      lines.push({ type: "header", label: `Models (${s.models.length})` });
      for (const m of s.models) lines.push({ type: "text", label: `  ${m}`, color: "#888" });
    }
    lines.push(
      { type: "spacer" },
      { type: "separator" },
      { type: "spacer" },
      { type: "header", label: "Commands" },
      { type: "entry", label: "/proxy start", desc: "start the proxy" },
      { type: "entry", label: "/proxy stop", desc: "stop the proxy" },
      { type: "entry", label: "/proxy restart", desc: "restart the proxy" },
      { type: "entry", label: "/proxy login", desc: "add a provider account" },
      { type: "entry", label: "/proxy logout", desc: "remove a provider account" },
      { type: "entry", label: "/proxy install", desc: "reinstall CLIProxyAPI" },
      { type: "entry", label: "/proxy upgrade", desc: "upgrade to latest version" },
    );
    return lines;
  };

  ctx.openInfoPopup({
    title: "Proxy Status",
    icon: icon("proxy"),
    lines: [{ type: "text", label: "Loading...", color: "#888" }],
  });

  let pollActive = true;
  const poll = async () => {
    while (pollActive) {
      const status = await fetchProxyStatus();
      if (!pollActive) break;
      ctx.openInfoPopup({
        title: "Proxy Status",
        icon: icon("proxy"),
        lines: buildLines(status),
        onClose: () => {
          pollActive = false;
        },
      });
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  poll();
}

async function handleProxyLogin(_input: string, ctx: CommandContext): Promise<void> {
  const { PROXY_PROVIDERS, runProxyLogin } = await import("../proxy/lifecycle.js");

  ctx.openCommandPicker({
    title: "Proxy Login — Select Provider",
    icon: icon("proxy"),
    options: PROXY_PROVIDERS.map((p) => ({ label: p.name, value: p.id })),
    onSelect: (value) => {
      const provider = PROXY_PROVIDERS.find((p) => p.id === value);
      if (!provider) return;

      type Line = InfoPopupLine;
      const loginLines: Line[] = [
        { type: "text", label: `Logging in to ${provider.name}…`, color: "#888" },
      ];

      const updatePopup = (extraLines: Line[], closeCb?: () => void) => {
        ctx.openInfoPopup({
          title: `Proxy Login — ${provider.name}`,
          icon: icon("proxy"),
          lines: extraLines,
          onClose: closeCb,
        });
      };

      let handle: ReturnType<typeof runProxyLogin> | null = null;
      const onClose = () => {
        handle?.abort();
      };
      updatePopup(loginLines, onClose);

      handle = runProxyLogin((line) => {
        loginLines.push({ type: "text", label: line, color: "#ccc" });
        updatePopup([...loginLines], onClose);
      }, provider.flag);

      handle.promise
        .then(({ ok }) => {
          loginLines.push({
            type: "text",
            label: ok ? "Authentication complete." : "Authentication failed.",
            color: ok ? "#2d5" : "#FF0040",
          });
          updatePopup([...loginLines]);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          loginLines.push({ type: "text", label: `Error: ${msg}`, color: "#FF0040" });
          updatePopup([...loginLines]);
        });
    },
  });
}

async function handleProxyLogout(_input: string, ctx: CommandContext): Promise<void> {
  const { listProxyAccounts, removeProxyAccount } = await import("../proxy/lifecycle.js");

  const accounts = listProxyAccounts();
  if (accounts.length === 0) {
    ctx.openInfoPopup({
      title: "Proxy Logout",
      icon: icon("proxy"),
      lines: [{ type: "text", label: "No accounts logged in.", color: "#888" }],
    });
    return;
  }

  ctx.openCommandPicker({
    title: "Proxy Logout — Select Account",
    icon: icon("proxy"),
    options: accounts.map((a) => ({
      label: `${a.provider}  ${a.label}`,
      value: a.file,
    })),
    onSelect: (file) => {
      const account = accounts.find((a) => a.file === file);
      const removed = removeProxyAccount(file);
      const label = account ? `${account.provider} (${account.label})` : file;

      if (removed) {
        const remaining = listProxyAccounts();
        if (remaining.length === 0) {
          cleanupProxySelections(ctx).catch(() => {});
        }
      }

      ctx.openInfoPopup({
        title: "Proxy Logout",
        icon: icon("proxy"),
        lines: [
          {
            type: "text",
            label: removed ? `Removed ${label}` : `Failed to remove ${label}`,
            color: removed ? "#2d5" : "#FF0040",
          },
        ],
      });
    },
  });
}

async function handleProxyInstall(_input: string, ctx: CommandContext): Promise<void> {
  const { installProxy } = await import("../setup/install.js");
  sysMsg(ctx, "Installing CLIProxyAPI...");
  installProxy()
    .then((path: string) => sysMsg(ctx, `CLIProxyAPI installed at ${path}`))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sysMsg(ctx, `Install failed: ${msg}`);
    });
}

async function handleProxyUpgrade(_input: string, ctx: CommandContext): Promise<void> {
  const { upgradeProxy, checkForProxyUpdate } = await import("../proxy/lifecycle.js");
  type Line = InfoPopupLine;

  const vinfo = await checkForProxyUpdate();
  if (!vinfo.updateAvailable) {
    ctx.openInfoPopup({
      title: "Proxy Upgrade",
      icon: icon("proxy"),
      lines: [
        {
          type: "text",
          label: `Already on latest version (v${vinfo.installed})`,
          color: "#2d5",
        },
      ],
    });
    return;
  }

  const upgradeLines: Line[] = [
    {
      type: "entry",
      label: "Upgrade",
      desc: `v${vinfo.installed} → v${vinfo.latest}`,
      descColor: "#FFD700",
    },
    { type: "spacer" },
  ];

  const updatePopup = () => {
    ctx.openInfoPopup({
      title: "Proxy Upgrade",
      icon: icon("proxy"),
      lines: [...upgradeLines],
    });
  };

  updatePopup();

  const result = await upgradeProxy((msg) => {
    upgradeLines.push({ type: "text", label: msg, color: "#ccc" });
    updatePopup();
  });

  upgradeLines.push({
    type: "text",
    label: result.ok ? "Upgrade complete." : `Upgrade failed: ${result.error}`,
    color: result.ok ? "#2d5" : "#FF0040",
  });
  updatePopup();
}

async function handleProxyStart(_input: string, ctx: CommandContext): Promise<void> {
  const { ensureProxy } = await import("../proxy/lifecycle.js");
  sysMsg(ctx, "Starting proxy…");
  const result = await ensureProxy();
  sysMsg(ctx, result.ok ? "Proxy started." : `Failed: ${result.error ?? "unknown"}`);
}

async function handleProxyStop(_input: string, ctx: CommandContext): Promise<void> {
  const { stopProxy } = await import("../proxy/lifecycle.js");
  stopProxy();
  sysMsg(ctx, "Proxy stopped.");
}

async function handleProxyRestart(_input: string, ctx: CommandContext): Promise<void> {
  const { stopProxy, ensureProxy } = await import("../proxy/lifecycle.js");
  sysMsg(ctx, "Restarting proxy…");
  stopProxy();
  await new Promise((r) => setTimeout(r, 500));
  const result = await ensureProxy();
  sysMsg(ctx, result.ok ? "Proxy restarted." : `Failed: ${result.error ?? "unknown"}`);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/proxy", handleProxyStatus);
  map.set("/proxy status", handleProxyStatus);
  map.set("/proxy start", handleProxyStart);
  map.set("/proxy stop", handleProxyStop);
  map.set("/proxy restart", handleProxyRestart);
  map.set("/proxy login", handleProxyLogin);
  map.set("/proxy logout", handleProxyLogout);
  map.set("/proxy install", handleProxyInstall);
  map.set("/proxy upgrade", handleProxyUpgrade);
}
