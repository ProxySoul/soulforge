export interface FileClaim {
  tabId: string;
  tabLabel: string;
  claimedAt: number;
  lastEditAt: number;
  editCount: number;
}

export interface ClaimResult {
  granted: string[];
  contested: Array<{
    path: string;
    owner: FileClaim;
  }>;
}

export interface ConflictInfo {
  path: string;
  ownerTabId: string;
  ownerTabLabel: string;
  ownedSince: number;
  editCount: number;
  lastEditAt: number;
}

export type CoordinatorEvent = "claim" | "release" | "conflict";

export type CoordinatorListener = (event: CoordinatorEvent, tabId: string, paths: string[]) => void;
