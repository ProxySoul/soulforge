import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { EDITING_ITEMS } from "../data.js";
import { FeatureList } from "../primitives.js";

export const EditingStep = memo(function EditingStep() {
  return (
    <FeatureList
      heading="Editing — by symbol, not by string"
      headerIcon={icon("morph")}
      intro="Forge picks the right tool per file: AST surgery for TS/JS, LSP for renames, line-anchored edits everywhere else."
      items={EDITING_ITEMS.map((x) => ({ ...x, ic: icon(x.ic) }))}
    />
  );
});
