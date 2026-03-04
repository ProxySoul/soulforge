import { Box, Text } from "ink";
import { useEffect, useState } from "react";

const GHOST = "󰊠";
const WISP = ["~∿~", "∿~∿", "·∿·", "∿·∿"];
const SPEED = 120;

export function GhostLogo() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, SPEED);
    return () => clearInterval(timer);
  }, []);

  const wispFrame = WISP[tick % WISP.length] ?? WISP[0];

  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="#9B30FF" bold>
        {GHOST}
      </Text>
      <Text color="#4a1a6b" dimColor>
        {wispFrame}
      </Text>
    </Box>
  );
}
