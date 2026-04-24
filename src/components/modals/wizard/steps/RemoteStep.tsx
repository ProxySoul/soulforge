import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { REMOTE_ITEMS } from "../data.js";
import { FeatureList } from "../primitives.js";

export const RemoteStep = memo(function RemoteStep() {
  return (
    <FeatureList
      heading="MCP, Skills & Remote"
      headerIcon={icon("plug")}
      intro="Plug external tools, load community skills, and drive Forge from your phone."
      items={REMOTE_ITEMS.map((x) => ({ ...x, ic: icon(x.ic) }))}
    />
  );
});
