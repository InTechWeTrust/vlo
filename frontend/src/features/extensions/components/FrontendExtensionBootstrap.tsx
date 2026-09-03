import { useEffect, useState, type ReactNode } from "react";
import {
  frontendExtensionRuntime,
  type FrontendExtensionStartSummary,
} from "../services/FrontendExtensionRuntime";
import { useCommandKeybindings } from "../commands/useCommandKeybindings";
import { FrontendExtensionActivationContext } from "./frontendExtensionActivationContext";

interface FrontendExtensionRuntimeStarter {
  start(): Promise<FrontendExtensionStartSummary>;
}

interface FrontendExtensionBootstrapProps {
  children: ReactNode;
  runtime?: FrontendExtensionRuntimeStarter;
}

export function FrontendExtensionBootstrap({
  children,
  runtime = frontendExtensionRuntime,
}: FrontendExtensionBootstrapProps) {
  useCommandKeybindings();
  const [activationStatus, setActivationStatus] = useState<
    "pending" | "settled"
  >("pending");

  useEffect(() => {
    let mounted = true;
    void runtime
      .start()
      .then((summary) => {
        if (!mounted) return;
        if (!summary.inventoryLoaded) {
          console.error(
            "[Extensions] Frontend inventory could not be loaded; no extensions were activated.",
            summary.inventoryError,
          );
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          console.error(
            "[Extensions] Unexpected frontend bootstrap failure; continuing without extensions.",
            error,
          );
        }
      })
      .finally(() => {
        if (mounted) setActivationStatus("settled");
      });

    return () => {
      mounted = false;
    };
  }, [runtime]);

  return (
    <FrontendExtensionActivationContext.Provider value={activationStatus}>
      {children}
    </FrontendExtensionActivationContext.Provider>
  );
}
