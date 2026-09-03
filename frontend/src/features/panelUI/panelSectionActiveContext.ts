import { createContext, useContext } from "react";

export const PanelSectionActiveContext = createContext(true);

export function usePanelSectionActive(): boolean {
  return useContext(PanelSectionActiveContext);
}
