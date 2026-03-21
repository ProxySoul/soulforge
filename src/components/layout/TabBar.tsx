import { TextAttributes } from "@opentui/core";
import { useEffect, useState } from "react";
import { icon } from "../../core/icons.js";
import type { Tab, TabActivity } from "../../hooks/useTabs.js";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onSwitch: (id: string) => void;
  getActivity: (id: string) => TabActivity;
}

function truncateLabel(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function TabBar({ tabs, activeTabId, onSwitch: _onSwitch, getActivity }: TabBarProps) {
  const [spinFrame, setSpinFrame] = useState(0);

  const activities = new Map(tabs.map((t) => [t.id, getActivity(t.id)]));
  const hasLoading = tabs.some((t) => activities.get(t.id)?.isLoading);

  useEffect(() => {
    if (!hasLoading) return;
    const timer = setInterval(() => setSpinFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [hasLoading]);

  return (
    <box flexShrink={0} paddingX={1} height={1} flexDirection="row">
      <text fg="#444">{icon("tabs")} </text>
      <text fg="#555" attributes={TextAttributes.BOLD}>
        TABS{" "}
      </text>
      <text fg="#333">→ </text>
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeTabId;
        const num = String(i + 1);
        const activity = activities.get(tab.id);
        const isDefault = /^Tab \d+$/.test(tab.label);
        const label = isDefault ? " New tab" : ` ${truncateLabel(tab.label, 20)}`;

        const isLoading = activity?.isLoading ?? false;
        const hasError = activity?.hasError ?? false;
        const hasUnread = activity?.hasUnread ?? false;
        const needsAttention = activity?.needsAttention ?? false;

        // bracket color: attention=orange, loading=purple pulse, error=red, active=red, default=dim
        const bracketColor = needsAttention
          ? "#F59E0B"
          : isLoading
            ? "#8B5CF6"
            : hasError
              ? "#a55"
              : isActive
                ? "#FF0040"
                : "#444";

        const numColor = isActive
          ? "#FF0040"
          : needsAttention
            ? "#F59E0B"
            : isLoading
              ? "#8B5CF6"
              : "#666";
        const labelColor = isActive ? "#ccc" : hasUnread ? "#b87333" : "#555";

        return (
          <box key={tab.id} flexDirection="row">
            {i > 0 && <text fg="#2a2a2a"> │ </text>}
            {needsAttention && !isActive && <text fg="#F59E0B">? </text>}
            {isLoading && !needsAttention && (
              <text fg="#8B5CF6">{SPINNER_FRAMES[spinFrame] ?? "⠋"} </text>
            )}
            <text fg={bracketColor}>[</text>
            <text fg={numColor} attributes={isActive ? TextAttributes.BOLD : undefined}>
              {num}
            </text>
            <text fg={bracketColor}>]</text>
            {label && (
              <text fg={labelColor} attributes={isActive ? TextAttributes.BOLD : undefined}>
                {label}
              </text>
            )}
            {(activity?.editedFileCount ?? 0) > 0 && (
              <text fg="#4a7">
                {" "}
                {icon("lock")}
                {String(activity?.editedFileCount ?? 0)}
              </text>
            )}
            {hasUnread && !isLoading && !needsAttention && <text fg="#b87333"> ●</text>}
            {hasError && !isLoading && !needsAttention && <text fg="#a55"> ✗</text>}
          </box>
        );
      })}
    </box>
  );
}
