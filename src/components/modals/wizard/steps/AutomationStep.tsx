import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { AUTOMATION_ITEMS } from "../data.js";
import { FeatureList } from "../primitives.js";

export const AutomationStep = memo(function AutomationStep() {
  return (
    <FeatureList
      heading="Automation — scale without friction"
      headerIcon={icon("dispatch")}
      intro="Parallel agents share a cache, the router picks a model per slot, compaction reclaims context for free."
      items={AUTOMATION_ITEMS.map((x) => ({ ...x, ic: icon(x.ic) }))}
    />
  );
});
