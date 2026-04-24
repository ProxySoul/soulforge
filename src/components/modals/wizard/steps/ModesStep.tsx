import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { MODE_ITEMS } from "../data.js";
import { FeatureList } from "../primitives.js";

export const ModesStep = memo(function ModesStep() {
  return (
    <FeatureList
      heading="Modes — how Forge approaches work"
      headerIcon={icon("plan")}
      intro="Cycle with Ctrl+D. Default is auto — one-shot execution. Plan is research-only. UltraReview runs a second audit."
      items={MODE_ITEMS.map((x) => ({ ...x, ic: icon(x.ic) }))}
    />
  );
});
