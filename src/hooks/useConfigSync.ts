import { useEffect, useRef } from "react";
import type { ContextManager } from "../core/context/manager.js";
import { setSyncEditorOnEdit } from "../core/editor/instance.js";
import { applyTheme } from "../core/theme/index.js";
import { useUIStore } from "../stores/ui.js";
import type { AppConfig } from "../types/index.js";

interface ConfigSyncParams {
  effectiveConfig: AppConfig;
  contextManager: ContextManager;
  cwd: string;
  editorOpen: boolean;
  editorFile: string | null;
  nvimMode: string;
  cursorLine: number;
  cursorCol: number;
  visualSelection: string | null;
}

export function useConfigSync({
  effectiveConfig,
  contextManager,
  cwd,
  editorOpen,
  editorFile,
  nvimMode,
  cursorLine,
  cursorCol,
  visualSelection,
}: ConfigSyncParams): void {
  useEffect(() => {
    contextManager.setEditorState(
      editorOpen,
      editorFile,
      nvimMode,
      cursorLine,
      cursorCol,
      visualSelection,
    );
  }, [editorOpen, editorFile, nvimMode, cursorLine, cursorCol, visualSelection, contextManager]);

  useEffect(() => {
    if (effectiveConfig.editorIntegration) {
      contextManager.setEditorIntegration(effectiveConfig.editorIntegration);
      setSyncEditorOnEdit(effectiveConfig.editorIntegration.syncEditorOnEdit !== false);
    }
  }, [effectiveConfig.editorIntegration, contextManager]);

  // repoMap config is deprecated — always enabled (SOULFORGE_NO_REPOMAP=1 env var for debug)

  useEffect(() => {
    contextManager.setTaskRouter(effectiveConfig.taskRouter);
  }, [effectiveConfig.taskRouter, contextManager]);

  useEffect(() => {
    import("../core/instructions.js").then(({ loadInstructions, buildInstructionPrompt }) => {
      const loaded = loadInstructions(cwd, effectiveConfig.instructionFiles);
      contextManager.setProjectInstructions(buildInstructionPrompt(loaded));
    });
  }, [effectiveConfig.instructionFiles, cwd, contextManager]);

  useEffect(() => {
    if (effectiveConfig.semanticSummaries !== undefined) {
      contextManager.setSemanticSummaries(effectiveConfig.semanticSummaries);
    }
  }, [effectiveConfig.semanticSummaries, contextManager]);

  useEffect(() => {
    if (effectiveConfig.chatStyle) useUIStore.getState().setChatStyle(effectiveConfig.chatStyle);
  }, [effectiveConfig.chatStyle]);

  useEffect(() => {
    if (effectiveConfig.showReasoning !== undefined)
      useUIStore.getState().setShowReasoning(effectiveConfig.showReasoning);
  }, [effectiveConfig.showReasoning]);

  useEffect(() => {
    if (effectiveConfig.lockIn !== undefined)
      useUIStore.getState().setLockIn(effectiveConfig.lockIn);
  }, [effectiveConfig.lockIn]);

  useEffect(() => {
    if (effectiveConfig.editorSplit !== undefined)
      useUIStore.setState({ editorSplit: effectiveConfig.editorSplit });
  }, [effectiveConfig.editorSplit]);

  const themeName = effectiveConfig.theme?.name;
  const themeTransparent = effectiveConfig.theme?.transparent;
  const themeUserMsgOpacity = effectiveConfig.theme?.userMessageOpacity;
  const themeDiffOpacity = effectiveConfig.theme?.diffOpacity;
  const themeBorderStrength = effectiveConfig.theme?.borderStrength;
  const prevTheme = useRef(themeName);
  const prevTransparent = useRef(themeTransparent);
  const prevUserMsgOpacity = useRef(themeUserMsgOpacity);
  const prevDiffOpacity = useRef(themeDiffOpacity);
  const prevBorderStrength = useRef(themeBorderStrength);
  useEffect(() => {
    if (
      themeName &&
      (themeName !== prevTheme.current ||
        themeTransparent !== prevTransparent.current ||
        themeUserMsgOpacity !== prevUserMsgOpacity.current ||
        themeDiffOpacity !== prevDiffOpacity.current ||
        themeBorderStrength !== prevBorderStrength.current)
    ) {
      prevTheme.current = themeName;
      prevTransparent.current = themeTransparent;
      prevUserMsgOpacity.current = themeUserMsgOpacity;
      prevDiffOpacity.current = themeDiffOpacity;
      prevBorderStrength.current = themeBorderStrength;
      applyTheme(themeName, themeTransparent, {
        userMessageOpacity: themeUserMsgOpacity,
        diffOpacity: themeDiffOpacity,
        borderStrength: themeBorderStrength,
      });
    }
  }, [themeName, themeTransparent, themeUserMsgOpacity, themeDiffOpacity, themeBorderStrength]);
}
