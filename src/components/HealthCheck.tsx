import { Box, Text } from "ink";
import { providerIcon } from "../core/icons.js";
import { checkProviders } from "../core/llm/provider.js";
import { checkPrerequisites } from "../core/setup/prerequisites.js";

function Status({ ok, label, dim }: { ok: boolean; label: string; dim?: boolean }) {
  return (
    <Text color={ok ? "#2d5" : dim ? "#FF8C00" : "#f44"}>
      {ok ? "✓" : dim ? "○" : "✗"} {label}
    </Text>
  );
}

export function HealthCheck() {
  const provs = checkProviders();
  const prereqs = checkPrerequisites();
  const anyMissing =
    prereqs.some((p) => !p.installed && p.prerequisite.required) ||
    provs.every((p) => !p.available);

  return (
    <Box flexDirection="column" gap={0}>
      {/* Providers */}
      <Box gap={1} justifyContent="center" flexWrap="wrap">
        <Text color="#555">providers</Text>
        {provs.map((p) => (
          <Text key={p.id} color={p.available ? "#2d5" : "#555"}>
            {p.available ? "✓" : "✗"} {providerIcon(p.id)}{" "}
            <Text color={p.available ? "#2d5" : "#444"}>{p.name}</Text>
          </Text>
        ))}
      </Box>
      {/* Tools */}
      <Box gap={1} justifyContent="center" flexWrap="wrap">
        <Text color="#555">{"   tools"}</Text>
        {prereqs.map((t) => (
          <Status
            key={t.prerequisite.name}
            ok={t.installed}
            label={t.prerequisite.name}
            dim={!t.prerequisite.required}
          />
        ))}
      </Box>
      {/* Hint */}
      {anyMissing && (
        <Box justifyContent="center" marginTop={1}>
          <Text color="#444">/setup to install missing</Text>
        </Box>
      )}
    </Box>
  );
}
