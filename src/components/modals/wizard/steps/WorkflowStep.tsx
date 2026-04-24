import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { WORKFLOW_ITEMS } from "../data.js";
import { FeatureList } from "../primitives.js";

export const WorkflowStep = memo(function WorkflowStep() {
  return (
    <FeatureList
      heading="Tabs, Sessions & Git"
      headerIcon={icon("tabs")}
      intro="Five tabs, infinite sessions, checkpointed every turn — rewind anything."
      items={WORKFLOW_ITEMS.map((x) => ({ ...x, ic: icon(x.ic) }))}
    />
  );
});
