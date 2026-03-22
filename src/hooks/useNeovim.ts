import { useCallback, useEffect, useRef, useState } from "react";
import { setNvimInstance } from "../core/editor/instance.js";
import { getEditorDimensions } from "../core/editor/layout.js";
import {
  getBufferName,
  getCursorPosition,
  getVisualSelection,
  launchNeovim,
  type NvimInstance,
  openFile as nvimOpenFile,
  shutdownNeovim,
} from "../core/editor/neovim.js";
import type { ScreenSegment } from "../core/editor/screen.js";
import { onFileEdited } from "../core/tools/file-events.js";
import type { NvimConfigMode } from "../types/index.js";

/** Combined screen state — single setState call instead of 3. */
interface ScreenState {
  lines: ScreenSegment[][];
  defaultBg: string | undefined;
  modeName: string;
}

export interface UseNeovimReturn {
  ready: boolean;
  screenLines: ScreenSegment[][];
  defaultBg: string | undefined;
  modeName: string;
  fileName: string | null;
  cursorLine: number;
  cursorCol: number;
  visualSelection: string | null;
  clearSelection: () => void;
  openFile: (path: string) => Promise<void>;
  sendKeys: (keys: string) => Promise<void>;
  sendMouse: (button: string, action: string, row: number, col: number) => Promise<void>;
  error: string | null;
}

/** Throttle interval — 60fps cap for smooth scrolling. */
const THROTTLE_MS = 16;

export function useNeovim(
  active: boolean,
  nvimPath?: string,
  nvimConfig?: NvimConfigMode,
  onExit?: () => void,
  showHints = true,
  hasTabBar = true,
  splitPct = 60,
): UseNeovimReturn {
  const nvimRef = useRef<NvimInstance | null>(null);
  const mountedRef = useRef(true);
  const launchingRef = useRef(false);
  const closeHandlerRef = useRef<(() => void) | null>(null);

  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<ScreenState>({
    lines: [],
    defaultBg: "#1a1a2e",
    modeName: "normal",
  });
  const [fileName, setFileName] = useState<string | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(0);
  const [visualSelection, setVisualSelection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launchGeneration, setLaunchGeneration] = useState(0);

  // Stable ref for onExit so it doesn't re-trigger the launch effect
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // Throttle refs — flush pending screen state at most every THROTTLE_MS
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef(0);

  // Launch neovim on first active=true
  useEffect(() => {
    if (!active || nvimRef.current || launchingRef.current) return;

    launchingRef.current = true;

    if (!nvimPath) {
      setError("neovim-not-found");
      launchingRef.current = false;
      return;
    }

    const termCols = process.stdout.columns ?? 120;
    const termRows = process.stdout.rows ?? 40;
    const dims = getEditorDimensions(termCols, termRows, showHints, hasTabBar, splitPct);

    launchNeovim(nvimPath ?? "nvim", dims.cols, dims.rows, nvimConfig)
      .then((nvim) => {
        if (!mountedRef.current) {
          shutdownNeovim(nvim).catch(() => {});
          return;
        }
        nvimRef.current = nvim;
        setNvimInstance(nvim);

        const flushScreen = () => {
          if (!mountedRef.current) return;
          const { screen: s } = nvim;
          const lines = s.getSegmentedLines();
          setScreen({
            lines,
            defaultBg: s.getDefaultBg(),
            modeName: s.modeName,
          });
          lastFlushRef.current = Date.now();
          pendingRef.current = false;
        };

        // Event-driven screen updates with throttle
        nvim.screen.onFlush = () => {
          if (!mountedRef.current) return;
          const { screen: s } = nvim;
          if (!s.dirty) return;
          s.dirty = false;

          const now = Date.now();
          const elapsed = now - lastFlushRef.current;

          if (elapsed >= THROTTLE_MS) {
            // Enough time passed — flush immediately
            if (timerRef.current) {
              clearTimeout(timerRef.current);
              timerRef.current = null;
            }
            flushScreen();
          } else if (!pendingRef.current) {
            // Schedule a flush for the remaining time
            pendingRef.current = true;
            timerRef.current = setTimeout(flushScreen, THROTTLE_MS - elapsed);
          }
        };

        // Flush any initial events that arrived before onFlush was set
        if (nvim.screen.dirty) {
          nvim.screen.dirty = false;
          flushScreen();
        }

        setReady(true);
        setError(null);

        // Detect when neovim exits (user runs :q, :qa, etc.)
        // Always null the global instance — even after unmount — to prevent
        // readBufferContent from calling RPC on a dead process (hangs forever).
        const handleClose = () => {
          nvimRef.current = null;
          setNvimInstance(null);
          if (!mountedRef.current) return;
          setReady(false);
          setLaunchGeneration((g) => g + 1);
          onExitRef.current?.();
        };
        closeHandlerRef.current = handleClose;
        nvim.process.on("close", handleClose);
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        launchingRef.current = false;
      });
    // biome-ignore lint/correctness/useExhaustiveDependencies: launchGeneration is intentional — triggers re-launch after close
  }, [active, nvimPath, nvimConfig, showHints, hasTabBar, splitPct, launchGeneration]);

  // Resize neovim when terminal dimensions change
  useEffect(() => {
    if (!ready || !active) return;

    const onResize = () => {
      const nvim = nvimRef.current;
      if (!nvim || !mountedRef.current) return;
      const tc = process.stdout.columns ?? 120;
      const tr = process.stdout.rows ?? 40;
      const d = getEditorDimensions(tc, tr, showHints, hasTabBar, splitPct);
      nvim.api.request("nvim_ui_try_resize", [d.cols, d.rows]).catch(() => {});
    };

    onResize();
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.removeListener("resize", onResize);
    };
  }, [ready, active, showHints, hasTabBar, splitPct]);

  // Poll buffer name, cursor position, and visual selection when ready
  useEffect(() => {
    if (!ready || !active) return;

    const poll = () => {
      const nvim = nvimRef.current;
      if (!nvim || !mountedRef.current) return;

      Promise.all([getBufferName(nvim), getCursorPosition(nvim), getVisualSelection(nvim)])
        .then(([name, cursor, selection]) => {
          if (!mountedRef.current) return;
          if (name) setFileName((prev) => (prev === name ? prev : name));
          setCursorLine((prev) => (prev === cursor.line ? prev : cursor.line));
          setCursorCol((prev) => (prev === cursor.col ? prev : cursor.col));
          setVisualSelection((prev) => {
            if (selection) return selection;
            return prev;
          });
        })
        .catch(() => {});
    };

    poll();
    const interval = setInterval(poll, 500);
    return () => clearInterval(interval);
  }, [ready, active]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const nvim = nvimRef.current;
      if (nvim) {
        if (closeHandlerRef.current) {
          nvim.process.removeListener("close", closeHandlerRef.current);
          closeHandlerRef.current = null;
        }
        nvim.screen.onFlush = null;
        setNvimInstance(null);
        shutdownNeovim(nvim).catch(() => {});
        nvimRef.current = null;
      }
    };
  }, []);

  // Auto-reload buffers when AI edits files
  useEffect(() => {
    if (!ready || !active) return;
    return onFileEdited(() => {
      const nvim = nvimRef.current;
      if (nvim) nvim.api.command("checktime").catch(() => {});
    });
  }, [ready, active]);

  const openFile = useCallback(async (path: string) => {
    const nvim = nvimRef.current;
    if (!nvim || !mountedRef.current) return;
    try {
      await nvimOpenFile(nvim, path);
      if (mountedRef.current) {
        setFileName(path);
      }
    } catch (err: unknown) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const sendKeys = useCallback(async (keys: string) => {
    const nvim = nvimRef.current;
    if (!nvim || !mountedRef.current) return;
    try {
      await nvim.api.input(keys);
    } catch {}
  }, []);

  const clearSelection = useCallback(() => {
    setVisualSelection(null);
  }, []);

  const sendMouse = useCallback(
    async (button: string, action: string, row: number, col: number) => {
      const nvim = nvimRef.current;
      if (!nvim || !mountedRef.current) return;
      try {
        await nvim.api.request("nvim_input_mouse", [button, action, "", 0, row, col]);
      } catch {}
    },
    [],
  );

  return {
    ready,
    screenLines: screen.lines,
    defaultBg: screen.defaultBg,
    modeName: screen.modeName,
    fileName,
    cursorLine,
    cursorCol,
    visualSelection,
    clearSelection,
    openFile,
    sendKeys,
    sendMouse,
    error,
  };
}
