import { useCallback, useEffect, useRef, useState } from "react";
import { setNvimInstance } from "../core/editor/instance.js";
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
  openFile: (path: string) => Promise<void>;
  sendKeys: (keys: string) => Promise<void>;
  sendMouse: (button: string, action: string, row: number, col: number) => Promise<void>;
  error: string | null;
}

/** Throttle interval — 30fps cap. Fast enough to feel live, prevents flooding React. */
const THROTTLE_MS = 33;

export function useNeovim(
  active: boolean,
  nvimPath?: string,
  nvimConfig?: NvimConfigMode,
  onExit?: () => void,
  showHints = true,
): UseNeovimReturn {
  const nvimRef = useRef<NvimInstance | null>(null);
  const mountedRef = useRef(true);
  const launchingRef = useRef(false);

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

    // Compute dimensions to match the actual editor panel:
    // Horizontal: 60% width minus border (2 chars for left + right)
    // Vertical fixed rows: app header(1) + app footer(1) + border top(1) + border bottom(1)
    //   + title(1) + sep(1) + sep(1) + status bar(1) + hints(0 or 2) = 8 or 10
    const termCols = process.stdout.columns ?? 120;
    const termRows = process.stdout.rows ?? 40;
    const panelCols = Math.max(20, Math.floor(termCols * 0.6) - 2);
    const fixedRows = showHints ? 10 : 8;
    const panelRows = Math.max(6, termRows - fixedRows);

    launchNeovim(nvimPath ?? "nvim", panelCols, panelRows, nvimConfig)
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
        nvim.process.on("close", () => {
          if (!mountedRef.current) return;
          nvimRef.current = null;
          setNvimInstance(null);
          setReady(false);
          onExitRef.current?.();
        });
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        launchingRef.current = false;
      });
  }, [active, nvimPath, nvimConfig, showHints]);

  // Resize neovim when terminal dimensions change
  useEffect(() => {
    if (!ready || !active) return;

    const onResize = () => {
      const nvim = nvimRef.current;
      if (!nvim || !mountedRef.current) return;
      const termCols = process.stdout.columns ?? 120;
      const termRows = process.stdout.rows ?? 40;
      const cols = Math.max(20, Math.floor(termCols * 0.6) - 2);
      const fixed = showHints ? 10 : 8;
      const rows = Math.max(6, termRows - fixed);
      nvim.api.request("nvim_ui_try_resize", [cols, rows]).catch(() => {});
    };

    onResize();
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.removeListener("resize", onResize);
    };
  }, [ready, active, showHints]);

  // Poll buffer name, cursor position, and visual selection (~2s) when ready
  useEffect(() => {
    if (!ready || !active) return;

    const interval = setInterval(() => {
      const nvim = nvimRef.current;
      if (!nvim || !mountedRef.current) return;

      Promise.all([getBufferName(nvim), getCursorPosition(nvim), getVisualSelection(nvim)])
        .then(([name, cursor, selection]) => {
          if (!mountedRef.current) return;
          if (name) setFileName((prev) => (prev === name ? prev : name));
          setCursorLine((prev) => (prev === cursor.line ? prev : cursor.line));
          setCursorCol((prev) => (prev === cursor.col ? prev : cursor.col));
          setVisualSelection((prev) => (prev === selection ? prev : selection));
        })
        .catch(() => {});
    }, 2000);

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
        nvim.screen.onFlush = null;
        setNvimInstance(null);
        shutdownNeovim(nvim).catch(() => {});
        nvimRef.current = null;
      }
    };
  }, []);

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
    openFile,
    sendKeys,
    sendMouse,
    error,
  };
}
