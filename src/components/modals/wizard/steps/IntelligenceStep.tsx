import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { INTELLIGENCE_ITEMS } from "../data.js";
import { FeatureList } from "../primitives.js";

export const IntelligenceStep = memo(function IntelligenceStep() {
  return (
    <FeatureList
      heading="Codebase Intelligence"
      headerIcon={icon("brain")}
      intro="Forge reads your repo as a graph — symbols, imports, call sites — not a pile of text."
      items={INTELLIGENCE_ITEMS.map((x) => ({ ...x, ic: icon(x.ic) }))}
    />
  );
});
