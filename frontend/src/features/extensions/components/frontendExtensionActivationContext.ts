import { createContext, useContext } from "react";

export type FrontendExtensionActivationStatus = "pending" | "settled";

export const FrontendExtensionActivationContext =
  createContext<FrontendExtensionActivationStatus>("settled");

export function useFrontendExtensionActivationStatus(): FrontendExtensionActivationStatus {
  return useContext(FrontendExtensionActivationContext);
}
