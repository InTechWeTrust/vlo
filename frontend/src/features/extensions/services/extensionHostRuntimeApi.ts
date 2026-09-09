import * as pixi from "pixi.js";
import * as react from "react";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import * as panelUi from "../../panelUI";
import { ExtensionGenerationInputsDraft } from "../generation/ExtensionGenerationInputsDraft";
import type { ExtensionHostRuntimeApi } from "../types";

/**
 * Trusted extensions receive the application's exact singleton modules. This
 * avoids duplicate React dispatchers and Pixi class identities while leaving
 * the full module namespaces available to version-coupled extension code.
 */
export const extensionHostRuntimeApi: ExtensionHostRuntimeApi = Object.freeze({
  pixi: pixi as unknown as ExtensionHostRuntimeApi["pixi"],
  react: react as unknown as ExtensionHostRuntimeApi["react"],
  mui: Object.freeze({
    Alert,
    AlertTitle,
    Box,
    Button,
    Checkbox,
    Chip,
    FormControl,
    FormControlLabel,
    IconButton,
    InputLabel,
    MenuItem,
    Select,
    Slider,
    Switch,
    TextField,
    Tooltip,
    Typography,
    useTheme,
  }),
  /**
   * The complete host panelUI barrel is an intentionally version-coupled
   * trusted escape hatch. Extensions should prefer owner-bound APIs such as
   * `ui.registerPanelControl()` when they want validation and activation
   * rollback, but trusted mode does not make that contract an authority ceiling.
   */
  panelUi: panelUi as unknown as ExtensionHostRuntimeApi["panelUi"],
  /**
   * Narrow and typed, unlike `panelUi`: these are generation-owned surfaces
   * with a declared contract, so a package gets a checked component rather
   * than an entry in an open map it has to assert its way through.
   */
  generationUi: Object.freeze({
    InputsDraft:
      ExtensionGenerationInputsDraft as unknown as ExtensionHostRuntimeApi["generationUi"]["InputsDraft"],
  }),
});
